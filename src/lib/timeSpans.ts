/**
 * Interval arithmetic for the P4P time ledger.
 *
 * Extracted from `shiftBreaks.ts` when job segments needed the same operations.
 * Both callers feed payout math, so this is money code: the rules below are the
 * ones the S58 wrap review established, and they are stated here once instead of
 * being re-derived per caller.
 *
 * THE RULES, and why each exists:
 *
 * - Everything stays in integer MILLISECONDS until a single conversion at the
 *   end. No float hours anywhere.
 * - Overlapping spans are MERGED into their union before being summed. Summing
 *   raw spans double-counts the overlap, which underpays when the spans are
 *   unpaid breaks and overpays when they are job time.
 * - Spans are CLIPPED to the envelope they belong to, so a row that runs past
 *   clock-out cannot contribute time nobody worked.
 * - An unparseable timestamp is SKIPPED rather than propagating NaN into a
 *   paycheck.
 * - The envelope rounds UP and subtracted time rounds DOWN, so every rounding
 *   decision favors the employee AND the decomposition stays exact:
 *   `paid + subtracted === envelope`. Rounding each half independently breaks
 *   that on real millisecond timestamps (S58: a 10,700 ms envelope with a
 *   400 ms break gave 11 + 1 against an 11-second envelope).
 */

export type Span = { start: number; end: number };

/** A half-open interval as the ledger stores it. A null end means "still running". */
export type OpenInterval = { start: string; end: string | null };

export function parseMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The bounding envelope in milliseconds. A null `end` runs to `nowMs`. Returns
 * null when the start is unparseable, and a zero-length span when the end
 * precedes the start — a corrupt row must never mint negative time.
 */
export function envelopeMs(interval: OpenInterval, nowMs: number): Span | null {
  const start = parseMs(interval.start);
  if (start === null) return null;
  const end = interval.end === null ? nowMs : parseMs(interval.end);
  if (end === null) return null;
  return { start, end: Math.max(start, end) };
}

/** Spans clipped to `envelope`, sorted, and merged so overlaps count once. */
export function clipAndMerge(
  envelope: Span,
  intervals: ReadonlyArray<OpenInterval>,
  nowMs: number,
): Span[] {
  const spans: Span[] = [];

  for (const item of intervals) {
    const rawStart = parseMs(item.start);
    if (rawStart === null) continue;
    const rawEnd = item.end === null ? nowMs : parseMs(item.end);
    if (rawEnd === null) continue;

    const start = Math.max(rawStart, envelope.start);
    const end = Math.min(rawEnd, envelope.end);
    if (end > start) spans.push({ start, end });
  }

  spans.sort((a, b) => a.start - b.start);

  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    // `<=` merges touching spans too: [10:00-10:15] and [10:15-10:30] are 30
    // minutes either way, so merging them changes no total and keeps the list short.
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function totalMs(spans: ReadonlyArray<Span>): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/**
 * `minuend` minus `subtrahend`, both assumed already merged. Used for "job time
 * excluding the breaks that overlap it" — the contract's rule that a break
 * pauses job time.
 */
export function subtractSpans(
  minuend: ReadonlyArray<Span>,
  subtrahend: ReadonlyArray<Span>,
): Span[] {
  let out: Span[] = minuend.map((s) => ({ ...s }));

  for (const cut of subtrahend) {
    const next: Span[] = [];
    for (const span of out) {
      // Disjoint: keep whole.
      if (cut.end <= span.start || cut.start >= span.end) {
        next.push(span);
        continue;
      }
      // Left remainder.
      if (cut.start > span.start) next.push({ start: span.start, end: cut.start });
      // Right remainder.
      if (cut.end < span.end) next.push({ start: cut.end, end: span.end });
      // Fully covered: contributes nothing.
    }
    out = next;
  }
  return out;
}

/** Rounds UP. Used for the envelope, so the paid day is never shortened. */
export function ceilSeconds(ms: number): number {
  return Math.ceil(Math.max(0, ms) / 1000);
}

/** Rounds DOWN. Used for time subtracted from the envelope, so it is never overstated. */
export function floorSeconds(ms: number): number {
  return Math.floor(Math.max(0, ms) / 1000);
}

export function resolveNowMs(nowIso?: string): number {
  return nowIso ? (parseMs(nowIso) ?? Date.now()) : Date.now();
}
