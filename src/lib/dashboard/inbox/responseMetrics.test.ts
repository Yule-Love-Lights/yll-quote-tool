import { describe, it, expect } from 'vitest';
import { computeResponseMetrics } from './responseMetrics';
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
  };
}
function open(ageMin: number): MetricItem {
  return { status: 'unresponded', lastMessageAt: ago(ageMin * MIN), handledAt: null, handledBy: null, source: 'ghl' };
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
    };
    const m = computeResponseMetrics([weird], T);
    expect(m.medianResponseMs).toBe(0);
  });
});
