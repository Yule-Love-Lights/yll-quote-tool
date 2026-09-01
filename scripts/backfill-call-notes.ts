/**
 * Post-call HighLevel note backfill (Naldo's ask, 2026-08-29).
 *
 *   npx tsx scripts/backfill-call-notes.ts              # dry run, 3 calls
 *   npx tsx scripts/backfill-call-notes.ts --limit 10   # dry run, 10 calls
 *   npx tsx scripts/backfill-call-notes.ts --live       # actually posts
 *
 * DRY RUN IS THE DEFAULT and writes nothing at all: no claim, no summary
 * saved, no note posted. It prints the exact endpoint, the contact id, and
 * the full note body for each call it would have noted, so a human approves
 * the real output before anything reaches the live CRM. That is this repo's
 * standing rule for a one-off script that writes to production.
 *
 * It drives the SAME function the live calls-note cron drives
 * (src/lib/calls/postNotes.ts), not a copy of it, so what the preview shows
 * is what the cron would post.
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
  const { isClaudeConfigured } = await import('../src/lib/claude');
  const { isHighLevelConfigured } = await import('../src/lib/integrations/highlevel');
  const { postPendingCallNotes } = await import('../src/lib/calls/postNotes');

  if (!isSupabaseServiceConfigured()) throw new Error('Supabase is not configured in this environment.');
  if (!isClaudeConfigured()) throw new Error('ANTHROPIC_API_KEY is not set in this environment.');
  if (live && !isHighLevelConfigured()) throw new Error('HighLevel is not configured in this environment.');

  const supabase = getSupabaseServiceClient()!;

  console.log(live
    ? `LIVE RUN: posting up to ${limit} notes to HighLevel.`
    : `DRY RUN: previewing up to ${limit} notes. Nothing is written.`);
  console.log('');

  const result = await postPendingCallNotes(supabase, limit, new Date(), {
    dryRun: !live,
    onPreview: preview => {
      console.log('='.repeat(72));
      console.log(`transcript : ${preview.transcriptId}`);
      console.log(`called at  : ${preview.calledAt ?? 'unknown'}`);
      console.log(`endpoint   : POST /contacts/${preview.contactId}/notes`);
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
