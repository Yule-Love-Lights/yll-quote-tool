/**
 * Bulk-ingest a folder of placement photos for one crew member and one
 * campaign, through the REAL pipeline.
 *
 *   npx tsx scripts/ingest-advertising-photos.ts \
 *     --dir "C:/path/to/folder" --worker "Tiago" --campaign "Fall yard signs"
 *
 * Naldo's ask (2026-09-01): he hands over a Google Drive folder link, a crew
 * member and a campaign, the photos get pulled down and pushed through the
 * pipeline, and the dollar total is counted back to him before the full run.
 * The Drive half happens outside this script (the folder is downloaded to a
 * local directory first); this is the half that touches money.
 *
 * IT IS A DRY RUN UNLESS YOU PASS --live. The dry run reads the folder, reads
 * each photo's EXIF, downscales exactly as the browser would, computes the
 * same hash the server would store, asks the database which photos are
 * already paid for, and prints the plan and the dollar total. It writes
 * nothing at all.
 *
 * Flags:
 *   --dir <path>         folder of photos (required)
 *   --worker <id|name>   the crew member being paid (required)
 *   --campaign <id|name> the campaign (required)
 *   --limit <n>          only the first n files, by name
 *   --env <path>         .env.local to read (default: ./.env.local)
 *   --live               actually create the rows and pay
 *
 * Re-running is safe by design: the pipeline skips a photo whose exact bytes
 * are already an accepted, unvoided row for this worker and campaign, so a
 * partial batch is resumed by running the same command again.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import sharp from 'sharp';

import { dollars, planIngest, resolveByNameOrId, type IngestCandidate } from './advertisingIngestPlan';

// Match the browser's upload rules exactly (src/lib/clientImage.ts), so a
// photo ingested here is the same artefact a phone would have produced.
const MAX_EDGE_PX = 2560;
const SKIP_BELOW_BYTES = 2.5 * 1024 * 1024;
const JPEG_QUALITY = 85;
// The server's own hard cap (intakeProofPhoto). A file still over this after
// downscaling is reported as a problem in the plan instead of failing the run
// halfway through.
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadEnv(path: string): void {
  try {
    const text = readFileSync(resolve(path), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]]) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  } catch {
    // No env file at that path: rely on the ambient environment.
  }
}

type Prepared = {
  candidate: IngestCandidate;
  upload: Buffer<ArrayBufferLike> | null;
  contentType: string;
  uploadName: string;
};

function contentTypeFor(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Read one photo the way the browser does: EXIF off the ORIGINAL (a re-encode
 * strips it), then downscale, then hash what will actually be stored.
 */
async function prepare(path: string, file: string): Promise<Prepared> {
  const original = readFileSync(path);
  const base: IngestCandidate = {
    file,
    bytes: original.byteLength,
    lat: null,
    lng: null,
    takenAt: null,
    photoHash: null,
    duplicateOfPlacementId: null,
    duplicateOfFile: null,
    problem: null,
  };
  let contentType = contentTypeFor(file);
  let uploadName = file;

  const exifr = (await import('exifr')).default;
  try {
    const gps = await exifr.gps(original);
    if (
      gps &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude) &&
      !(gps.latitude === 0 && gps.longitude === 0)
    ) {
      base.lat = gps.latitude;
      base.lng = gps.longitude;
    }
    const meta = (await exifr.parse(original, ['DateTimeOriginal'])) as { DateTimeOriginal?: Date } | undefined;
    if (meta?.DateTimeOriginal instanceof Date && !Number.isNaN(meta.DateTimeOriginal.getTime())) {
      base.takenAt = meta.DateTimeOriginal.toISOString();
    }
  } catch {
    // No EXIF is fine: the photo uploads without a location or a taken date.
  }

  // sharp hands back a Buffer over a possibly-shared ArrayBuffer, which is a
  // different type from readFileSync's, so the variable is widened once here.
  let upload: Buffer<ArrayBufferLike> = original;
  try {
    const meta = await sharp(original).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const skip = original.byteLength < SKIP_BELOW_BYTES && longest <= MAX_EDGE_PX;
    if (!skip) {
      upload = await sharp(original)
        .rotate()
        .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      contentType = 'image/jpeg';
      uploadName = `${file.replace(/\.[^.]+$/, '')}.jpg`;
    }
  } catch {
    return {
      candidate: { ...base, problem: 'could not be read as an image' },
      upload: null,
      contentType,
      uploadName,
    };
  }

  if (upload.byteLength > PHOTO_MAX_BYTES) {
    const mb = (upload.byteLength / 1024 / 1024).toFixed(1);
    return {
      candidate: { ...base, problem: `still ${mb}MB after downscaling (4MB max)` },
      upload: null,
      contentType,
      uploadName,
    };
  }

  const { computePhotoHash } = await import('../src/lib/advertising/photoHashCompute');
  base.photoHash = await computePhotoHash(upload);
  return { candidate: base, upload, contentType, uploadName };
}

async function main(): Promise<void> {
  loadEnv(arg('env') ?? '.env.local');

  const dir = arg('dir');
  const workerQuery = arg('worker') ?? '';
  const campaignQuery = arg('campaign') ?? '';
  const limitRaw = arg('limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const live = hasFlag('live');
  if (!dir) throw new Error('--dir is required');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a whole number, 1 or more');
  }

  const { getSupabaseServiceClient } = await import('../src/lib/supabase');
  const { listAdvertisingCampaigns } = await import('../src/lib/advertising/campaigns');
  const { listAdvertisingWorkers } = await import('../src/lib/advertising/workers');
  const { findAcceptedByPhotoHash } = await import('../src/lib/advertising/placements');

  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured. Point --env at a .env.local that has it.');

  const workers = (await listAdvertisingWorkers({ includeInactive: true })).map((w) => ({
    ...w,
    name: w.displayName,
  }));
  const campaigns = await listAdvertisingCampaigns({ includeInactive: true });

  const w = resolveByNameOrId(workers, workerQuery, 'crew member');
  if (!w.ok) throw new Error(w.reason);
  const c = resolveByNameOrId(campaigns, campaignQuery, 'campaign');
  if (!c.ok) throw new Error(c.reason);
  if (!c.row.active) {
    throw new Error(`"${c.row.name}" is closed, and the pipeline refuses submissions to a closed campaign.`);
  }

  const flags = `${w.row.active ? '' : '  [inactive]'}${w.row.isTest ? '  [test]' : ''}`;
  console.log(`crew member : ${w.row.displayName} (${w.row.id})${flags}`);
  console.log(
    `campaign    : ${c.row.name} (${c.row.id})  ${c.row.kind}  ${dollars(c.row.rateCents)} per accepted photo`,
  );
  console.log(`folder      : ${resolve(dir)}`);
  console.log(`mode        : ${live ? 'LIVE, this creates paid rows' : 'DRY RUN, nothing is written'}`);
  console.log('');

  const files = readdirSync(dir)
    .filter((f) => PHOTO_EXTS.has(extname(f).toLowerCase()))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
  const chosen = limit ? files.slice(0, limit) : files;
  const tail = limit ? `, taking the first ${chosen.length}` : '';
  console.log(`${files.length} photo${files.length === 1 ? '' : 's'} in the folder${tail}`);

  const prepared: Prepared[] = [];
  // Two copies of one photo inside the same folder are a duplicate the
  // pipeline will skip at write time, so the plan has to see them too. The
  // first live rehearsal proved this the hard way: the dry run promised to
  // pay for both and the run created one.
  const seenHashes = new Map<string, string>();
  for (const f of chosen) {
    const p = await prepare(join(dir, f), f);
    if (!p.candidate.problem) {
      const hash = p.candidate.photoHash;
      const earlier = hash ? seenHashes.get(hash) : undefined;
      if (earlier) {
        p.candidate.duplicateOfFile = earlier;
      } else {
        if (hash) seenHashes.set(hash, f);
        const existing = await findAcceptedByPhotoHash(w.row.id, c.row.id, p.candidate.photoHash);
        if (existing) p.candidate.duplicateOfPlacementId = existing.id;
      }
    }
    prepared.push(p);
    process.stdout.write('.');
  }
  console.log('\n');

  const plan = planIngest(
    prepared.map((p) => p.candidate),
    c.row.rateCents,
  );

  console.log('file                        taken (EXIF)              location             outcome');
  for (const p of prepared) {
    const cd = p.candidate;
    const outcome = cd.problem
      ? `SKIP: ${cd.problem}`
      : cd.duplicateOfPlacementId
        ? `already paid (${cd.duplicateOfPlacementId.slice(0, 8)})`
        : cd.duplicateOfFile
          ? `same photo as ${cd.duplicateOfFile}`
          : `pay ${dollars(c.row.rateCents)}`;
    const where =
      cd.lat !== null && cd.lng !== null ? `${cd.lat.toFixed(5)}, ${cd.lng.toFixed(5)}` : 'no GPS in the photo';
    console.log(`${cd.file.padEnd(27)} ${(cd.takenAt ?? 'none').padEnd(25)} ${where.padEnd(20)} ${outcome}`);
  }

  console.log('');
  console.log(`to create                   : ${plan.send.length}`);
  console.log(`duplicates, skipped        : ${plan.duplicates.length}`);
  console.log(`cannot send                 : ${plan.problems.length}`);
  console.log(
    `TOTAL THIS RUN WILL PAY ${w.row.displayName}: ${dollars(plan.payCents)}  (${plan.send.length} x ${dollars(c.row.rateCents)})`,
  );

  if (!live) {
    console.log('');
    console.log('Dry run, nothing written. Each photo above would go through:');
    console.log('  handleBulkAcceptedSubmit(form, worker, adminUserId)');
    console.log('  the same code behind POST /api/admin/advertising/placements/bulk');
    const sample = plan.send[0];
    if (sample) {
      const bytes = prepared.find((p) => p.candidate.file === sample.file)?.upload?.byteLength ?? 0;
      console.log('  payload for the first one:');
      console.log(`    campaignId = ${c.row.id}`);
      console.log(`    workerId   = ${w.row.id}`);
      console.log(`    lat        = ${sample.lat ?? '(none)'}`);
      console.log(`    lng        = ${sample.lng ?? '(none)'}`);
      console.log(`    capturedAt = ${sample.takenAt ?? '(none)'}`);
      console.log(`    photo      = ${sample.file}, downscaled to ${bytes} bytes`);
    }
    console.log('');
    console.log('Re-run with --live to create these rows.');
    return;
  }

  // reviewed_by is a real FK to auth.users, so a live run needs a real admin
  // id. Resolve it rather than asking anyone to paste one.
  let adminUserId = process.env.ADVERTISING_INGEST_ADMIN_ID ?? '';
  if (!adminUserId) {
    const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) throw new Error(`listUsers for reviewed_by: ${error.message}`);
    const admin = data.users.find((u) => (u.app_metadata as { role?: string } | null)?.role === 'admin');
    if (!admin) throw new Error('no admin auth user found for reviewed_by; set ADVERTISING_INGEST_ADMIN_ID');
    adminUserId = admin.id;
  }

  const { handleBulkAcceptedSubmit } = await import('../src/lib/advertising/captureSubmit');
  const created: string[] = [];
  const skipped: string[] = [];
  const failed: { file: string; why: string }[] = [];

  for (const cd of plan.send) {
    const p = prepared.find((x) => x.candidate.file === cd.file);
    if (!p?.upload) {
      failed.push({ file: cd.file, why: 'no prepared bytes' });
      continue;
    }
    const form = new FormData();
    form.set('campaignId', c.row.id);
    form.set('workerId', w.row.id);
    if (cd.lat !== null && cd.lng !== null) {
      form.set('lat', String(cd.lat));
      form.set('lng', String(cd.lng));
    }
    if (cd.takenAt) form.set('capturedAt', cd.takenAt);
    form.set('photo', new File([new Uint8Array(p.upload)], p.uploadName, { type: p.contentType }), p.uploadName);

    const res = await handleBulkAcceptedSubmit(form, w.row, adminUserId);
    const body = (await res.json().catch(() => ({}))) as {
      placement?: { id: string };
      duplicate?: boolean;
      error?: string;
    };
    if (res.status === 201 && body.placement) {
      created.push(body.placement.id);
      console.log(`created  ${cd.file}  ${body.placement.id.slice(0, 8)}`);
    } else if (body.duplicate) {
      skipped.push(cd.file);
      console.log(`skipped  ${cd.file}  already uploaded`);
    } else {
      failed.push({ file: cd.file, why: body.error ?? `HTTP ${res.status}` });
      console.log(`FAILED   ${cd.file}  ${body.error ?? res.status}`);
    }
  }

  // Read the money back OUT of the database rather than trusting the
  // arithmetic above: what was actually stamped on the rows is the truth.
  let paidCents = 0;
  if (created.length) {
    const { data, error } = await db
      .from('advertising_placements')
      .select('id, accepted_rate_cents')
      .in('id', created);
    if (error) throw new Error(`reading back what was stamped: ${error.message}`);
    const rows = (data ?? []) as { id: string; accepted_rate_cents: number | null }[];
    paidCents = rows.reduce((sum, r) => sum + (r.accepted_rate_cents ?? 0), 0);
    if (rows.length !== created.length) {
      console.log(`WARNING: created ${created.length} rows but read back ${rows.length}`);
    }
  }

  console.log('');
  console.log(`created                     : ${created.length}`);
  console.log(`skipped as already uploaded : ${skipped.length}`);
  const why = failed.length ? ` (${failed.map((f) => `${f.file}: ${f.why}`).join('; ')})` : '';
  console.log(`failed                      : ${failed.length}${why}`);
  console.log(`PAID ${w.row.displayName}: ${dollars(paidCents)}, read back from the rows rather than predicted`);
  if (paidCents !== plan.payCents) {
    console.log(
      `note: the dry run predicted ${dollars(plan.payCents)}. The difference is the skipped and failed photos above.`,
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
