// The rule that decides which quotes leave the homepage turnaround average.
// Tested here because scripts/mark-backlog-sends.ts needs prod credentials to
// run and this decides what a KPI counts.

import { describe, it, expect } from 'vitest';
import { planBacklogSends, heldDays, type SentQuote } from './backlogSendPlan';

function q(over: Partial<SentQuote> & { id: string }): SentQuote {
  return {
    created_at: '2026-07-16T12:00:00Z',
    quote_sent_at: '2026-09-03T12:00:00Z',
    backlog_send_at: null,
    ...over,
  };
}

const RULE = { builtBefore: '2026-08-01', heldDaysMin: 14 };

describe('planBacklogSends — both halves of the rule are load-bearing', () => {
  it('marks a quote built before the cutoff and held past the floor', () => {
    const plan = planBacklogSends([q({ id: 'a' })], RULE);
    expect(plan.matches.map((r) => r.id)).toEqual(['a']);
  });

  // The wave that motivated this shipped 7 quotes built and sent the same day.
  // Those are a real same-day turnaround and marking them would flatter the
  // number, which is the opposite of the point.
  it('leaves a quote built and sent the same day in the average', () => {
    const plan = planBacklogSends(
      [q({ id: 'sameday', created_at: '2026-09-03T09:00:00Z' })],
      RULE,
    );
    expect(plan.matches).toEqual([]);
    expect(plan.keptIn.map((r) => r.id)).toEqual(['sameday']);
  });

  // Held a long time but built after the cutoff: ordinary slowness, not the
  // batch. Without the cutoff this rule would quietly excuse every slow quote
  // forever.
  it('leaves a long gap in when the quote was built after the cutoff', () => {
    const plan = planBacklogSends(
      [q({ id: 'slow', created_at: '2026-08-02T12:00:00Z' })],
      RULE,
    );
    expect(plan.matches).toEqual([]);
  });

  // Built inside the batch window but sent almost immediately: the cutoff
  // alone would have swept this in.
  it('leaves a quote built before the cutoff but sent the next day in', () => {
    const plan = planBacklogSends(
      [q({ id: 'quick', created_at: '2026-07-16T12:00:00Z', quote_sent_at: '2026-07-17T12:00:00Z' })],
      RULE,
    );
    expect(plan.matches).toEqual([]);
  });

  it('treats the held-days floor as inclusive', () => {
    const exactly = q({
      id: 'exact',
      created_at: '2026-07-16T12:00:00Z',
      quote_sent_at: '2026-07-30T12:00:00Z',
    });
    expect(heldDays(exactly)).toBe(14);
    expect(planBacklogSends([exactly], RULE).matches.map((r) => r.id)).toEqual(['exact']);
  });

  it('treats the built-before cutoff as strict', () => {
    const onCutoff = q({ id: 'on', created_at: '2026-08-01T00:00:00Z' });
    expect(planBacklogSends([onCutoff], RULE).matches).toEqual([]);
  });
});

describe('planBacklogSends — never restamps, and shows its own margin', () => {
  it('keeps an already-marked row out of the write list', () => {
    const plan = planBacklogSends(
      [q({ id: 'old', backlog_send_at: '2026-09-03T20:00:00Z' }), q({ id: 'new' })],
      RULE,
    );
    expect(plan.matches).toHaveLength(2);
    expect(plan.toWrite.map((r) => r.id)).toEqual(['new']);
    expect(plan.alreadyMarked.map((r) => r.id)).toEqual(['old']);
  });

  // The margin either side of the threshold. Neighbouring values here mean the
  // rule is splitting near-identical quotes, which is worth seeing BEFORE the
  // write rather than discovering afterwards.
  it('reports the smallest marked gap and the largest kept gap', () => {
    const plan = planBacklogSends(
      [
        q({ id: 'marked', created_at: '2026-07-16T12:00:00Z', quote_sent_at: '2026-07-31T12:00:00Z' }), // 15 d
        q({ id: 'kept', created_at: '2026-07-16T12:00:00Z', quote_sent_at: '2026-07-26T12:00:00Z' }), // 10 d
      ],
      RULE,
    );
    expect(plan.smallestGapMarked).toBe(15);
    expect(plan.largestGapKept).toBe(10);
  });

  it('computes the turnaround before and after the exclusion', () => {
    const plan = planBacklogSends(
      [
        q({ id: 'long', created_at: '2026-07-16T12:00:00Z', quote_sent_at: '2026-08-25T12:00:00Z' }), // 40 d
        q({ id: 'short', created_at: '2026-08-20T12:00:00Z', quote_sent_at: '2026-08-22T12:00:00Z' }), // 2 d
      ],
      RULE,
    );
    expect(plan.turnaroundNow).toBe(21);
    expect(plan.turnaroundAfter).toBe(2);
  });

  it('reports a null turnaround, not zero, when every row is excluded', () => {
    const plan = planBacklogSends([q({ id: 'a' })], RULE);
    expect(plan.turnaroundAfter).toBeNull();
    expect(plan.largestGapKept).toBeNull();
  });
});

describe('planBacklogSends — refuses a rule it cannot honour', () => {
  it('refuses a non-positive held-days floor', () => {
    expect(() => planBacklogSends([], { builtBefore: '2026-08-01', heldDaysMin: 0 })).toThrow(
      /positive number of days/,
    );
  });

  it('refuses a cutoff it cannot read as a date', () => {
    expect(() => planBacklogSends([], { builtBefore: 'whenever', heldDaysMin: 14 })).toThrow(
      /not a date I can read/,
    );
  });
});
