// scripts/backfill-archive-night-photos.ts — ONE-TIME copy of the archive night
// photos from a local folder into the `training-archive` bucket (#167 slice 3).
//
// WHY A SCRIPT AND NOT A ROUTE. Slice 2's imagery fetch is an operator-triggered
// route because the Google Maps key only exists in the deployed environment.
// This job is the opposite shape: the bytes live in Naldo's Drive, and the app
// has NO Drive credential (GOOGLE_MAPS_API_KEY and a Gmail-scoped OAuth token
// are the only Google creds that exist). Rather than mint a Drive refresh token
// and hand the app standing read access to the whole Drive for what is a
// one-time historical copy, the operator downloads the archive folders once and
// points this script at them. The app stays credential-free and reads night
// photos from the bucket exactly like it reads the satellites.
//
// MATCHING. archive_photos rows are matched to files by BASENAME. Verified safe
// on the current corpus: 211 rows, 211 distinct original_title values, no
// duplicates across the 3 source folders. The script re-checks for ambiguity at
// runtime rather than trusting that, and refuses a file whose basename matches
// more than one row.
//
// IDEMPOTENT / RESUMABLE. Rows that already carry night_photo_ref are skipped,
// so a re-run after a partial failure only does the remaining work. --force
// re-uploads and overwrites.
//
// SAFETY: writes NOTHING without --live. The default is a dry run that reports
// exactly what it would upload and update — READ ITS OUTPUT. It prints the
// source file for every match precisely so a wrong match is visible before any
// bytes move; a stray file sharing a generic basename matches cleanly and
// raises no ambiguity warning.
//
// --force is the highest-blast-radius flag here: it re-uploads rows that
// already carry night_photo_ref, so pointing it at a wrong or partial folder
// overwrites an already-correct set rather than filling gaps. Dry-run it first.
//
// Usage:
//   npx tsx scripts/backfill-archive-night-photos.ts --dir ~/Downloads/archive
//   npx tsx scripts/backfill-archive-night-photos.ts --dir ~/Downloads/archive --live
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read from .env.local).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename, extname } from 'node:path';

const BUCKET = 'training-archive';
// Long edge cap. The queue renders these as identification thumbnails and a
// reference pane beside the satellite — not as an analyzer input — so full
// 2.6MB drone originals would be ~500MB of bucket for no visible gain.
const MAX_EDGE = 1600;
const JPEG_QUALITY = 80;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadEnvLocal();

  const dir = arg('dir');
  const live = process.argv.includes('--live');
  const force = process.argv.includes('--force');

  if (!dir) {
    console.error('Missing --dir <path to the downloaded archive folders>');
    process.exit(1);
  }
  const root = resolve(dir.replace(/^~/, process.env.HOME ?? '~'));
  if (!existsSync(root)) {
    console.error(`No such directory: ${root}`);
    process.exit(1);
  }
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!process.env[key]) {
      console.error(`Missing ${key} (set it in .env.local)`);
      process.exit(1);
    }
  }

  const { createClient } = await import('@supabase/supabase-js');
  const sharp = (await import('sharp')).default;
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // Excluded rows are not installs (the naming pass already ruled them out) and
  // never appear in the queue, so they don't need bytes in the bucket.
  const { data: rows, error } = await sb
    .from('archive_photos')
    .select('id, drive_file_id, original_title, night_photo_ref, status')
    .neq('status', 'excluded');
  if (error) {
    console.error('Failed to read archive_photos:', error.message);
    process.exit(1);
  }

  const files = walk(root).filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()));
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const key = basename(f).toLowerCase();
    byBase.set(key, [...(byBase.get(key) ?? []), f]);
  }

  console.log(`${rows!.length} candidate rows · ${files.length} image files under ${root}`);
  if (!live) console.log('DRY RUN — nothing will be written. Re-run with --live to apply.\n');

  let uploaded = 0, skipped = 0, missing = 0, ambiguous = 0, failed = 0;
  const missingTitles: string[] = [];
  // Which row already claimed each file. Guards the REVERSE of the ambiguity
  // check below: that one catches one row matching several files, this catches
  // several rows matching one file. Each row would individually see exactly one
  // match and raise nothing, while two different installs silently got the same
  // bytes. Distinct across all 211 titles today, so this is for a later import
  // where two cameras produce the same default filename.
  const claimedBy = new Map<string, string>();

  for (const row of rows!) {
    if (row.night_photo_ref && !force) { skipped++; continue; }

    const title = (row.original_title ?? '').toLowerCase();
    const matches = byBase.get(title) ?? [];
    if (matches.length === 0) {
      missing++;
      missingTitles.push(row.original_title ?? row.drive_file_id);
      continue;
    }
    if (matches.length > 1) {
      // Basenames are unique in the corpus today; if the operator's download
      // duplicated a file, refuse rather than guess which copy is the install.
      console.error(`AMBIGUOUS ${row.original_title}: ${matches.length} files match — skipped`);
      ambiguous++;
      continue;
    }

    const src = matches[0];
    const prior = claimedBy.get(src);
    if (prior) {
      console.error(`COLLISION ${row.original_title}: ${src} was already matched to ${prior} — skipped`);
      ambiguous++;
      continue;
    }
    claimedBy.set(src, row.original_title ?? row.drive_file_id);

    const path = `night/${row.drive_file_id}.jpg`;
    // Print the SOURCE FILE, not just the row's own title echoed back. A dry run
    // is the safety net before --live, and it can only catch a bad match if the
    // operator can see which file on disk was chosen — a stray file sharing a
    // generic basename (img13.png) matches exactly one row, raises no ambiguity,
    // and otherwise prints identically to a correct match.
    if (!live) { console.log(`would upload ${src}\n            -> ${path}  (row: ${row.original_title})`); uploaded++; continue; }

    try {
      const buf = await sharp(matches[0])
        .rotate() // honor EXIF orientation; drone shots are frequently rotated
        .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();

      const { error: upErr } = await sb.storage
        .from(BUCKET)
        .upload(path, buf, { contentType: 'image/jpeg', upsert: true });
      if (upErr) throw new Error(`upload: ${upErr.message}`);

      // Stamped only after the bytes land, so a crash between the two leaves the
      // row unstamped and the next run retries it rather than pointing at nothing.
      const { error: rowErr } = await sb
        .from('archive_photos')
        .update({ night_photo_ref: path })
        .eq('id', row.id);
      if (rowErr) throw new Error(`row update: ${rowErr.message}`);

      uploaded++;
      if (uploaded % 25 === 0) console.log(`  ${uploaded} uploaded…`);
    } catch (e) {
      failed++;
      console.error(`FAILED ${row.original_title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n${live ? 'Uploaded' : 'Would upload'}: ${uploaded}`);
  console.log(`Already done (skipped): ${skipped}`);
  console.log(`No matching file: ${missing}`);
  if (ambiguous) console.log(`Ambiguous (skipped): ${ambiguous}`);
  if (failed) console.log(`Failed: ${failed}`);
  if (missingTitles.length) {
    console.log('\nRows with no file in the folder (these stay without a night photo):');
    for (const t of missingTitles.slice(0, 30)) console.log(`  - ${t}`);
    if (missingTitles.length > 30) console.log(`  … and ${missingTitles.length - 30} more`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
