// Pure response-time / SLA analytics (#58 Phase 2). Measures the #1 pain —
// "replying too late" — over inbox items. Response time = handled_at −
// last_inbound_at (how long the CUSTOMER waited, from their last inbound message
// to when we handled it). SLA hit-rates reuse the escalation thresholds (within
// 1h / within 4h). Pure — the store fetches rows.
//
// #110 W7-003: this used last_message_at, which the reconcile overwrites with our
// OWN outbound reply's timestamp — so the delta collapsed to ~1 min for any reply
// sent outside the inbox UI. last_inbound_at is stamped only on inbound touches,
// so it survives that overwrite. Pre-migration rows fall back to last_message_at.

import { ESCALATION } from './escalation';

export type MetricItem = {
  status: string;
  lastMessageAt: Date | null;
  /** #110 W7-003: the customer's last INBOUND message time. Optional/null on
   *  legacy rows (before the column existed) → responseFor falls back to
   *  lastMessageAt, so existing callers/tests are unaffected. */
  lastInboundAt?: Date | null;
  handledAt: Date | null;
  handledBy: string | null;
  source: string;
  createdAt: Date | null;
};

// ─── Bucket definitions ───────────────────────────────────────────────────────

export const RESPONSE_BUCKETS = [
  { key: '15m', label: '≤15 min', maxMs: 15 * 60_000 },
  { key: '1h', label: '≤1 hr', maxMs: 60 * 60_000 },
  { key: '4h', label: '≤4 hr', maxMs: 4 * 60 * 60_000 },
  { key: '1d', label: '≤1 day', maxMs: 24 * 60 * 60_000 },
  { key: '3d', label: '≤3 days', maxMs: 3 * 24 * 60 * 60_000 },
  { key: '1w', label: '≤1 week', maxMs: 7 * 24 * 60 * 60_000 },
  { key: 'over', label: '>1 week', maxMs: Infinity },
] as const;

export type ResponseBucketKey = (typeof RESPONSE_BUCKETS)[number]['key'];
export type BucketSlice = { key: ResponseBucketKey; label: string; count: number; pct: number | null };

export function bucketOfResponse(ms: number): ResponseBucketKey {
  return (RESPONSE_BUCKETS.find((b) => ms <= b.maxMs) ?? RESPONSE_BUCKETS[RESPONSE_BUCKETS.length - 1]).key;
}

function distribution(durations: number[]): BucketSlice[] {
  const counts = new Map<ResponseBucketKey, number>();
  for (const d of durations) {
    const k = bucketOfResponse(d);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = durations.length;
  return RESPONSE_BUCKETS.map((b) => {
    const count = counts.get(b.key) ?? 0;
    return { key: b.key, label: b.label, count, pct: total ? count / total : null };
  });
}

// ─── Core types ───────────────────────────────────────────────────────────────

export type ResponseMetrics = {
  handled: number;
  open: number;
  overdue: number; // open items older than the red (4h) threshold right now
  medianResponseMs: number | null;
  avgResponseMs: number | null;
  withinOneHourPct: number | null; // share of handled answered within 1h
  withinFourHoursPct: number | null;
  byRep: Array<{ rep: string; handled: number; medianResponseMs: number | null }>;
  bySource: Array<{ source: string; total: number }>;
  buckets: BucketSlice[];
  completedBuckets: BucketSlice[];
  timeToCompletedMedianMs: number | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function filterByWindow(items: MetricItem[], days: number | null, now: Date): MetricItem[] {
  if (days == null) return items;
  const cutoff = now.getTime() - days * 86_400_000;
  return items.filter((i) => {
    const t = i.handledAt ?? i.lastMessageAt;
    return t != null && t.getTime() >= cutoff;
  });
}

// ─── Main compute ─────────────────────────────────────────────────────────────

export function computeResponseMetrics(items: MetricItem[], now: Date): ResponseMetrics {
  // #110 W7-003: measure from the customer's last INBOUND (falls back to
  // last_message_at on legacy rows that predate the last_inbound_at column).
  const inboundOf = (i: MetricItem) => i.lastInboundAt ?? i.lastMessageAt;
  const handledItems = items.filter((i) => i.status === 'handled' && inboundOf(i) && i.handledAt);
  const openItems = items.filter((i) => i.status === 'unresponded');

  // Clamp to 0: an outbound that predates the last inbound shouldn't read negative.
  const responseFor = (i: MetricItem) =>
    Math.max(0, (i.handledAt as Date).getTime() - (inboundOf(i) as Date).getTime());
  const responses = handledItems.map(responseFor);

  const within = (limit: number) =>
    responses.length ? responses.filter((r) => r <= limit).length / responses.length : null;

  const repMap = new Map<string, number[]>();
  for (const i of handledItems) {
    const rep = i.handledBy ?? 'system';
    const arr = repMap.get(rep) ?? [];
    arr.push(responseFor(i));
    repMap.set(rep, arr);
  }
  const byRep = [...repMap.entries()].map(([rep, rs]) => ({ rep, handled: rs.length, medianResponseMs: median(rs) }));

  const srcMap = new Map<string, number>();
  for (const i of items) srcMap.set(i.source, (srcMap.get(i.source) ?? 0) + 1);
  const bySource = [...srcMap.entries()].map(([source, total]) => ({ source, total }));

  const overdue = openItems.filter(
    (i) => i.lastMessageAt && now.getTime() - i.lastMessageAt.getTime() >= ESCALATION.redAfterMs,
  ).length;

  // Bucket distribution over handled response times
  const buckets = distribution(responses);

  // Time-to-completed: createdAt → handledAt for completed items
  const completedItems = items.filter((i) => i.status === 'completed' && i.createdAt && i.handledAt);
  const completedTimes = completedItems.map((i) =>
    Math.max(0, (i.handledAt as Date).getTime() - (i.createdAt as Date).getTime()),
  );
  const completedBuckets = distribution(completedTimes);

  return {
    handled: handledItems.length,
    open: openItems.length,
    overdue,
    medianResponseMs: median(responses),
    avgResponseMs: responses.length ? responses.reduce((a, b) => a + b, 0) / responses.length : null,
    withinOneHourPct: within(ESCALATION.amberAfterMs),
    withinFourHoursPct: within(ESCALATION.redAfterMs),
    byRep,
    bySource,
    buckets,
    completedBuckets,
    timeToCompletedMedianMs: median(completedTimes),
  };
}

// ─── Task 2: Trend + reopen rate + analytics assembler ───────────────────────

export type TrendDirection = 'faster' | 'slower' | 'flat' | 'na';
export type Trend = {
  thisWeekMs: number | null;
  lastWeekMs: number | null;
  thisMonthMs: number | null;
  direction: TrendDirection;
};

function medianResponseIn(items: MetricItem[], startMs: number, endMs: number): number | null {
  // #WT-42: same last_inbound_at fallback as computeResponseMetrics — otherwise
  // the trend arrow can flip based on replies sent outside the inbox UI, which
  // overwrite last_message_at and contradict the headline median right next to it.
  const inboundOf = (i: MetricItem) => i.lastInboundAt ?? i.lastMessageAt;
  const rs = items
    .filter(
      (i) =>
        i.status !== 'unresponded' &&
        inboundOf(i) &&
        i.handledAt &&
        (i.handledAt as Date).getTime() >= startMs &&
        (i.handledAt as Date).getTime() < endMs,
    )
    .map((i) => Math.max(0, (i.handledAt as Date).getTime() - (inboundOf(i) as Date).getTime()));
  return median(rs);
}

export function computeTrend(items: MetricItem[], now: Date): Trend {
  const n = now.getTime();
  const D = 86_400_000;
  const thisWeekMs = medianResponseIn(items, n - 7 * D, n + D);
  const lastWeekMs = medianResponseIn(items, n - 14 * D, n - 7 * D);
  const thisMonthMs = medianResponseIn(items, n - 30 * D, n + D);
  let direction: TrendDirection = 'na';
  if (thisWeekMs != null && lastWeekMs != null) {
    direction = thisWeekMs < lastWeekMs ? 'faster' : thisWeekMs > lastWeekMs ? 'slower' : 'flat';
  }
  return { thisWeekMs, lastWeekMs, thisMonthMs, direction };
}

export function reopenRate(handled: number, reopened: number): number | null {
  if (handled <= 0) return null;
  return Math.min(1, reopened / handled);
}

export type WindowKey = 'all' | '90' | '30';
export type ReopenCounts = Record<WindowKey, { handled: number; reopened: number }>;
export type ResponseAnalyticsData = {
  windows: Record<WindowKey, ResponseMetrics>;
  trend: Trend;
  reopen: Record<WindowKey, number | null>;
  truncated: boolean;
};

export function computeResponseAnalytics(
  items: MetricItem[],
  reopen: ReopenCounts,
  now: Date,
  truncated: boolean,
): ResponseAnalyticsData {
  const windowDays: Record<WindowKey, number | null> = { all: null, '90': 90, '30': 30 };
  const windows = {} as Record<WindowKey, ResponseMetrics>;
  const reopenRates = {} as Record<WindowKey, number | null>;
  for (const k of ['all', '90', '30'] as WindowKey[]) {
    windows[k] = computeResponseMetrics(filterByWindow(items, windowDays[k], now), now);
    reopenRates[k] = reopenRate(reopen[k].handled, reopen[k].reopened);
  }
  return { windows, trend: computeTrend(items, now), reopen: reopenRates, truncated };
}
