// Row 367 — the design's post-approval freeze predicate. Kept as its own unit
// table because the whole point of extracting it is that /api/designs/[id],
// /api/quote and QuoteBuilder read ONE rule; a change here is a change to all
// three, and should have to break a named case to happen.

import { describe, it, expect } from 'vitest';
import { isSceneFrozen, SCENE_LOCKED_CODE, type SceneFreezeRow } from './sceneFreeze';

const base: SceneFreezeRow = {
  quote_sent_at: '2026-08-01T00:00:00Z',
  viewed_at: '2026-08-01T01:00:00Z',
  customer_approved_at: null,
  deposit_paid_at: null,
  status: 'sent',
  is_test: false,
};

const approved: SceneFreezeRow = { ...base, status: 'approved', customer_approved_at: '2026-08-02T00:00:00Z' };

describe('isSceneFrozen', () => {
  it('is false before any approval — draft, sent, viewed, changes_requested', () => {
    for (const status of ['draft', 'sent', 'viewed', 'changes_requested'] as const) {
      expect(isSceneFrozen({ ...base, status })).toBe(false);
    }
  });

  it('is TRUE once the customer approved and the order is not booked', () => {
    expect(isSceneFrozen(approved)).toBe(true);
  });

  it('is false for a BOOKED order — the amend flow is the sanctioned way to change it', () => {
    expect(isSceneFrozen({ ...approved, deposit_paid_at: '2026-08-03T00:00:00Z' })).toBe(false);
  });

  it('stays TRUE for a terminal status reached AFTER an approval', () => {
    // deriveStatus reports the persisted terminal status, never 'booked', so a
    // quote declined/cancelled/abandoned post-approval is still frozen. Its
    // recovery path is the same one the money freeze names: revive (re-send),
    // which clears customer_approved_at and unfreezes both at once.
    for (const status of ['declined', 'cancelled', 'abandoned'] as const) {
      expect(isSceneFrozen({ ...approved, status })).toBe(true);
    }
  });

  it('is false for an is_test quote regardless of lifecycle stamps', () => {
    expect(isSceneFrozen({ ...approved, is_test: true })).toBe(false);
    expect(isSceneFrozen({ ...approved, status: 'cancelled', is_test: true })).toBe(false);
  });

  it('treats a missing is_test column as NOT a test quote', () => {
    // A caller that forgets the column must fail SAFE (frozen), never open.
    const withoutFlag: SceneFreezeRow = { ...approved };
    delete withoutFlag.is_test;
    expect(isSceneFrozen(withoutFlag)).toBe(true);
  });

  it('exports the wire code the editor branches on', () => {
    expect(SCENE_LOCKED_CODE).toBe('design-locked');
  });
});
