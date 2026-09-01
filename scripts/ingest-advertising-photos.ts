/**
 * Bulk-ingest a folder of placement photos for one crew member and one
 * campaign, through the REAL pipeline.
 *
 *   npx tsx scripts/ingest-advertising-photos.ts \
 *     --dir "C:/path/to/folder" --worker "Tiago" --campaign "September Yard Signs"
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
 * A live run must be given that approved total back, with --approved. If the
 * run would pay anything else, it refuses and writes nothing. The two numbers
 * are otherwise connected only by hope: the campaign rate can move between
 * the two runs, and a folder that syncs from Drive can gain a photo.
 *
 * Flags:
 *   --dir <path>         folder of photos (required)
 *   --worker <id|name>   the crew member being paid (required)
 *   --campaign <id|name> the campaign (required)
 *   --limit <n>          only the first n files, by name
 *   --env <path>         .env.local to read (default: ./.env.local)
 *   --admin <email|id>   the admin this batch is recorded against
 *   --approved <dollars> the total from the dry run, required with --live
 *   --live               actually create the rows and pay
 *
 * Re-running is mostly safe, and the exception is worth knowing. The pipeline
 * skips a photo whose PERCEPTUAL hash already belongs to an accepted,
 * unvoided row for this worker and campaign, so an interrupted batch is
 * resumed by running the same command again. Two things follow from it being
 * perceptual rather than a hash of the bytes: a photo whose hash could not be
 * computed carries no duplicate protection at all (this script says so, per
 * photo), and two near-identical retakes of the same sign are usually
 * different enough to both be paid.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import sharp from 'sharp';

import {
  checkApproval,
  dollars,
  parseApprovedDollars,
  planIngest,
  resolveAdmin,
  resolveByNameOrId,
  type AdminUser,
  type IngestCandidate,
} from './advertisingIngestPlan';

// Match the browser's upload rules exactly (src/lib/clientImage.ts), so a
// photo ingested here is the same artefact a phone would have produced.
const MAX_EDGE_PX = 2560;
const SKIP_BELOW_BYTES = 2.5 * 1024 * 1024;
const JPEG_QUALITY = 85;
// The server's own hard cap (intakeProofPhoto). A file still over this after
// downscaling is reported as a problem in the plan instead of failing the run
// halfway through.
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

// What the server will store as-is. Anything else has to be re-encoded to
// JPEG on the way, whatever its size, or the upload is refused.
const SERVER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
// What this script can read. HEIC is here because it is what an iPhone
// camera produces by default, and dropping those silently would leave real
// work unpaid with no trace (staff lens HIGH on this PR).
const READABLE_EXTS = new Set([...SERVER_EXTS, '.heic', '.heif']);

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

function blank(file: string, bytes: number): IngestCandidate {
  return {
    file,
    bytes,
    lat: null,
    lng: null,
    takenAt: null,
    photoHash: null,
    duplicateOfPlacementId: null,
    duplicateOfFile: null,
    problem: null,
  };
}

/**
 * Read one photo the way the browser does: EXIF off the ORIGINAL (a re-encode
 * strips it), then downscale, then hash what will actually be stored.
 */
async function prepare(path: string, file: string): Promise<Prepared> {
  const original = readFileSync(path);
  const base = blank(file, original.byteLength);
  const ext = extname(file).toLowerCase();
  let contentType = contentTypeFor(file);
  let uploadName = file;

  const exifr = (await import('exifr')).default;
  try {
    const gps = await exifr.gps(original);
    if (
      gps &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude) &&
      !(gps.latitude === 0 && gps.longitude === 0) &&
      // The server refuses the whole photo on an out-of-range pair rather
      // than dropping the location, so a plan that counted it would promise
      // pay for a photo that will 400.
      gps.latitude >= -90 &&
      gps.latitude <= 90 &&
      gps.longitude >= -180 &&
      gps.longitude <= 180
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
    // A format the server will not store has to be re-encoded whatever its
    // size, so the size-based skip below never applies to it.
    const mustConvert = !SERVER_EXTS.has(ext);
    const skip = !mustConvert && original.byteLength < SKIP_BELOW_BYTES && longest <= MAX_EDGE_PX;
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

  const approvedRaw = arg('approved');
  let approvedCents: number | null = null;
  if (approvedRaw !== undefined) {
    approvedCents = parseApprovedDollars(approvedRaw);
    if (approvedCents === null) {
      throw new Error(`--approved must be a plain dollar amount like 117.50, not "${approvedRaw}"`);
    }
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

  const workerFlags = `${w.row.active ? '' : '  [inactive]'}${w.row.isTest ? '  [test]' : ''}`;
  console.log(`crew member : ${w.row.displayName} (${w.row.id})${workerFlags}`);
  console.log(
    `campaign    : ${c.row.name} (${c.row.id})  ${c.row.kind}  ${dollars(c.row.rateCents)} per accepted photo${
      c.row.isTest ? '  [test]' : ''
    }`,
  );
  console.log(`folder      : ${resolve(dir)}`);
  console.log(
    `mode        : ${live ? 'LIVE. This creates paid rows in the real database.' : 'DRY RUN. Nothing is written.'}`,
  );
  console.log('');

  // EVERY file is listed, not only the ones this script can read. Filtering
  // first is how a folder of iPhone photos would report a smaller batch than
  // it holds and leave the rest silently unpaid.
  const allFiles = readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
  const chosen = limit ? allFiles.slice(0, limit) : allFiles;
  const tail = limit ? `, looking at the first ${chosen.length}` : '';
  console.log(`${allFiles.length} file${allFiles.length === 1 ? '' : 's'} in the folder${tail}`);

  const prepared: Prepared[] = [];
  // Two copies of one photo inside the same folder are a duplicate the
  // pipeline will skip at write time, so the plan has to see them too. The
  // first live rehearsal proved this the hard way: the dry run promised to
  // pay for both and the run created one.
  const seenHashes = new Map<string, string>();
  for (const f of chosen) {
    const ext = extname(f).toLowerCase();
    if (!READABLE_EXTS.has(ext)) {
      const size = statSync(join(dir, f)).size;
      prepared.push({
        candidate: { ...blank(f, size), problem: `not a photo this can read (${ext || 'no extension'})` },
        upload: null,
        contentType: '',
        uploadName: f,
      });
      process.stdout.write('.');
      continue;
    }
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

  console.log('file                        date taken                where it was taken       what happens');
  for (const p of prepared) {
    const cd = p.candidate;
    const outcome = cd.problem
      ? `SKIPPED: ${cd.problem}`
      : cd.duplicateOfPlacementId
        ? `already paid for (${cd.duplicateOfPlacementId.slice(0, 8)})`
        : cd.duplicateOfFile
          ? `same photo as ${cd.duplicateOfFile}`
          : `earns ${dollars(c.row.rateCents)}${cd.photoHash ? '' : '  (no duplicate protection, see below)'}`;
    const where =
      cd.lat !== null && cd.lng !== null ? `${cd.lat.toFixed(5)}, ${cd.lng.toFixed(5)}` : 'no location in the photo';
    console.log(`${cd.file.padEnd(27)} ${(cd.takenAt ?? 'none').padEnd(25)} ${where.padEnd(24)} ${outcome}`);
  }

  const unhashed = plan.send.filter((cd) => !cd.photoHash);
  console.log('');
  console.log(`to create                   : ${plan.send.length}`);
  console.log(`duplicates, skipped         : ${plan.duplicates.length}`);
  console.log(`cannot send                 : ${plan.problems.length}`);
  console.log(
    `THIS RUN ADDS ${dollars(plan.payCents)} TO ${w.row.displayName.toUpperCase()}'S UNPAID BALANCE  (${plan.send.length} x ${dollars(
      c.row.rateCents,
    )})`,
  );
  console.log('That is money earned. Paying it out is a separate step on the Settings screen.');
  if (unhashed.length) {
    console.log('');
    console.log(
      `${unhashed.length} photo${unhashed.length === 1 ? '' : 's'} could not be fingerprinted, so re-running this ` +
        'command would pay for them a second time. Send them once, or check them by hand afterwards.',
    );
  }

  const approval = checkApproval(plan.payCents, approvedCents, live);
  if (!approval.ok) {
    console.log('');
    console.log(`REFUSED. ${approval.reason}`);
    process.exitCode = 1;
    return;
  }

  if (!live) {
    console.log('');
    console.log('Dry run. Nothing was written. Each photo above would go through:');
    console.log('  handleBulkAcceptedSubmit, the same code behind the admin bulk upload screen');
    const sample = plan.send[0];
    if (sample) {
      const bytes = prepared.find((p) => p.candidate.file === sample.file)?.upload?.byteLength ?? 0;
      console.log('  what gets sent for the first one:');
      console.log(`    campaign   = ${c.row.name} (${c.row.id})`);
      console.log(`    crew       = ${w.row.displayName} (${w.row.id})`);
      console.log(`    location   = ${sample.lat ?? '(none)'}, ${sample.lng ?? '(none)'}`);
      console.log(`    date taken = ${sample.takenAt ?? '(none)'}`);
      console.log(`    photo      = ${sample.file}, resized to ${bytes} bytes`);
    }
    console.log('');
    console.log('To run it for real, pass back the total above:');
    console.log(
      `  npx tsx scripts/ingest-advertising-photos.ts --dir "${resolve(dir)}" --worker "${w.row.displayName}" ` +
        `--campaign "${c.row.name}" --approved ${(plan.payCents / 100).toFixed(2)} --live`,
    );
    return;
  }

  // The plan was priced from a rate read at the top of this run, and the
  // pipeline re-reads the campaign and stamps whatever the rate is at the
  // moment each photo is written. Re-reading it here shrinks that window to
  // almost nothing, and the summary below still checks every stamped rate,
  // because almost nothing is not nothing (delta-verify on this PR).
  const { getAdvertisingCampaign } = await import('../src/lib/advertising/campaigns');
  const fresh = await getAdvertisingCampaign(c.row.id);
  if (!fresh) throw new Error('The campaign disappeared between the plan and the run. Nothing was written.');
  if (fresh.rateCents !== c.row.rateCents) {
    console.log('');
    console.log(
      `REFUSED. The campaign rate moved from ${dollars(c.row.rateCents)} to ${dollars(fresh.rateCents)} while this ` +
        'was being prepared, so the approved total is no longer the right one. Nothing was written. Run it again ' +
        'without --live and look at the new plan.',
    );
    process.exitCode = 1;
    return;
  }
  if (!fresh.active) {
    console.log('');
    console.log('REFUSED. The campaign was closed while this was being prepared. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  const { data: userList, error: userError } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (userError) throw new Error(`reading the admin accounts: ${userError.message}`);
  const adminUserId = resolveAdmin(
    userList.users as unknown as AdminUser[],
    arg('admin') ?? process.env.ADVERTISING_INGEST_ADMIN_ID,
  );

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
    if (cd.lat !== null && cd.lng !== null) {
      form.set('lat', String(cd.lat));
      form.set('lng', String(cd.lng));
    }
    if (cd.takenAt) form.set('capturedAt', cd.takenAt);
    form.set('photo', new File([new Uint8Array(p.upload)], p.uploadName, { type: p.contentType }), p.uploadName);

    // A throw here would end the run with the earlier photos already paid and
    // no summary printed, which is the worst way to stop.
    try {
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
        const whyNot = body.error ?? `refused with status ${res.status}`;
        failed.push({ file: cd.file, why: whyNot });
        console.log(`FAILED   ${cd.file}  ${whyNot}`);
      }
    } catch (e) {
      const whyNot = e instanceof Error ? e.message : String(e);
      failed.push({ file: cd.file, why: whyNot });
      console.log(`FAILED   ${cd.file}  ${whyNot}`);
    }
  }

  // Read the money back OUT of the database rather than trusting the
  // arithmetic above: what was actually stamped on the rows is the truth.
  let paidCents = 0;
  let readBack = 0;
  let driftedRates = 0;
  let readBackError: string | null = null;
  if (created.length) {
    // Rows have already been created and paid by this point. A failure to
    // read them back must never cost the summary, the total, or the line
    // telling the operator how to undo any of it.
    try {
      const { data, error } = await db
        .from('advertising_placements')
        .select('id, accepted_rate_cents')
        .in('id', created);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { id: string; accepted_rate_cents: number | null }[];
      readBack = rows.length;
      paidCents = rows.reduce((sum, r) => sum + (r.accepted_rate_cents ?? 0), 0);
      driftedRates = rows.filter((r) => (r.accepted_rate_cents ?? 0) !== c.row.rateCents).length;
    } catch (e) {
      readBackError = e instanceof Error ? e.message : String(e);
    }
  }

  console.log('');
  console.log(`created                     : ${created.length}`);
  console.log(`skipped as already uploaded : ${skipped.length}`);
  const why = failed.length ? ` (${failed.map((f) => `${f.file}: ${f.why}`).join('; ')})` : '';
  console.log(`failed                      : ${failed.length}${why}`);
  if (readBackError) {
    // The estimate is built from the rows this run actually CREATED, not from
    // the plan: photos that failed are listed above and never became rows, so
    // quoting the plan's figure here would overstate what was written by
    // exactly their value (delta-verify, round two on this PR).
    const estimate = created.length * c.row.rateCents;
    console.log(
      `The rows were created. Reading their stamped amounts back failed (${readBackError}), so the figure below is ` +
        'counted from what this run created rather than read from the database. Check the campaign in the admin app.',
    );
    console.log(
      `PROBABLY ${dollars(estimate)} FOR ${w.row.displayName.toUpperCase()}, not confirmed (${created.length} x ${dollars(
        c.row.rateCents,
      )})`,
    );
  } else {
    console.log(
      `ADDED ${dollars(paidCents)} TO ${w.row.displayName.toUpperCase()}'S UNPAID BALANCE, read back from the rows rather than predicted`,
    );
    if (readBack !== created.length) {
      console.log(`WARNING: created ${created.length} rows but only read back ${readBack}`);
    }
    if (driftedRates > 0) {
      // Not a shortfall of photos: the same photos at a different price. The
      // pipeline re-reads the campaign for every write, so a rate change
      // during the run lands on whatever is left.
      console.log(
        `${driftedRates} photo${driftedRates === 1 ? ' was' : 's were'} stamped at a rate other than the ` +
          `${dollars(c.row.rateCents)} this run was priced at. The campaign rate changed while the run was in ` +
          'progress; every photo still landed.',
      );
    } else if (paidCents !== plan.payCents) {
      console.log(`note: the plan expected ${dollars(plan.payCents)}.`);
    }
  }
  // Printed whatever else happened. A run can drift on rate AND lose a photo,
  // and the drift explanation used to swallow this pointer entirely.
  if (failed.length) {
    console.log('Every photo that did not land is listed above, with why.');
  }
  if (created.length) {
    console.log('');
    console.log(
      'To undo any of these: open the campaign in the admin app, find the photo, and void it. ' +
        'A voided photo stops counting for pay and can be re-sent later. Do it before the payout is settled.',
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
