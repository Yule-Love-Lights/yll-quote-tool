/**
 * Which sent quotes count as backlog sends, as a pure function.
 *
 * The rule lives here rather than inside scripts/mark-backlog-sends.ts so it
 * can be tested without prod credentials. It decides what leaves the homepage
 * turnaround average, so "it looked right when I ran it" is not good enough.
 *
 * A backlog send is a quote built before a cutoff AND held at least N days
 * before it was sent. Both halves matter. The cutoff is what makes this about
 * one specific batch of held work rather than a standing rule that quietly
 * excuses ordinary slowness, and the held-days floor is what stops a quote
 * built just before the cutoff and sent the next day from being swept in.
 */

const MS_PER_DAY = 86_400_000;

export type SentQuote = {
  id: string;
  created_at: string;
  quote_sent_at: string;
  backlog_send_at: string | null;
};

export type BacklogRule = {
  /** ISO date. Only quotes created strictly before this can be marked. */
  builtBefore: string;
  /** Minimum days between created_at and quote_sent_at, inclusive. */
  heldDaysMin: number;
};

export type BacklogPlan<T extends SentQuote> = {
  /** Every row matching the rule, whether or not it is already marked. */
  matches: T[];
  /** The subset with no mark yet. These are what a live run would write. */
  toWrite: T[];
  /** Matching rows that already carry a mark. Never restamped. */
  alreadyMarked: T[];
  /** Rows the rule leaves in the turnaround average. */
  keptIn: T[];
  /** Smallest held-gap among matches, null when nothing matched. */
  smallestGapMarked: number | null;
  /** Largest held-gap among the rows kept in, null when none are kept. */
  largestGapKept: number | null;
  /** Average held-gap over every row, and over the kept rows only. */
  turnaroundNow: number | null;
  turnaroundAfter: number | null;
};

export function heldDays(q: SentQuote): number {
  return (new Date(q.quote_sent_at).getTime() - new Date(q.created_at).getTime()) / MS_PER_DAY;
}

function average(ns: number[]): number | null {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

export function planBacklogSends<T extends SentQuote>(rows: T[], rule: BacklogRule): BacklogPlan<T> {
  if (!Number.isFinite(rule.heldDaysMin) || rule.heldDaysMin <= 0) {
    throw new Error('heldDaysMin must be a positive number of days.');
  }
  const cutoff = new Date(rule.builtBefore).getTime();
  if (Number.isNaN(cutoff)) {
    throw new Error(`builtBefore is not a date I can read: ${rule.builtBefore}`);
  }

  const matches = rows.filter(
    (r) => new Date(r.created_at).getTime() < cutoff && heldDays(r) >= rule.heldDaysMin,
  );
  const matchIds = new Set(matches.map((r) => r.id));
  const keptIn = rows.filter((r) => !matchIds.has(r.id));
  const markedGaps = matches.map(heldDays);
  const keptGaps = keptIn.map(heldDays);

  return {
    matches,
    toWrite: matches.filter((r) => r.backlog_send_at === null),
    alreadyMarked: matches.filter((r) => r.backlog_send_at !== null),
    keptIn,
    smallestGapMarked: markedGaps.length ? Math.min(...markedGaps) : null,
    largestGapKept: keptGaps.length ? Math.max(...keptGaps) : null,
    turnaroundNow: average(rows.map(heldDays)),
    turnaroundAfter: average(keptGaps),
  };
}
