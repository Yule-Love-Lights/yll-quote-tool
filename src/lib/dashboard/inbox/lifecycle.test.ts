import { describe, it, expect } from 'vitest';
import { bucketOf, isStale, inverseOf, clampFollowUpDays } from './lifecycle';

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
