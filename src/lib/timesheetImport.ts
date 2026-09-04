/**
 * Reading Jason's pre-tool time spreadsheet — ledger row 507.
 *
 * PURE. No file I/O and no database: the caller hands in rows already read out
 * of the workbook, and this decides what they MEAN. That split is deliberate —
 * the meaning is the part worth testing, and it is testable only if reading an
 * .xlsx is somebody else's job.
 *
 * WHY THE .XLSX AND NOT A CSV. Cell COLOUR carries information nothing else in
 * the sheet records:
 *
 *   * green fill on the Hours cell  = these hours were already PAID
 *   * no fill                        = still owed
 *   * yellow fill on the Date cell   = the first day of a new pay rate
 *
 * A CSV export drops all three. The paid/unpaid state has no other
 * representation anywhere, so exporting to CSV would silently turn a year of
 * settled history into a year of outstanding wages.
 *
 * WHAT THE SHEET DOES NOT HAVE, and what this does about it:
 *
 *   * NO START TIME. Every row is a date and a duration. A shift needs a
 *     clock-in and a clock-out, so imported shifts are anchored at a fixed
 *     ET hour and run for the recorded duration. The DAY and the DURATION are
 *     real; the clock times are a placeholder and are marked as such by the
 *     `manual_by` stamp on every row. The anchor is late enough that no
 *     duration in the file crosses midnight (the longest is 11h 19m).
 *   * NO PAYMENT AMOUNT OR METHOD for the paid days. That is the caller's
 *     problem, not this file's: see `paidValueCents` for what those hours are
 *     worth, and the import script for how it is recorded honestly.
 */

/** One row of the `Time Log` tab, already read out of the workbook. */
export type TimesheetRow = {
  /** 1-based worksheet row, carried so a refusal can name the cell. */
  sheetRow: number;
  /** The date cell, as an ET calendar day `YYYY-MM-DD`. */
  day: string;
  /** The Duration cell in whole seconds. */
  durationSeconds: number;
  /** Green fill on the Hours cell. */
  paid: boolean;
  /** Yellow fill on the Date cell — the first day of a new pay rate. */
  rateBoundary: boolean;
};

export type ImportShift = {
  sheetRow: number;
  day: string;
  durationSeconds: number;
  paid: boolean;
  /** ISO instants for the shift, anchored (see ANCHOR_ET_HOUR). */
  clockInAt: string;
  clockOutAt: string;
};

export type ImportPlan = {
  shifts: ImportShift[];
  /** Rows deliberately not imported, each with the reason, so a skipped row is
   * always accounted for rather than silently missing. */
  skipped: { sheetRow: number; day: string; reason: string }[];
  /** The days the sheet marks as a rate change, for cross-checking against the
   * rate history that must already exist (row 506 ships before this one). */
  rateBoundaries: string[];
  totals: {
    rows: number;
    imported: number;
    paidShifts: number;
    unpaidShifts: number;
    paidSeconds: number;
    unpaidSeconds: number;
  };
};

/**
 * The ET hour imported shifts start at.
 *
 * 09:00 rather than 00:00 for two reasons: a shift starting at midnight is
 * ambiguous about which day it belongs to under every reader in this codebase,
 * and a mid-morning start is a plausible-looking placeholder rather than one
 * that reads like real data. The longest duration in the file is 11h 19m, so
 * 09:00 + duration never reaches midnight and no imported shift is ever
 * bucketed into the following day.
 */
export const ANCHOR_ET_HOUR = 9;

/** Longest duration this anchor can take without crossing midnight ET. */
export const MAX_SAFE_DURATION_SECONDS = (24 - ANCHOR_ET_HOUR) * 3600;

/** `YYYY-MM-DD`, and a real calendar day. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * The UTC offset of America/New_York on a given ET day, in minutes.
 *
 * Derived from Intl rather than from a hard-coded -4/-5, so the DST
 * transitions inside this file's range (it spans two springs and two autumns)
 * are handled by the same tz database everything else here uses. A shift
 * imported on the wrong side of a transition would land an hour out and,
 * worse, could bucket into the neighbouring day.
 */
function etOffsetMinutes(day: string, hour: number): number {
  const [y, m, d] = day.split('-').map(Number);
  // Guess UTC, read back what New York calls that instant, and take the gap.
  const guess = Date.UTC(y, m - 1, d, hour);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asEt = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return (guess - asEt) / 60000;
}

/** The instant a given ET wall-clock time on a given ET day corresponds to. */
export function etInstant(day: string, hour: number, extraSeconds = 0): string {
  const [y, m, d] = day.split('-').map(Number);
  const offset = etOffsetMinutes(day, hour);
  const ms = Date.UTC(y, m - 1, d, hour) + offset * 60000 + extraSeconds * 1000;
  return new Date(ms).toISOString();
}

/**
 * PURE. Turn the sheet's rows into the shifts to create, and account for every
 * row that is not becoming one.
 *
 * REFUSALS ARE SKIPS, not throws, and every skip carries a reason. A row this
 * cannot import is a fact about the spreadsheet that a person needs to read,
 * and aborting the whole import over one odd row would make a 143-row file
 * impossible to load because of a single blank line.
 */
export function planImport(rows: readonly TimesheetRow[]): ImportPlan {
  const shifts: ImportShift[] = [];
  const skipped: ImportPlan['skipped'] = [];
  const rateBoundaries: string[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    if (row.rateBoundary) rateBoundaries.push(row.day);

    if (!isDay(row.day)) {
      skipped.push({ sheetRow: row.sheetRow, day: String(row.day), reason: 'not a real calendar day' });
      continue;
    }
    if (!Number.isFinite(row.durationSeconds) || row.durationSeconds <= 0) {
      // The last row of a live sheet is usually today, still being worked and
      // recorded as zero. Importing it would create a shift of no length.
      skipped.push({ sheetRow: row.sheetRow, day: row.day, reason: 'no duration recorded' });
      continue;
    }
    if (row.durationSeconds > MAX_SAFE_DURATION_SECONDS) {
      // Refused rather than truncated or shifted: a duration this long cannot
      // be anchored without crossing midnight, and quietly moving it to the
      // next day would put those hours on the wrong day AND possibly the wrong
      // pay rate.
      skipped.push({
        sheetRow: row.sheetRow,
        day: row.day,
        reason: `duration ${(row.durationSeconds / 3600).toFixed(2)}h will not fit after ${ANCHOR_ET_HOUR}:00 ET without crossing midnight`,
      });
      continue;
    }
    const already = seen.get(row.day);
    if (already !== undefined) {
      // The clock ledger allows several shifts a day, but this sheet is one
      // row per day; two rows for one day means the file has a duplicate, and
      // guessing which is right is not this code's call.
      skipped.push({
        sheetRow: row.sheetRow,
        day: row.day,
        reason: `duplicate of sheet row ${already}`,
      });
      continue;
    }
    seen.set(row.day, row.sheetRow);

    const seconds = Math.round(row.durationSeconds);
    shifts.push({
      sheetRow: row.sheetRow,
      day: row.day,
      durationSeconds: seconds,
      paid: row.paid,
      clockInAt: etInstant(row.day, ANCHOR_ET_HOUR),
      clockOutAt: etInstant(row.day, ANCHOR_ET_HOUR, seconds),
    });
  }

  const paid = shifts.filter((s) => s.paid);
  const unpaid = shifts.filter((s) => !s.paid);
  const sum = (xs: ImportShift[]) => xs.reduce((n, s) => n + s.durationSeconds, 0);

  return {
    shifts,
    skipped,
    rateBoundaries,
    totals: {
      rows: rows.length,
      imported: shifts.length,
      paidShifts: paid.length,
      unpaidShifts: unpaid.length,
      paidSeconds: sum(paid),
      unpaidSeconds: sum(unpaid),
    },
  };
}

/**
 * PURE. What the ALREADY-PAID rows come to, each at the rate in force on its
 * own day — and which of them could not be valued at all.
 *
 * Rounded PER SHIFT and then summed, matching `referenceCentsFor` exactly, so
 * the figure recorded as the historical settlement is the same figure the
 * settlement's own lines will add up to. Accumulating exactly and rounding
 * once at the end would leave the payment a cent or two away from the hours it
 * is meant to cover, and the difference spills into the first UNPAID day.
 *
 * `unratedDays` is not decoration and is why this does not simply return a
 * number. A paid day with no rate on record contributes nothing to the total,
 * so the settlement comes out smaller, so that day stays UNPAID after the
 * import — flatly contradicting the green fill it was imported from, with
 * nothing on any screen to explain it. Returning them makes the caller decide
 * (the import script refuses), instead of the shortfall being invisible.
 *
 * Found by a mutation probe: deleting the rate guard changed no result at all,
 * because skipping a day and adding zero for it come to the same total. A
 * guard whose removal changes nothing is not protecting anything.
 */
export function paidValueCents(
  shifts: readonly ImportShift[],
  rateForDay: (day: string) => number,
): { cents: number; unratedDays: string[] } {
  let cents = 0;
  const unratedDays: string[] = [];
  for (const s of shifts) {
    if (!s.paid) continue;
    const rate = rateForDay(s.day);
    if (rate <= 0) {
      unratedDays.push(s.day);
      continue;
    }
    cents += Math.round((s.durationSeconds * rate) / 3600);
  }
  return { cents, unratedDays };
}
