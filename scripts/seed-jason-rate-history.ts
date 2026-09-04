/**
 * Enter Jason's real pay-rate history — ledger row 506, and the reason it
 * exists at all.
 *
 *   npx tsx scripts/seed-jason-rate-history.ts          # DRY RUN, writes nothing
 *   npx tsx scripts/seed-jason-rate-history.ts --live   # writes to production
 *
 * His history, from him (2026-09-04):
 *
 *     (beginning) .. 11 Aug 2026   $10.00/h
 *     12 Aug 2026 .. 31 Aug 2026   $13.00/h
 *      1 Sep 2026 .. today         $16.00/h
 *
 * The row-506 migration seeded ONE row per person at their CURRENT rate from
 * 2000-01-01, deliberately, so nothing moved on the day it shipped. For Jason
 * that row says $16.00 and is wrong about every hour he worked before
 * September. This corrects it and adds the two real boundaries.
 *
 * WHY A SCRIPT RATHER THAN THE SCREEN. The Rate history panel exists and is
 * the intended door, but it ships in PR #1214 and is not on production yet;
 * the browser pane on this machine also would not hydrate. So this drives
 * `setRateFrom` — the SAME function the panel's API route calls — rather than
 * writing SQL by hand, so the rate history and `crew_members.base_rate_cents`
 * are kept in step by the real code path and not by a second implementation
 * of that rule.
 *
 * ORDER MATTERS and is deliberate: NEWEST FIRST. `setRateFrom` recomputes
 * `base_rate_cents` as the rate in force today on every write, so entering
 * 1 Sep ($16.00) first means the column reads $16.00 at every intermediate
 * step and never passes through a wrong value. Entering oldest-first would
 * briefly set him to $10.00/hr.
 *
 * SAFE TO RE-RUN: every write is an upsert on (person, day), so running it
 * twice corrects the same three days rather than adding six rows.
 *
 * Authorised by Jason directly, 2026-09-04: "you can enter those three".
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

import { listRates, setRateFrom } from '../src/lib/crewMemberRates';
import { getStaffMember } from '../src/lib/crewMembers';
import { isSupabaseServiceConfigured } from '../src/lib/supabase';

const JASON = 'f883e4fe-6eed-4c60-8581-b72570f8fccd';

/** Newest first — see the note above; this order keeps the derived column
 * correct at every step. */
const HISTORY = [
  { effectiveFrom: '2026-09-01', rateCentsPerHour: 1600 },
  { effectiveFrom: '2026-08-12', rateCentsPerHour: 1300 },
  { effectiveFrom: '2000-01-01', rateCentsPerHour: 1000 },
];

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  if (!isSupabaseServiceConfigured()) {
    throw new Error('Supabase is not configured in this environment.');
  }

  const person = await getStaffMember(JASON);
  if (!person) throw new Error(`No staff member with id ${JASON}`);
  console.log(`Person: ${person.displayName}`);
  console.log(`Current base_rate_cents: ${dollars(person.baseRateCents)}/hr\n`);

  const before = await listRates(JASON);
  console.log('Rate history BEFORE:');
  for (const r of before) {
    console.log(`  ${r.effectiveFrom}  ${dollars(r.rateCentsPerHour)}/hr  (${r.createdBy ?? 'no author'})`);
  }

  console.log('\nWould write (newest first, so the current rate never dips):');
  for (const h of HISTORY) {
    console.log(`  ${h.effectiveFrom}  ${dollars(h.rateCentsPerHour)}/hr`);
  }

  if (!live) {
    console.log('\nDRY RUN — nothing written. Re-run with --live to apply.');
    return;
  }

  console.log('\nWriting...');
  for (const h of HISTORY) {
    await setRateFrom({
      crewMemberId: JASON,
      rateCentsPerHour: h.rateCentsPerHour,
      effectiveFrom: h.effectiveFrom,
      createdBy: 'Jason Balroop (jason@yulelovelights.com)',
    });
    const now = await getStaffMember(JASON);
    console.log(
      `  set ${h.effectiveFrom} = ${dollars(h.rateCentsPerHour)}/hr  ->  current rate now ${dollars(now?.baseRateCents ?? 0)}/hr`,
    );
  }

  const after = await listRates(JASON);
  console.log('\nRate history AFTER:');
  for (const r of after) {
    console.log(`  ${r.effectiveFrom}  ${dollars(r.rateCentsPerHour)}/hr  (${r.createdBy ?? 'no author'})`);
  }

  // ASSERT the invariants rather than eyeballing the output. A wrong current
  // rate here is somebody's pay, so it fails loudly instead of printing.
  const final = await getStaffMember(JASON);
  const problems: string[] = [];
  if (after.length !== 3) problems.push(`expected 3 rate rows, found ${after.length}`);
  if (final?.baseRateCents !== 1600) {
    problems.push(`expected current rate $16.00/hr, found ${dollars(final?.baseRateCents ?? 0)}/hr`);
  }
  for (const h of HISTORY) {
    const row = after.find((r) => r.effectiveFrom === h.effectiveFrom);
    if (!row) problems.push(`missing row for ${h.effectiveFrom}`);
    else if (row.rateCentsPerHour !== h.rateCentsPerHour) {
      problems.push(
        `${h.effectiveFrom} is ${dollars(row.rateCentsPerHour)}/hr, expected ${dollars(h.rateCentsPerHour)}/hr`,
      );
    }
  }
  if (problems.length > 0) {
    console.error('\nFAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: 3 rows, current rate $16.00/hr, every boundary as specified.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
