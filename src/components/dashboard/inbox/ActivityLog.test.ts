import { describe, it, expect } from 'vitest';
import { friendlyAction } from './ActivityLog';

// row 312(b): the 26 S41 'reclassified' data-op rows rendered as the raw
// action string — no ACTION_LABEL entry existed. Pure-function test only
// (no jsdom in this project — see InWorksSection.test.tsx's own note).
describe('friendlyAction', () => {
  it('labels reclassified (row 312b)', () => {
    expect(friendlyAction('reclassified')).toBe('Reclassified');
  });
  it('falls through to the raw string for an unmapped action', () => {
    expect(friendlyAction('some_future_action')).toBe('some_future_action');
  });
  it('still labels the pre-existing reversible actions', () => {
    expect(friendlyAction('handled')).toBe('Handled');
    expect(friendlyAction('followed')).toBe('Followed up');
    expect(friendlyAction('completed')).toBe('Completed');
    expect(friendlyAction('dismissed')).toBe('Not a lead');
    expect(friendlyAction('reversed')).toBe('Reversed');
  });
});
