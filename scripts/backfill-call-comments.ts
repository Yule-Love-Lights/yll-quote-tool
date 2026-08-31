/**
 * HighLevel internal-comment backfill for already-posted call notes
 * (Naldo's ask, 2026-08-31).
 *
 *   npx tsx scripts/backfill-call-comments.ts              # dry run, 3 calls
 *   npx tsx scripts/backfill-call-comments.ts --limit 10   # dry run, 10 calls
 *   npx tsx scripts/backfill-call-comments.ts --live       # actually posts
 *
 * The internal-comment feature (#1131) shipped after the first batch of
 * call notes had already posted, so every one of those calls has a working
 * note and no comment. This one-off script closes that gap: it targets
 * ONLY calls that already have ghl_note_posted_at set and
 * ghl_comment_posted_at still null, so every row it touches already has a
 * reviewed, working note sitting on a real contact.
 *
 * DRY RUN IS THE DEFAULT and writes nothing at all: no comment posted, no
 * database write. It prints the exact endpoint, the contact id, and the
 * full comment body for each call it would touch, so a human approves the
 * real output before anything reaches the live CRM. That is this repo's
 * standing rule for a one-off script that writes to production.
 *
 * It drives the SAME function this script's caller reviewed
 * (src/lib/calls/backfillComments.ts), not a copy of it, so what the
 * preview shows is what the live run would post.
 *
 * NOT a cron. Run once, by hand, and stop.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // no .env.local, rely on the ambient environment
  }
}
loadEnvLocal();

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? '') : null;
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const limitArg = Number(arg('limit'));
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : 3;

  const { getSupabaseServiceClient, isSupabaseServiceConfigured } = await import('../src/lib/supabase');
  const { isHighLevelConfigured } = await import('../src/lib/integrations/highlevel');
  const { backfillMissingComments } = await import('../src/lib/calls/backfillComments');

  if (!isSupabaseServiceConfigured()) throw new Error('Supabase is not configured in this environment.');
  if (live && !isHighLevelConfigured()) throw new Error('HighLevel is not configured in this environment.');

  const supabase = getSupabaseServiceClient()!;

  console.log(live
    ? `LIVE RUN: posting up to ${limit} comments to HighLevel.`
    : `DRY RUN: previewing up to ${limit} comments. Nothing is written.`);
  console.log('');

  const result = await backfillMissingComments(supabase, limit, {
    dryRun: !live,
    onPreview: preview => {
      console.log('='.repeat(72));
      console.log(`transcript : ${preview.transcriptId}`);
      console.log(`called at  : ${preview.calledAt ?? 'unknown'}`);
      console.log('endpoint   : POST /conversations/messages, type InternalComment');
      console.log(`contact    : ${preview.contactId}`);
      console.log('-'.repeat(72));
      console.log(preview.body);
      console.log('='.repeat(72));
      console.log('');
    },
  });

  console.log('Result:', JSON.stringify(result));
  if (!live) {
    console.log('');
    console.log('Nothing was written. Re-run with --live once the bodies above look right.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
