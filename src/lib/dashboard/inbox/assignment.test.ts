import { describe, it, expect } from 'vitest';
import { claimState, handledByTag } from './assignment';

describe('claimState — shared-queue "I\'ve got this" status for a card', () => {
  it('is unclaimed when nobody is assigned', () => {
    expect(claimState(null, 'op-1')).toBe('unclaimed');
  });
  it('is mine when the current operator is the assignee', () => {
    expect(claimState('op-1', 'op-1')).toBe('mine');
  });
  it('is other when someone else holds it', () => {
    expect(claimState('op-2', 'op-1')).toBe('other');
  });
  it('is other when assigned but there is no current operator (e.g. auth dormant)', () => {
    expect(claimState('op-2', null)).toBe('other');
  });
});

describe('handledByTag — safe GHL tag from an operator label', () => {
  it('strips email punctuation (@, .) to a dash-safe slug', () => {
    expect(handledByTag('naldoven@yulelovelights.com')).toBe('handled-by-naldoven-yulelovelights-com');
  });
  it('lowercases + collapses whitespace', () => {
    expect(handledByTag('John  Smith')).toBe('handled-by-john-smith');
  });
  it('falls back to a generic tag for an empty/punctuation-only label', () => {
    expect(handledByTag('')).toBe('handled-by-operator');
    expect(handledByTag('@@@')).toBe('handled-by-operator');
  });
});
