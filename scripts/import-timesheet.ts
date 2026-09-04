/**
 * Import Jason's pre-tool time spreadsheet — ledger row 507.
 *
 * TWO STEPS, because the meaning of the sheet lives in CELL COLOUR and reading
 * that needs a real xlsx library:
 *
 *   python scripts/read-timesheet.py "...\Time Tracker.xlsx" > timesheet.json
 *   npx tsx scripts/import-timesheet.ts timesheet.json                # DRY RUN
 *   npx tsx scripts/import-timesheet.ts timesheet.json --live         # writes
 *   npx tsx scripts/import-timesheet.ts timesheet.json --live --undo  # reverses
 *
 * The JSON in between is deliberate, not plumbing: it is a plain, diffable
 * record of how every row of the spreadsheet was interpreted, reviewable by a
 * person before a single row is written.
 *
 * WHY THIS EXISTS. Jason tracked his own time in a spreadsheet for a year
 * before this tool. Row 507: get it in, so his real history lives here and he
 * can settle what is still owed with the software.
 *
 * IT MUST RUN AFTER ROW 506, and does not check politely — it REFUSES if the
 * rate history is missing. Importing first would value a year of work at
 * today's rate: the unpaid hours alone come to $4,102 at his real rates and
 * $5,745 at a flat $16.00.
 *
 * WHAT THE COLOURS MEAN, since nothing else in the sheet records it:
 *   green fill on Hours = already PAID · no fill = still owed
 *   yellow fill on Date = the first day of a new pay rate
 * The two yellow days are 12 Aug and 1 Sep 2026, which is exactly the rate
 * history Jason gave independently. The script asserts they agree.
 *
 * WHAT IT DELETES FIRST, and why that is safe. Jason's three existing shifts
 * in the tool (21 Aug, 1 Sep, 4 Sep) are TEST data from building this feature
 * — his words, 2026-09-04: "all my hours on the quote tool so far are from
 * testing... From tomorrow I'll start using the quote tool as the source of
 * truth." They overlap the sheet, so leaving them would double-count. Every
 * deleted row is written to a JSON file BEFORE anything is destroyed, and the
 * destruction is refused if that file cannot be written (the S78 rule: the
 * record goes first, or the deletion does not happen).
 *
 * This bypasses `adminVoidShift`, which refuses to remove anything that is not
 * a manual office entry. That guard is right and stays: it exists so real
 * clock data cannot be deleted from the UI. This is a one-off migration with
 * the owner's explicit instruction, not a path anybody can reach by clicking.
 *
 * THE PLACEHOLDER TIMES. The sheet has a date and a duration, never a start
 * time. Imported shifts are anchored at 09:00 ET (see ANCHOR_ET_HOUR) and run
 * for the recorded duration. The DAY and the DURATION are real; the clock
 * times are not, and every imported row says so in `manual_by`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
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

import { listRates, rateForDay } from '../src/lib/crewMemberRates';
import { dollars, formatSeconds, unpaidRemainders } from '../src/lib/shiftSettlements';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '../src/lib/supabase';
import { paidValueCents, planImport, type TimesheetRow } from '../src/lib/timesheetImport';

const JASON = 'f883e4fe-6eed-4c60-8581-b72570f8fccd';

/** Stamped on every imported shift, so nothing here is ever mistaken for a
 * real clock-in. Also the marker `--undo` finds them by. */
const IMPORT_STAMP = 'imported from Time Tracker.xlsx (row 507)';
/** Where the deleted rows are recorded before they are deleted.
 *
 * Under the repo root only because that is where this is run from, and
 * .gitignore keeps it out of git: it holds real payroll rows and is a recovery
 * copy for a person, never source. Move it somewhere safe afterwards. */
const BACKUP_PATH = resolve(process.cwd(), 'timesheet-import-deleted-shifts.json');

type Db = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

function requireDb(): Db {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  return db;
}

/**
 * Read the JSON that `read-timesheet.py` produced, and REFUSE anything that is
 * not the shape this expects.
 *
 * Validated field by field rather than cast, because everything downstream —
 * which day a shift lands on, whether it counts as paid — comes from here, and
 * a silently-missing `paid` flag would read as "still owed" and put a year of
 * settled work back on the books.
 */
function readRows(jsonPath: string): TimesheetRow[] {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
  const doc = raw as { rows?: unknown };
  if (!Array.isArray(doc.rows) || doc.rows.length === 0) {
    throw new Error(`${jsonPath} has no rows. Re-run scripts/read-timesheet.py.`);
  }
  return doc.rows.map((r, i) => {
    const row = r as Record<string, unknown>;
    const need = (k: string, t: string) => {
      if (typeof row[k] !== t) {
        throw new Error(
          `row ${i} of ${jsonPath}: ${k} should be a ${t}, got ${JSON.stringify(row[k])}`,
        );
      }
    };
    need('sheetRow', 'number');
    need('day', 'string');
    need('durationSeconds', 'number');
    need('paid', 'boolean');
    need('rateBoundary', 'boolean');
    return row as unknown as TimesheetRow;
  });
}

async function undo(db: Db): Promise<void> {
  const { data, error } = await db
    .from('shifts')
    .select('id')
    .eq('crew_member_id', JASON)
    .eq('manual_by', IMPORT_STAMP);
  if (error) throw new Error(`undo: ${error.message}`);
  const ids = (data ?? []).map((r) => (r as { id: string }).id);
  console.log(`Found ${ids.length} imported shifts.`);
  if (ids.length === 0) return;

  // Settlements first: a shift with a live payment line refuses to be deleted
  // (FK NO ACTION), and that refusal is the point of the FK.
  const { data: lines } = await db
    .from('shift_settlement_lines')
    .select('settlement_id')
    .in('shift_id', ids);
  const settlementIds = [...new Set((lines ?? []).map((l) => (l as { settlement_id: string }).settlement_id))];
  if (settlementIds.length > 0) {
    await db.from('shift_settlement_lines').delete().in('settlement_id', settlementIds);
    await db.from('shift_settlements').delete().in('id', settlementIds);
    console.log(`  removed ${settlementIds.length} settlement(s) covering them`);
  }
  const { error: delError } = await db.from('shifts').delete().in('id', ids);
  if (delError) throw new Error(`undo: deleting shifts: ${delError.message}`);
  console.log(`  removed ${ids.length} imported shifts`);
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const isUndo = process.argv.includes('--undo');
  if (!isSupabaseServiceConfigured()) throw new Error('Supabase is not configured in this environment.');
  const db = requireDb();

  if (isUndo) {
    if (!live) {
      console.log('Undo needs --live as well. Nothing done.');
      return;
    }
    await undo(db);
    return;
  }

  // ---- 1. The rate history must already be there (row 506 before row 507).
  const rates = await listRates(JASON);
  if (rates.length === 0) {
    throw new Error(
      'No rate history for Jason. Row 506 ships before this one for a reason: without it every imported hour is valued at his current rate.',
    );
  }
  const rateAt = (day: string) => rateForDay(rates, day);
  console.log('Rate history in place:');
  for (const r of rates) console.log(`  from ${r.effectiveFrom}  ${dollars(r.rateCentsPerHour)}/hr`);

  // ---- 2. Read and plan.
  const jsonPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!jsonPath) {
    throw new Error('Pass the JSON from scripts/read-timesheet.py as the first argument.');
  }
  const sheetRows = readRows(jsonPath);
  const plan = planImport(sheetRows);
  console.log(`\nSheet: ${plan.totals.rows} dated rows -> ${plan.totals.imported} shifts, ${plan.skipped.length} skipped`);
  for (const s of plan.skipped) console.log(`  SKIP row ${s.sheetRow} ${s.day}: ${s.reason}`);

  // The sheet's own yellow cells must agree with the rate history. They are
  // two independent records of the same fact, and a disagreement means one of
  // them is wrong about what somebody was paid.
  const historyBoundaries = rates.map((r) => r.effectiveFrom).filter((d) => d > '2020-01-01');
  console.log(`\nRate boundaries — sheet (yellow): ${plan.rateBoundaries.join(', ') || 'none'}`);
  console.log(`                  history        : ${historyBoundaries.join(', ') || 'none'}`);
  const boundariesAgree =
    plan.rateBoundaries.length === historyBoundaries.length &&
    plan.rateBoundaries.every((d, i) => d === historyBoundaries[i]);
  console.log(`                  agree          : ${boundariesAgree ? 'YES' : 'NO — check before importing'}`);

  const { cents: paidCents, unratedDays } = paidValueCents(plan.shifts, rateAt);
  if (unratedDays.length > 0) {
    throw new Error(
      `${unratedDays.length} already-paid day(s) have no rate on record (${unratedDays.slice(0, 5).join(', ')}...). ` +
        'They would be imported as paid and then left unpaid, because the settlement cannot cover hours it cannot value. Add the missing rates first.',
    );
  }
  const unpaidSeconds = plan.totals.unpaidSeconds;
  const unpaidValue = plan.shifts
    .filter((s) => !s.paid)
    .reduce((n, s) => n + Math.round((s.durationSeconds * rateAt(s.day)) / 3600), 0);

  console.log(`\n  PAID   ${plan.totals.paidShifts} shifts  ${formatSeconds(plan.totals.paidSeconds)}  worth ${dollars(paidCents)}`);
  console.log(`  UNPAID ${plan.totals.unpaidShifts} shifts  ${formatSeconds(unpaidSeconds)}  worth ${dollars(unpaidValue)}`);

  // ---- 3. The existing test shifts that would double-count.
  const { data: existing, error: exError } = await db
    .from('shifts')
    .select('*')
    .eq('crew_member_id', JASON)
    .is('manual_by', null);
  if (exError) throw new Error(`reading existing shifts: ${exError.message}`);
  const { data: existingManual } = await db
    .from('shifts')
    .select('*')
    .eq('crew_member_id', JASON)
    .not('manual_by', 'is', null)
    .neq('manual_by', IMPORT_STAMP);
  const toDelete = [...((existing ?? []) as Record<string, unknown>[]), ...((existingManual ?? []) as Record<string, unknown>[])];
  console.log(`\nExisting NON-imported shifts to remove (test data): ${toDelete.length}`);
  for (const s of toDelete) {
    console.log(`  ${String(s.clock_in_at).slice(0, 10)}  source=${s.source}  ${s.clock_out_at ? 'closed' : 'STILL OPEN'}`);
  }

  const alreadyImported = await db
    .from('shifts')
    .select('id')
    .eq('crew_member_id', JASON)
    .eq('manual_by', IMPORT_STAMP);
  const already = (alreadyImported.data ?? []).length;
  if (already > 0) {
    throw new Error(
      `${already} shifts from a previous run of this import are already in the database. Run with --live --undo first; this script does not merge.`,
    );
  }

  if (!live) {
    console.log('\nDRY RUN — nothing written. Re-run with --live to apply.');
    return;
  }

  // ---- 4. Record what is about to be destroyed, BEFORE destroying it.
  writeFileSync(BACKUP_PATH, JSON.stringify({ deletedAt: new Date().toISOString(), shifts: toDelete }, null, 2));
  const check = JSON.parse(readFileSync(BACKUP_PATH, 'utf8')) as { shifts: unknown[] };
  if (check.shifts.length !== toDelete.length) {
    throw new Error('The backup file did not land intact, so nothing was deleted.');
  }
  console.log(`\nBacked up ${toDelete.length} shifts to ${BACKUP_PATH}`);

  const deleteIds = toDelete.map((s) => String(s.id));
  if (deleteIds.length > 0) {
    // Voided settlement lines still hold an FK on these shifts.
    const { data: oldLines } = await db.from('shift_settlement_lines').select('settlement_id').in('shift_id', deleteIds);
    const oldSettlements = [...new Set((oldLines ?? []).map((l) => (l as { settlement_id: string }).settlement_id))];
    if (oldSettlements.length > 0) {
      await db.from('shift_settlement_lines').delete().in('settlement_id', oldSettlements);
      await db.from('shift_settlements').delete().in('id', oldSettlements);
      console.log(`  removed ${oldSettlements.length} test settlement(s) attached to them`);
    }
    const { error: dErr } = await db.from('shifts').delete().in('id', deleteIds);
    if (dErr) throw new Error(`deleting test shifts: ${dErr.message}`);
    console.log(`  deleted ${deleteIds.length} test shifts`);
  }

  // ---- 5. Create the imported shifts, keeping the id of each one.
  const payload = plan.shifts.map((s) => ({
    crew_member_id: JASON,
    clock_in_at: s.clockInAt,
    clock_out_at: s.clockOutAt,
    source: 'office',
    close_source: 'office',
    manual_by: IMPORT_STAMP,
  }));
  const CHUNK = 200;
  const createdIds: { id: string; clockInAt: string }[] = [];
  for (let k = 0; k < payload.length; k += CHUNK) {
    const { data, error } = await db
      .from('shifts')
      .insert(payload.slice(k, k + CHUNK))
      .select('id, clock_in_at');
    if (error) throw new Error(`inserting shifts: ${error.message}`);
    for (const r of (data ?? []) as { id: string; clock_in_at: string }[]) {
      createdIds.push({ id: r.id, clockInAt: r.clock_in_at });
    }
  }
  if (createdIds.length !== plan.shifts.length) {
    throw new Error(`expected ${plan.shifts.length} shifts, ${createdIds.length} landed`);
  }
  console.log(`  created ${createdIds.length} shifts`);

  // Map each created row back to the sheet row it came from, by INSTANT.
  // The insert returns rows in order, but relying on that would be relying on
  // postgrest's ordering rather than on the data itself.
  const idByInstant = new Map(createdIds.map((r) => [Date.parse(r.clockInAt), r.id]));
  const paidShifts = plan.shifts.filter((x) => x.paid);
  const lines = paidShifts.map((x) => {
    const id = idByInstant.get(Date.parse(x.clockInAt));
    if (!id) throw new Error(`no shift landed for ${x.day} (sheet row ${x.sheetRow})`);
    const rate = rateAt(x.day);
    return {
      shift_id: id,
      paid_seconds: x.durationSeconds,
      shift_total_seconds: x.durationSeconds,
      rate_cents_per_hour: rate,
      reference_cents: Math.round((x.durationSeconds * rate) / 3600),
    };
  });

  // ---- 6. One settlement for the already-paid days.
  //
  // THE LINES ARE WRITTEN DIRECTLY, not through the ordinary settlement path,
  // and that divergence is deliberate.
  //
  // That path takes an AMOUNT and spends it oldest-first, deciding for itself
  // where the money runs out. Right for a real payment, where the amount is
  // the known fact. Here the known fact is the opposite: the spreadsheet names
  // 95 SPECIFIC days as paid and the amount is derived from them. Pushing that
  // through the allocator forces a boundary the source data does not have, and
  // it does not land cleanly — measured before writing, the derived amount
  // overshoots the paid set by 6 cent-seconds and would mark SIX SECONDS of
  // 7 July, a genuinely unpaid day, as paid. Tiny, and the wrong direction on
  // a payroll import.
  //
  // So each paid day gets a line covering exactly its own hours, which is what
  // the green fill actually says. The trigger added 2026-09-03 still checks
  // every line against its shift's length, so this is not writing around the
  // database's guarantee — it is writing the exact rows the allocator would
  // otherwise have to approximate.
  //
  // The sheet records no amount and no method, and this claims neither: the
  // value is derived, the method is `other`, and the note says so. Dated the
  // last already-paid day rather than today, because a payment for work
  // settled months ago should not read as money that moved this afternoon.
  const lastPaidDay = paidShifts.map((x) => x.day).sort().pop();
  const lineTotal = lines.reduce((n, l) => n + l.reference_cents, 0);
  if (lineTotal !== paidCents) {
    throw new Error(`lines sum to ${lineTotal}, expected ${paidCents}`);
  }

  const { data: stRow, error: stError } = await db
    .from('shift_settlements')
    .insert({
      crew_member_id: JASON,
      total_cents: paidCents,
      method: 'other',
      note: `Historical, pre-tool: the ${paidShifts.length} days marked paid in the Time Tracker spreadsheet, up to ${lastPaidDay}. The amount is DERIVED from those hours at the rates in force; the sheet records no payment amount or method, so neither is claimed here.`,
      paid_at: `${lastPaidDay}T23:00:00.000Z`,
      paid_by: 'Jason Balroop (jason@yulelovelights.com)',
    })
    .select('id')
    .maybeSingle();
  if (stError) throw new Error(`recording the historical settlement: ${stError.message}`);
  const settlementId = (stRow as { id: string } | null)?.id;
  if (!settlementId) throw new Error('the historical settlement returned no id');

  for (let k = 0; k < lines.length; k += CHUNK) {
    const { error } = await db
      .from('shift_settlement_lines')
      .insert(lines.slice(k, k + CHUNK).map((l) => ({ ...l, settlement_id: settlementId })));
    if (error) {
      // A settlement with no lines counts toward what this person has been
      // paid while covering nothing, so it is not left behind.
      await db.from('shift_settlement_lines').delete().eq('settlement_id', settlementId);
      await db.from('shift_settlements').delete().eq('id', settlementId);
      throw new Error(`attaching settlement lines: ${error.message} (the settlement was removed)`);
    }
  }
  console.log(`  recorded ${dollars(paidCents)} covering ${lines.length} shifts, dated ${lastPaidDay}`);

  // ---- 7. Assert the outcome rather than eyeballing it.
  const problems: string[] = [];
  const { data: landed } = await db
    .from('shift_settlement_lines')
    .select('paid_seconds')
    .eq('settlement_id', settlementId)
    .is('voided_at', null);
  const landedLines = (landed ?? []) as { paid_seconds: number }[];
  if (landedLines.length !== plan.totals.paidShifts) {
    problems.push(`settlement covers ${landedLines.length} shifts, expected ${plan.totals.paidShifts}`);
  }
  const landedSeconds = landedLines.reduce((n, l) => n + l.paid_seconds, 0);
  if (landedSeconds !== plan.totals.paidSeconds) {
    problems.push(`settlement covers ${landedSeconds}s, expected ${plan.totals.paidSeconds}s`);
  }
  const after = await unpaidRemainders(JASON);
  const stillOwed = after.filter((r) => r.unpaidSeconds > 0);
  const owedSeconds = stillOwed.reduce((n, r) => n + r.unpaidSeconds, 0);
  if (owedSeconds !== unpaidSeconds) {
    problems.push(`${owedSeconds}s still owed, expected ${unpaidSeconds}s`);
  }
  console.log(`\nStill owed after import: ${stillOwed.length} shifts, ${formatSeconds(owedSeconds)}`);

  if (problems.length > 0) {
    console.error('\nFAILED — the import landed but does not match the plan:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nRun with --live --undo to remove it.`);
    process.exitCode = 1;
    return;
  }
  console.log('OK: every paid day settled, every unpaid day still owing, nothing spilled.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
