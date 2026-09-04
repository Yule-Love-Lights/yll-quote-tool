/**
 * Mark backlog sends, so the turnaround KPI keeps measuring response time.
 *
 *   npx tsx scripts/mark-backlog-sends.ts                    # dry run
 *   npx tsx scripts/mark-backlog-sends.ts --live             # writes
 *   npx tsx scripts/mark-backlog-sends.ts --built-before 2026-08-01 --held-days 14
 *   npx tsx scripts/mark-backlog-sends.ts --unmark --live    # clears every mark
 *
 * The homepage "Quote turnaround" KPI averages created_at to quote_sent_at
 * over every sent quote with no window. That is the right measure for "how
 * fast do we get a quote back to someone who asked". It is the wrong measure
 * for a quote that was built weeks earlier, held, and sent as part of a wave:
 * that gap is a decision about when to open the season.
 *
 * quotes.backlog_send_at marks such a send. A marked row keeps its real
 * created_at and quote_sent_at, still counts for conversion, booked revenue
 * and active quotes, and is left out of the turnaround average alone. See
 * computeKpis in src/lib/dashboard/metrics.ts and
 * migrations/2026-09-03-quote-backlog-send.sql.
 *
 * This script exists because the first run of it was a hand-written SQL
 * statement, which left no record of the criteria for whoever does this next
 * season. It does NOT run itself. Someone has to decide that a wave happened
 * and what counts as held, which is a judgement about the business and not
 * something a cron should guess.
 *
 * Run history:
 *   2026-09-03  --built-before 2026-08-01 --held-days 14  ->  51 rows
 *               (Naldo's rule, his named go). It deliberately left in 7
 *               quotes built and sent the same day, and 2 held only 9 days.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planBacklogSends, heldDays, type SentQuote } from './backlogSendPlan';

const ENV_LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;

function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(ENV_LINE);
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

type Row = SentQuote & { quote_number: number | null };

function fmt(n: number | null): string {
  return n == null ? 'n/a' : `${n.toFixed(2)} d`;
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const unmark = process.argv.includes('--unmark');
  const builtBefore = arg('built-before') ?? '2026-08-01';
  const heldDaysMin = Number(arg('held-days') ?? 14);

  if (!Number.isFinite(heldDaysMin) || heldDaysMin <= 0) {
    throw new Error('--held-days must be a positive number of days.');
  }
  if (Number.isNaN(new Date(builtBefore).getTime())) {
    throw new Error(`--built-before is not a date I can read: ${builtBefore}`);
  }

  const { getSupabaseServiceClient, isSupabaseServiceConfigured } = await import('../src/lib/supabase');
  if (!isSupabaseServiceConfigured()) throw new Error('Supabase is not configured in this environment.');
  const sb = getSupabaseServiceClient()!;

  // Every real sent quote. The dashboard's own two exclusions (is_test,
  // view_only) are applied here so this script and the KPI see one population.
  const { data, error } = await sb
    .from('quotes')
    .select('id, quote_number, created_at, quote_sent_at, backlog_send_at')
    .eq('is_test', false)
    .eq('view_only', false)
    .not('quote_sent_at', 'is', null)
    .order('quote_sent_at', { ascending: true })
    .limit(5000);
  if (error) throw new Error(`read failed: ${error.message}`);
  const rows = (data ?? []) as Row[];

  if (unmark) {
    const marked = rows.filter((r) => r.backlog_send_at !== null);
    console.log(`${live ? 'LIVE RUN' : 'DRY RUN'}: clearing the mark on ${marked.length} quotes.`);
    for (const r of marked) console.log(`  #${r.quote_number ?? r.id.slice(0, 8)}`);
    if (!live) {
      console.log('');
      console.log('Nothing was written. Re-run with --live to clear these.');
      return;
    }
    const { error: upErr } = await sb
      .from('quotes')
      .update({ backlog_send_at: null })
      .not('backlog_send_at', 'is', null);
    if (upErr) throw new Error(`unmark failed: ${upErr.message}`);
    console.log('');
    console.log(`Cleared ${marked.length}.`);
    return;
  }

  // The rule itself lives in backlogSendPlan.ts, where it is unit-tested
  // without needing prod credentials.
  const plan = planBacklogSends(rows, { builtBefore, heldDaysMin });
  const { matches, toWrite, alreadyMarked, keptIn } = plan;

  console.log(`${live ? 'LIVE RUN' : 'DRY RUN'}: built before ${builtBefore}, held ${heldDaysMin}+ days.`);
  console.log('');
  console.log(`  sent quotes in scope     ${rows.length}`);
  console.log(
    `  match the rule           ${matches.length}  (${alreadyMarked.length} already marked, ${toWrite.length} to write)`,
  );
  console.log(`  stay in the average      ${keptIn.length}`);
  console.log('');

  // The margin on both sides of the threshold. A rule whose smallest marked
  // gap and largest kept gap are neighbours is splitting near-identical
  // quotes, which is worth seeing before writing rather than after.
  console.log(`  smallest gap marked      ${fmt(plan.smallestGapMarked)}`);
  console.log(`  largest gap kept         ${fmt(plan.largestGapKept)}`);
  console.log('');
  console.log(`  turnaround now           ${fmt(plan.turnaroundNow)}`);
  console.log(`  turnaround after         ${fmt(plan.turnaroundAfter)}`);
  console.log('');

  for (const r of toWrite) {
    console.log(
      `  #${String(r.quote_number ?? r.id.slice(0, 8)).padEnd(6)} built ${r.created_at.slice(0, 10)}` +
        `  sent ${r.quote_sent_at.slice(0, 10)}  held ${heldDays(r).toFixed(1)} d`,
    );
  }

  if (!live) {
    console.log('');
    console.log('Nothing was written. Re-run with --live once the list above looks right.');
    return;
  }
  if (!toWrite.length) {
    console.log('');
    console.log('Nothing to write.');
    return;
  }

  const stamp = new Date().toISOString();
  const { error: upErr } = await sb
    .from('quotes')
    .update({ backlog_send_at: stamp })
    .in(
      'id',
      toWrite.map((r) => r.id),
    )
    // Never restamp a row that is already marked: the first mark's timestamp
    // is the record of when the decision was made.
    .is('backlog_send_at', null);
  if (upErr) throw new Error(`write failed: ${upErr.message}`);

  console.log('');
  console.log(`Marked ${toWrite.length} quotes at ${stamp}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
