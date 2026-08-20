import { describe, it, expect } from 'vitest';
import { friendlyAction, isPermanentReverseRefusal } from './ActivityLog';

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

// row 312 fix-round FIX 5(c): a permanent refusal (wrong-occurrence guard, the
// stillMatches pre-check, the FIX-1 CAS, or the FIX-3 payload gate) should
// disable the Reverse button on retry; a transient one should not. Pure-
// function test only (no jsdom — see the file header note above).
describe('isPermanentReverseRefusal (row 312 fix-round FIX 5c)', () => {
  it('flags the wrong-occurrence guard refusal (312c) as permanent', () => {
    expect(isPermanentReverseRefusal('A later action already changed this item; nothing to reverse from here')).toBe(true);
  });
  it('flags the stillMatches / FIX-1 CAS staleness refusal as permanent', () => {
    expect(isPermanentReverseRefusal('Item state has changed since this action; nothing to reverse')).toBe(true);
  });
  it('flags the FIX-3 payload-gate refusal as permanent', () => {
    expect(isPermanentReverseRefusal('This entry cannot be reversed')).toBe(true);
  });
  it('does NOT flag a transient/config error as permanent (worth retrying)', () => {
    expect(isPermanentReverseRefusal('Supabase service role not configured')).toBe(false);
    expect(isPermanentReverseRefusal('Network error — try again.')).toBe(false);
    expect(isPermanentReverseRefusal('Could not verify this is the latest action for this item — try again')).toBe(false);
  });
});
