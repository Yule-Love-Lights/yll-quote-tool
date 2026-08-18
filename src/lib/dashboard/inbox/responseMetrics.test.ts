import { describe, it, expect } from 'vitest';
import {
  computeResponseMetrics,
  bucketOfResponse,
  filterByWindow,
  computeTrend,
  reopenRate,
  computeResponseAnalytics,
  withOperatorLabels,
} from './responseMetrics';
import type { MetricItem } from './responseMetrics';

const MIN = 60_000;
const T = new Date('2026-06-28T18:00:00Z');
const ago = (ms: number) => new Date(T.getTime() - ms);

function handled(responseMin: number, rep: string | null, lastAgoMin = 600): MetricItem {
  const lastMessageAt = ago(lastAgoMin * MIN);
  return {
    status: 'handled',
    lastMessageAt,
    handledAt: new Date(lastMessageAt.getTime() + responseMin * MIN),
    handledBy: rep,
    source: 'ghl',
    createdAt: lastMessageAt,
  };
}
function open(ageMin: number): MetricItem {
  return {
    status: 'unresponded',
    lastMessageAt: ago(ageMin * MIN),
    handledAt: null,
    handledBy: null,
    source: 'ghl',
    createdAt: ago(ageMin * MIN),
  };
}

describe('computeResponseMetrics — empty', () => {
  it('reports zeros and null medians', () => {
    const m = computeResponseMetrics([], T);
    expect(m.handled).toBe(0);
    expect(m.open).toBe(0);
    expect(m.overdue).toBe(0);
    expect(m.medianResponseMs).toBeNull();
    expect(m.avgResponseMs).toBeNull();
  });
});

describe('computeResponseMetrics — response times + SLA', () => {
  const items = [handled(30, 'rep-A'), handled(300, 'rep-A'), handled(90, 'rep-B'), open(120), open(360)];
  const m = computeResponseMetrics(items, T);

  it('counts handled vs open', () => {
    expect(m.handled).toBe(3);
    expect(m.open).toBe(2);
  });
  it('flags open items older than the red (4h) threshold as overdue', () => {
    expect(m.overdue).toBe(1); // the 360-min-old open item
  });
  it('computes median + average response time across handled items', () => {
    expect(m.medianResponseMs).toBe(90 * MIN); // [30,90,300] → 90
    expect(m.avgResponseMs).toBe(140 * MIN); // (30+90+300)/3
  });
  it('computes SLA hit-rates (within 1h / within 4h) of handled items', () => {
    expect(m.withinOneHourPct).toBeCloseTo(1 / 3, 5); // only the 30-min one
    expect(m.withinFourHoursPct).toBeCloseTo(2 / 3, 5); // 30 + 90
  });
  it('breaks response time down by rep', () => {
    const a = m.byRep.find((r) => r.rep === 'rep-A');
    const b = m.byRep.find((r) => r.rep === 'rep-B');
    expect(a?.handled).toBe(2);
    expect(a?.medianResponseMs).toBe(165 * MIN); // median([30,300]) = (30+300)/2
    expect(b?.handled).toBe(1);
    expect(b?.medianResponseMs).toBe(90 * MIN);
  });
});

describe('computeResponseMetrics — clamps negative response times', () => {
  it('treats a handledAt before lastMessageAt as 0 (never negative)', () => {
    const weird: MetricItem = {
      status: 'handled',
      lastMessageAt: T,
      handledAt: ago(60 * MIN), // before the message — clamp to 0
      handledBy: 'rep-A',
      source: 'gmail',
      createdAt: T,
    };
    const m = computeResponseMetrics([weird], T);
    expect(m.medianResponseMs).toBe(0);
  });
});

describe('computeResponseMetrics — measures from last_inbound_at, not last_message_at (#110 W7-003)', () => {
  it('uses the customer inbound time even when last_message_at was overwritten by our outbound reply', () => {
    // Customer messaged 3h ago; we replied via the GHL app just now, and the
    // reconcile overwrote last_message_at with our outbound's ~now timestamp.
    const inbound = ago(180 * MIN);
    const item: MetricItem = {
      status: 'handled',
      lastMessageAt: ago(1 * MIN), // corrupted: our outbound reply's time
      lastInboundAt: inbound, // the real customer message time
      handledAt: T,
      handledBy: 'rep-A',
      source: 'ghl',
      createdAt: inbound,
    };
    const m = computeResponseMetrics([item], T);
    expect(m.medianResponseMs).toBe(180 * MIN); // 3h wait, NOT ~1min
  });

  it('falls back to last_message_at when last_inbound_at is absent (legacy rows)', () => {
    const item: MetricItem = {
      status: 'handled',
      lastMessageAt: ago(120 * MIN),
      lastInboundAt: null,
      handledAt: T,
      handledBy: 'rep-A',
      source: 'ghl',
      createdAt: ago(120 * MIN),
    };
    const m = computeResponseMetrics([item], T);
    expect(m.medianResponseMs).toBe(120 * MIN);
  });
});

// #252 slice F fix round (HIGH, admin lens): an item CREATED directly by an
// outbound touch (a cold-outbound GHL call, #252 slice F, or a #222 fast-sent
// quote) never had a real inbound leg — last_inbound_at was never written —
// but the legacy fallback above would otherwise hand it a fabricated
// near-zero response time. Distinguished from a genuine legacy row by
// direction (see hadNoInboundLeg's doc in responseMetrics.ts).
describe('computeResponseMetrics — excludes outbound-born items with no inbound leg (#252 slice F fix round, HIGH)', () => {
  it('excludes a handled item created by an outbound touch (direction=outbound, lastInboundAt never set) from handled count, median, and buckets', () => {
    const outboundBorn: MetricItem = {
      status: 'handled',
      direction: 'outbound',
      lastMessageAt: T,
      lastInboundAt: null,
      handledAt: T, // auto-resolved at ingest — same instant as lastMessageAt
      handledBy: null, // system auto-resolve, per store.ts's autoResolved path
      source: 'ghl',
      createdAt: T,
    };
    const m = computeResponseMetrics([outboundBorn], T);
    expect(m.handled).toBe(0);
    expect(m.medianResponseMs).toBeNull();
    expect(m.avgResponseMs).toBeNull();
    expect(m.buckets.reduce((s, b) => s + b.count, 0)).toBe(0);
  });

  it('does NOT exclude a legacy row with a real (but unrecorded) inbound leg — inbound direction, or direction omitted entirely, both stay included via the fallback', () => {
    const legacyInboundDirection: MetricItem = {
      status: 'handled',
      direction: 'inbound', // last real touch on record was the customer's
      lastMessageAt: ago(120 * MIN),
      lastInboundAt: null,
      handledAt: T,
      handledBy: 'rep-A',
      source: 'ghl',
      createdAt: ago(120 * MIN),
    };
    const legacyNoDirection: MetricItem = {
      status: 'handled',
      // direction omitted — rows fetched before this fix round never populated it
      lastMessageAt: ago(90 * MIN),
      lastInboundAt: null,
      handledAt: T,
      handledBy: 'rep-A',
      source: 'gmail',
      createdAt: ago(90 * MIN),
    };
    const m = computeResponseMetrics([legacyInboundDirection, legacyNoDirection], T);
    expect(m.handled).toBe(2);
    expect(m.medianResponseMs).toBe(105 * MIN); // median([120, 90]) = 105
  });
});

// ─── Task 1: buckets + window filter + extended computeResponseMetrics ───────

const T2 = new Date('2026-06-30T12:00:00Z');
const agoMs = (ms: number) => new Date(T2.getTime() - ms);
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('bucketOfResponse', () => {
  it('maps durations to the right bucket key', () => {
    expect(bucketOfResponse(10 * MIN)).toBe('15m');
    expect(bucketOfResponse(45 * MIN)).toBe('1h');
    expect(bucketOfResponse(3 * HOUR)).toBe('4h');
    expect(bucketOfResponse(20 * HOUR)).toBe('1d');
    expect(bucketOfResponse(2 * DAY)).toBe('3d');
    expect(bucketOfResponse(6 * DAY)).toBe('1w');
    expect(bucketOfResponse(10 * DAY)).toBe('over');
  });
});

describe('filterByWindow', () => {
  const items: MetricItem[] = [
    {
      status: 'handled',
      lastMessageAt: agoMs(2 * DAY),
      handledAt: agoMs(2 * DAY),
      handledBy: 'a',
      source: 'ghl',
      createdAt: agoMs(2 * DAY),
    },
    {
      status: 'handled',
      lastMessageAt: agoMs(40 * DAY),
      handledAt: agoMs(40 * DAY),
      handledBy: 'a',
      source: 'ghl',
      createdAt: agoMs(40 * DAY),
    },
  ];
  it('null=all; 30d drops the 40-day item; 90d keeps both', () => {
    expect(filterByWindow(items, null, T2)).toHaveLength(2);
    expect(filterByWindow(items, 30, T2)).toHaveLength(1);
    expect(filterByWindow(items, 90, T2)).toHaveLength(2);
  });
});

describe('computeResponseMetrics — buckets + time-to-completed', () => {
  const items: MetricItem[] = [
    {
      status: 'handled',
      lastMessageAt: agoMs(3 * HOUR),
      handledAt: agoMs(2 * HOUR),
      handledBy: 'a',
      source: 'ghl',
      createdAt: agoMs(5 * HOUR),
    },
    {
      status: 'completed',
      lastMessageAt: agoMs(5 * DAY),
      handledAt: agoMs(1 * DAY),
      handledBy: 'a',
      source: 'ghl',
      createdAt: agoMs(3 * DAY),
    },
  ];
  it('bucket distribution over handled responses', () => {
    const m = computeResponseMetrics(items, T2);
    expect(m.buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
    expect(m.buckets.find((b) => b.key === '1h')?.count).toBe(1);
  });
  it('median time-to-completed for completed items', () => {
    expect(computeResponseMetrics(items, T2).timeToCompletedMedianMs).toBe(2 * DAY);
  });
});

// ─── Task 2: trend + reopen rate + computeResponseAnalytics ─────────────────

describe('computeTrend', () => {
  it('this-week median + direction', () => {
    const items: MetricItem[] = [
      {
        status: 'handled',
        lastMessageAt: agoMs(2 * DAY),
        handledAt: new Date(agoMs(2 * DAY).getTime() + HOUR),
        handledBy: 'a',
        source: 'ghl',
        createdAt: agoMs(2 * DAY),
      },
    ];
    const t = computeTrend(items, T2);
    expect(t.thisWeekMs).toBe(HOUR);
    expect(['faster', 'slower', 'flat', 'na']).toContain(t.direction);
  });

  it('measures from last_inbound_at, not last_message_at, when a reply was sent outside the inbox (#WT-42)', () => {
    // Customer messaged 3 days ago; the reply went out via the GHL app (not the
    // inbox UI), so the reconcile overwrote last_message_at with the outbound's
    // ~now timestamp. last_inbound_at still holds the real customer message time.
    const handledAt = agoMs(2 * DAY);
    const realInbound = new Date(handledAt.getTime() - 3 * DAY);
    const items: MetricItem[] = [
      {
        status: 'handled',
        lastMessageAt: new Date(handledAt.getTime() - 1 * MIN), // corrupted
        lastInboundAt: realInbound, // the real customer message time
        handledAt,
        handledBy: 'a',
        source: 'ghl',
        createdAt: realInbound,
      },
    ];
    const t = computeTrend(items, T2);
    expect(t.thisWeekMs).toBe(3 * DAY); // the real wait, NOT ~1 min
  });

  // #252 slice F fix round (HIGH): medianResponseIn's population is WIDER than
  // handledItems' (completed/dismissed too, not just handled) — same
  // hadNoInboundLeg exclusion, but here direction genuinely can be 'inbound'
  // on a legitimate row (an operator closing an item without ever replying),
  // so the pin below matters more here than in computeResponseMetrics.
  it('excludes an outbound-born item (no lastInboundAt) from the trend even though it falls in the window', () => {
    const outboundBorn: MetricItem = {
      status: 'handled',
      direction: 'outbound',
      lastMessageAt: agoMs(2 * DAY),
      lastInboundAt: null,
      handledAt: agoMs(2 * DAY),
      handledBy: null,
      source: 'ghl',
      createdAt: agoMs(2 * DAY),
    };
    const t = computeTrend([outboundBorn], T2);
    expect(t.thisWeekMs).toBeNull();
  });

  it('still measures a legacy completed row with inbound direction and a lost lastInboundAt — direction alone must not over-exclude', () => {
    const legacy: MetricItem = {
      status: 'completed',
      direction: 'inbound', // last real touch on record was the customer's
      lastMessageAt: agoMs(2 * DAY + 30 * MIN),
      lastInboundAt: null,
      handledAt: agoMs(2 * DAY),
      handledBy: 'a',
      source: 'ghl',
      createdAt: agoMs(2 * DAY + 30 * MIN),
    };
    const t = computeTrend([legacy], T2);
    expect(t.thisWeekMs).toBe(30 * MIN); // NOT excluded — falls back to lastMessageAt
  });
});

describe('reopenRate', () => {
  it('ratio capped at 1, null when no handled', () => {
    expect(reopenRate(10, 3)).toBeCloseTo(0.3);
    expect(reopenRate(0, 0)).toBeNull();
    expect(reopenRate(2, 5)).toBe(1);
  });
});

describe('computeResponseAnalytics', () => {
  it('assembles three windows + trend + reopen', () => {
    const items: MetricItem[] = [
      {
        status: 'handled',
        lastMessageAt: agoMs(2 * DAY),
        handledAt: agoMs(2 * DAY),
        handledBy: 'a',
        source: 'ghl',
        createdAt: agoMs(2 * DAY),
      },
      {
        status: 'handled',
        lastMessageAt: agoMs(45 * DAY),
        handledAt: agoMs(45 * DAY),
        handledBy: 'a',
        source: 'ghl',
        createdAt: agoMs(45 * DAY),
      },
    ];
    const reopen = {
      all: { handled: 10, reopened: 2 },
      '90': { handled: 8, reopened: 1 },
      '30': { handled: 5, reopened: 0 },
    };
    const a = computeResponseAnalytics(items, reopen, T2, false);
    expect(a.windows.all.handled).toBe(2);
    expect(a.windows['30'].handled).toBe(1);
    expect(a.reopen.all).toBeCloseTo(0.2);
    expect(a.reopen['30']).toBe(0);
  });
});

// PS-E1: byRep.rep is stamped as the raw operator UUID (handled_by is an
// auth.users FK — see migrations/2026-06-28-dashboard-tables.sql), so it must be
// relabeled to something readable before it reaches the UI.
describe('withOperatorLabels', () => {
  const items: MetricItem[] = [handled(30, 'uuid-jason'), handled(90, 'uuid-naldo'), handled(15, 'system')];

  it('replaces a known operator id with its display label in every window', () => {
    const a = computeResponseAnalytics(items, { all: { handled: 0, reopened: 0 }, '90': { handled: 0, reopened: 0 }, '30': { handled: 0, reopened: 0 } }, T, false);
    const labels = new Map([
      ['uuid-jason', 'Jason'],
      ['uuid-naldo', 'Naldo'],
    ]);
    const out = withOperatorLabels(a, labels);
    const reps = out.windows.all.byRep.map((r) => r.rep).sort();
    expect(reps).toEqual(['Jason', 'Naldo', 'system'].sort());
    // Applied consistently to every window, not just 'all'.
    expect(out.windows['30'].byRep.map((r) => r.rep).sort()).toEqual(['Jason', 'Naldo', 'system'].sort());
  });

  it('leaves an unknown id as-is (no label found) and never relabels "system"', () => {
    const a = computeResponseAnalytics(items, { all: { handled: 0, reopened: 0 }, '90': { handled: 0, reopened: 0 }, '30': { handled: 0, reopened: 0 } }, T, false);
    const out = withOperatorLabels(a, new Map()); // empty map — e.g. the admin API failed
    const reps = out.windows.all.byRep.map((r) => r.rep).sort();
    expect(reps).toEqual(['system', 'uuid-jason', 'uuid-naldo'].sort());
  });
});
