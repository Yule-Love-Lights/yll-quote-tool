import { describe, it, expect } from 'vitest';
import { applyBucketFilter, bucketOf, isStale, inverseOf, clampFollowUpDays, type QueryBucket } from './lifecycle';
import type { InboxStatus } from './types';
import { INBOX_STATUSES } from './types';

const T = new Date('2026-06-30T12:00:00Z');
const ago = (days: number) => new Date(T.getTime() - days * 86_400_000).toISOString();

describe('bucketOf', () => {
  it('needs_reply: unresponded, no follow flag', () => {
    expect(bucketOf({ status: 'unresponded', followedUpAt: null })).toBe('needs_reply');
  });
  it('awaiting_reply: any followed_up_at set (incl. a sent reply that is also handled)', () => {
    expect(bucketOf({ status: 'handled', followedUpAt: ago(1) })).toBe('awaiting_reply');
    expect(bucketOf({ status: 'unresponded', followedUpAt: ago(1) })).toBe('awaiting_reply');
  });
  it('handled: handled with no follow flag', () => {
    expect(bucketOf({ status: 'handled', followedUpAt: null })).toBe('handled');
  });
  it('completed / dismissed terminal', () => {
    expect(bucketOf({ status: 'completed', followedUpAt: null })).toBe('completed');
    expect(bucketOf({ status: 'dismissed', followedUpAt: ago(1) })).toBe('dismissed');
  });
});
// ─── applyBucketFilter — DB predicate matches bucketOf (#252 slice C drift guard) ─
//
// Records the real .eq/.is/.not calls applyBucketFilter makes (a recording
// stub, not a hand-copy of its logic), then interprets that trace against a
// candidate row using only the Postgres semantics the three operators need
// (eq, is-null, not-is, not-in). Exhaustive over every (status ×
// followed_up_at null/non-null) combination × every QueryBucket — if
// applyBucketFilter and bucketOf are ever edited out of sync, this fails.

type FilterCall = { method: 'eq' | 'is' | 'not'; args: unknown[] };

function makeRecordingQuery() {
  const calls: FilterCall[] = [];
  const query = {
    eq(column: string, value: unknown) {
      calls.push({ method: 'eq', args: [column, value] });
      return query;
    },
    is(column: string, value: unknown) {
      calls.push({ method: 'is', args: [column, value] });
      return query;
    },
    not(column: string, operator: string, value: unknown) {
      calls.push({ method: 'not', args: [column, operator, value] });
      return query;
    },
  };
  return { query, calls };
}

/** Interprets a recorded filter-call trace against one row, matching Postgres
 *  semantics for the operators applyBucketFilter actually emits: eq (=), is
 *  (IS, used here only for null), not(col,'is',v) (IS NOT), not(col,'in',list)
 *  (NOT IN (...)). Throws on any other shape so a future bucket case can't
 *  silently go unverified by this test. */
function rowSatisfiesTrace(
  calls: FilterCall[],
  row: { status: InboxStatus; followedUpAt: string | null },
): boolean {
  const fieldValue = (column: string): unknown => {
    if (column === 'status') return row.status;
    if (column === 'followed_up_at') return row.followedUpAt;
    throw new Error(`drift test does not know column "${column}"`);
  };
  return calls.every((call) => {
    const column = call.args[0] as string;
    const value = fieldValue(column);
    if (call.method === 'eq') return value === call.args[1];
    if (call.method === 'is') return value === call.args[1];
    if (call.method === 'not') {
      const [, operator, operand] = call.args as [string, string, unknown];
      if (operator === 'is') return value !== operand;
      if (operator === 'in') {
        const list = String(operand).replace(/^\(|\)$/g, '').split(',');
        return !list.includes(String(value));
      }
    }
    throw new Error(`drift test does not know how to interpret ${call.method}(${JSON.stringify(call.args)})`);
  });
}

describe('applyBucketFilter — DB predicate matches bucketOf (drift guard)', () => {
  const FOLLOWED_UP_AT: (string | null)[] = [null, '2026-07-20T10:00:00Z'];
  const BUCKETS: QueryBucket[] = ['needs_reply', 'awaiting_reply', 'handled'];
  const cases = INBOX_STATUSES.flatMap((status) =>
    FOLLOWED_UP_AT.map((followedUpAt) => ({ status, followedUpAt })),
  );

  it.each(cases)(
    'status=$status followedUpAt=$followedUpAt: each bucket filter admits the row iff bucketOf assigns it there',
    ({ status, followedUpAt }) => {
      const expectedBucket = bucketOf({ status, followedUpAt });
      for (const bucket of BUCKETS) {
        const { query, calls } = makeRecordingQuery();
        applyBucketFilter(query, bucket);
        const admitted = rowSatisfiesTrace(calls, { status, followedUpAt });
        expect(admitted).toBe(bucket === expectedBucket);
      }
    },
  );
});

describe('isStale', () => {
  it('true past the threshold, false within, false when null', () => {
    expect(isStale(ago(4), 3, T)).toBe(true);
    expect(isStale(ago(2), 3, T)).toBe(false);
    expect(isStale(null, 3, T)).toBe(false);
  });
});
describe('inverseOf', () => {
  it('un-dismiss restores prior status and un-suppresses', () => {
    expect(inverseOf('dismissed', { status: 'unresponded' })).toEqual({ status: 'unresponded', clearFollowed: false, setFollowed: false, unsuppress: true });
  });
  it('un-complete falls back to handled when no prior', () => {
    expect(inverseOf('completed')).toEqual({ status: 'handled', clearFollowed: false, setFollowed: false, unsuppress: false });
  });
  it('un-complete restores the awaiting (followed) bucket when it was followed before', () => {
    expect(inverseOf('completed', { status: 'handled', wasFollowed: true })).toEqual({ status: 'handled', clearFollowed: false, setFollowed: true, unsuppress: false });
  });
  it('un-handle -> needs reply; un-follow clears the flag only', () => {
    expect(inverseOf('handled')).toEqual({ status: 'unresponded', clearFollowed: false, setFollowed: false, unsuppress: false });
    expect(inverseOf('followed')).toEqual({ status: null, clearFollowed: true, setFollowed: false, unsuppress: false });
  });
});
describe('clampFollowUpDays', () => {
  it('defaults to 3, clamps 1..60, rounds', () => {
    expect(clampFollowUpDays(undefined)).toBe(3);
    expect(clampFollowUpDays(0)).toBe(1);
    expect(clampFollowUpDays(999)).toBe(60);
    expect(clampFollowUpDays(4.6)).toBe(5);
  });
});
