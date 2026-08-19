import { describe, expect, it } from 'vitest';

import { computeDayCapacity, isCalendarDate, type ScheduledJob } from './scheduling';

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  jobId: 'j1',
  jobNumber: 1001,
  status: 'scheduled',
  budgetedHours: 8,
  hoursArePlaceholder: false,
  crewMemberIds: ['a'],
  ...over,
});

describe('isCalendarDate', () => {
  it('accepts real calendar dates', () => {
    expect(isCalendarDate('2026-08-18')).toBe(true);
    expect(isCalendarDate('2026-02-28')).toBe(true);
  });

  it('rejects malformed or impossible dates', () => {
    for (const v of ['2026-8-18', '18-08-2026', '2026-13-01', '2026-02-30', '', 'today']) {
      expect(isCalendarDate(v)).toBe(false);
    }
  });
});

describe('computeDayCapacity — the derivation the plan insists be stated', () => {
  it('splits a job evenly across the crew assigned to it', () => {
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: 12, crewMemberIds: ['a', 'b', 'c'] }),
    ]);
    expect(cap.perCrew).toEqual({ a: 4, b: 4, c: 4 });
    expect(cap.unassignedHours).toBe(0);
  });

  it('adds up across several jobs for the same person', () => {
    const cap = computeDayCapacity('2026-08-18', [
      job({ jobId: 'j1', budgetedHours: 8, crewMemberIds: ['a', 'b'] }),
      job({ jobId: 'j2', budgetedHours: 6, crewMemberIds: ['a'] }),
    ]);
    expect(cap.perCrew.a).toBe(10); // 4 + 6
    expect(cap.perCrew.b).toBe(4);
  });

  it('reports a job with NOBODY assigned as unassigned load, not as zero', () => {
    // A day with 40 unassigned hours is not an empty day, and this is the whole
    // reason unassignedHours is its own number.
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: 40, crewMemberIds: [] }),
    ]);
    expect(cap.perCrew).toEqual({});
    expect(cap.unassignedHours).toBe(40);
  });

  it('counts jobs with NO estimate rather than treating them as zero hours', () => {
    // A day full of unestimated jobs must not look free.
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: null, crewMemberIds: ['a'] }),
      job({ jobId: 'j2', budgetedHours: null, crewMemberIds: [] }),
    ]);
    expect(cap.jobsWithoutEstimate).toBe(2);
    expect(cap.perCrew).toEqual({});
    expect(cap.unassignedHours).toBe(0);
  });

  it('flags when ANY contributing job used placeholder rates', () => {
    // The guardrail reaching its first real consumer: the number is still shown
    // (it is the best planning shape available) but never as a real one.
    const clean = computeDayCapacity('2026-08-18', [job({ hoursArePlaceholder: false })]);
    expect(clean.anyPlaceholderHours).toBe(false);

    const tainted = computeDayCapacity('2026-08-18', [
      job({ hoursArePlaceholder: false }),
      job({ jobId: 'j2', hoursArePlaceholder: true }),
    ]);
    expect(tainted.anyPlaceholderHours).toBe(true);
  });

  it('does not flag placeholder for a job that has no estimate at all', () => {
    // No number means nothing to mistrust; that is jobsWithoutEstimate's job.
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: null, hoursArePlaceholder: true }),
    ]);
    expect(cap.anyPlaceholderHours).toBe(false);
    expect(cap.jobsWithoutEstimate).toBe(1);
  });

  it('handles an empty day', () => {
    const cap = computeDayCapacity('2026-08-18', []);
    expect(cap).toEqual({
      date: '2026-08-18',
      perCrew: {},
      unassignedHours: 0,
      jobsWithoutEstimate: 0,
      anyPlaceholderHours: false,
    });
  });

  it('keeps fractional shares rather than rounding a planning figure', () => {
    // Planning stays float on purpose. Payout math lives elsewhere and stays in
    // integer seconds; mixing the two is how an estimate becomes a pay input.
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: 10, crewMemberIds: ['a', 'b', 'c'] }),
    ]);
    expect(cap.perCrew.a).toBeCloseTo(3.3333, 3);
  });

  it('the parts account for the whole day of estimated work', () => {
    const jobs = [
      job({ jobId: 'j1', budgetedHours: 12, crewMemberIds: ['a', 'b'] }),
      job({ jobId: 'j2', budgetedHours: 5, crewMemberIds: [] }),
    ];
    const cap = computeDayCapacity('2026-08-18', jobs);
    const assigned = Object.values(cap.perCrew).reduce((s, h) => s + h, 0);
    expect(assigned + cap.unassignedHours).toBe(17);
  });
});
