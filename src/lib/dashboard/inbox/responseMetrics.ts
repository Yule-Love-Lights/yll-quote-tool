// Pure response-time / SLA analytics (#58 Phase 2). Measures the #1 pain —
// "replying too late" — over inbox items. Response time = handled_at −
// last_message_at (how long a customer waited). SLA hit-rates reuse the
// escalation thresholds (within 1h / within 4h). Pure — the store fetches rows.

import { ESCALATION } from './escalation';

export type MetricItem = {
  status: string;
  lastMessageAt: Date | null;
  handledAt: Date | null;
  handledBy: string | null;
  source: string;
};

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
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function computeResponseMetrics(items: MetricItem[], now: Date): ResponseMetrics {
  const handledItems = items.filter((i) => i.status === 'handled' && i.lastMessageAt && i.handledAt);
  const openItems = items.filter((i) => i.status === 'unresponded');

  // Clamp to 0: an outbound that predates the last inbound shouldn't read negative.
  const responseFor = (i: MetricItem) =>
    Math.max(0, (i.handledAt as Date).getTime() - (i.lastMessageAt as Date).getTime());
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
  };
}
