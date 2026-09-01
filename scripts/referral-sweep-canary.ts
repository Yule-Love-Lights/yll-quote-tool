// One-off CANARY run of the referral sweep, authorised by Naldo 2026-09-01.
//
// Runs the real sweep LIVE against a deliberately small slice of contacts so
// we can answer one question with evidence instead of hope: does applying the
// `neighbor` / `has-referral-link` tags trigger any GoHighLevel automation?
//
// A tag is not removable from this codebase (there is no removeContactTags),
// so the blast radius is chosen small enough to undo by hand in GHL if the
// answer turns out to be "yes, something fired".
//
// This calls runReferralSweep directly rather than the HTTP route, because the
// route is CRON_SECRET-guarded and that secret lives only in Vercel. Same
// module, same code path the cron takes.
//
//   npx tsx scripts/referral-sweep-canary.ts            # dry run, default
//   npx tsx scripts/referral-sweep-canary.ts --live 10  # REAL, 10 contacts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// No dotenv in this repo's dependencies, and adding one to a SHARED
// package.json for a one-off script is not worth it.
const envFile = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
for (const rawLine of envFile.split('\n')) {
  const line = rawLine.replace(/\r$/, '');
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  // Imported after the env is populated: referralSweep's module graph reads
  // config at import time, so a static import at the top of the file would
  // see an empty environment.
  const { runReferralSweep } = await import('../src/lib/referralSweep');

  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const nArg = args[args.indexOf('--live') + 1];
  const maxContacts = Number.isFinite(Number(nArg)) && Number(nArg) > 0 ? Number(nArg) : 10;

  console.log(`[canary] mode=${live ? 'LIVE (writes)' : 'dry run'} maxContacts=${maxContacts}`);
  if (live) {
    console.log('[canary] this WILL mint referral codes and apply GHL tags to real contacts');
  }

  const summary = await runReferralSweep({ dryRun: !live, maxContacts });
  console.log('[canary] summary:');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('[canary] failed:', err);
  process.exit(1);
});
