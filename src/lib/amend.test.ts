import { describe, it, expect } from 'vitest';
import {
  computeAmendment,
  requiresReconsent,
  amendedQuoteStatus,
  AMEND_RECONSENT_STATUS,
  type AmendmentTrailEntry,
} from './amend';

// ─────────────────────────────────────────────────────────────────────────────
// Pure amend-order core (#83 Phase 4). These tests pin the re-price-with-deposit
// math, the amendment-trail shape, the re-consent predicate, and the money-safety
// guards (clamp ≥ 0, credit note, NaN/negative rejection, immutable deposit).
// No IO — every input is a plain object.
// ─────────────────────────────────────────────────────────────────────────────

// A representative booked order: total $5,000, 50% deposit ($2,500) paid,
// balance $2,500 outstanding.
function bookedBase() {
  return {
    previousTotal: 5000,
    depositPaid: 2500,
    previousBalance: 2500,
    by: 'staff:naldo',
    reason: 'customer added two trees',
  };
}

describe('computeAmendment — balance recompute with deposit applied', () => {
  it('increase: new balance = new total − deposit paid', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    expect(a.new_total).toBe(6000);
    expect(a.previous_total).toBe(5000);
    expect(a.delta).toBe(1000);
    // deposit ($2,500) stays applied; balance grows by the delta.
    expect(a.new_balance).toBe(3500);
    expect(a.previous_balance).toBe(2500);
    expect(a.credit_note).toBeUndefined();
    expect(a.overpayment).toBeUndefined();
  });

  it('decrease (still above deposit): smaller balance, deposit unchanged', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 4000 });
    expect(a.delta).toBe(-1000);
    expect(a.new_balance).toBe(1500); // 4000 − 2500
    expect(a.credit_note).toBeUndefined();
  });

  it('zero-delta (cosmetic) amendment: balance unchanged, delta 0', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 5000 });
    expect(a.delta).toBe(0);
    expect(a.new_balance).toBe(2500);
  });

  it('carries the trail metadata (who / when / reason)', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    expect(a.by).toBe('staff:naldo');
    expect(a.reason).toBe('customer added two trees');
    expect(typeof a.amended_at).toBe('string');
    // ISO 8601 timestamp.
    expect(() => new Date(a.amended_at).toISOString()).not.toThrow();
    expect(new Date(a.amended_at).toISOString()).toBe(a.amended_at);
  });

  it('records the optional line_item_changes diff verbatim', () => {
    const changes = [
      { id: 'tree-1', label: 'Front tree', change: 'added' as const, price: 250 },
      { id: 'wreath-2', label: 'Door wreath', change: 'removed' as const, price: 120 },
    ];
    const a = computeAmendment({ ...bookedBase(), newTotal: 5130, lineItemChanges: changes });
    expect(a.line_item_changes).toEqual(changes);
  });

  it('defaults line_item_changes to an empty array when none supplied', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    expect(a.line_item_changes).toEqual([]);
  });
});

describe('computeAmendment — money-safety guards', () => {
  it('clamps the new balance at 0 when the new total drops below the deposit', () => {
    // new total $2,000 < deposit $2,500 → balance can never be negative.
    const a = computeAmendment({ ...bookedBase(), newTotal: 2000 });
    expect(a.new_balance).toBe(0);
  });

  it('surfaces a credit note (overpayment) when deposit exceeds the new total', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 2000 });
    // $2,500 deposit − $2,000 total = $500 overpaid → manual Valor refund flag.
    expect(a.credit_note).toBe(500);
    expect(a.overpayment).toBe(true);
  });

  it('exact-equal deposit/total → zero balance, no credit note', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 2500 });
    expect(a.new_balance).toBe(0);
    expect(a.credit_note).toBeUndefined();
    expect(a.overpayment).toBeUndefined();
  });

  it('never re-charges or mutates the deposit (deposit is immutable input)', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    // The deposit applied is echoed unchanged; the balance is what moves.
    expect(a.deposit_applied).toBe(2500);
  });

  it('rejects a NaN new total', () => {
    expect(() => computeAmendment({ ...bookedBase(), newTotal: NaN })).toThrow(/finite/i);
  });

  it('rejects a negative new total', () => {
    expect(() => computeAmendment({ ...bookedBase(), newTotal: -100 })).toThrow(/negative/i);
  });

  it('rejects an Infinity new total', () => {
    expect(() => computeAmendment({ ...bookedBase(), newTotal: Infinity })).toThrow(/finite/i);
  });

  it('rejects a negative deposit paid (impossible input)', () => {
    expect(() =>
      computeAmendment({ ...bookedBase(), depositPaid: -1, newTotal: 6000 }),
    ).toThrow(/deposit/i);
  });

  it('rejects a NaN previous total (would poison the delta)', () => {
    expect(() =>
      computeAmendment({ ...bookedBase(), previousTotal: NaN, newTotal: 6000 }),
    ).toThrow(/previous total/i);
  });

  it('rejects a NaN previous balance', () => {
    expect(() =>
      computeAmendment({ ...bookedBase(), previousBalance: NaN, newTotal: 6000 }),
    ).toThrow(/previous balance/i);
  });

  it('rounds money to cents (no float dust in the trail)', () => {
    const a = computeAmendment({
      previousTotal: 100.1,
      depositPaid: 50.05,
      previousBalance: 50.05,
      newTotal: 100.1 + 0.1 + 0.1, // 100.30000000000001 in float
      by: 'staff:x',
      reason: 'rounding',
    });
    expect(a.new_total).toBe(100.3);
    expect(a.delta).toBe(0.2);
    expect(a.new_balance).toBe(50.25);
  });
});

describe('requiresReconsent — re-sign default (SPEC §9, flagged for Naldo)', () => {
  it('a total-changing amendment requires customer re-approval', () => {
    const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    expect(requiresReconsent(inc)).toBe(true);
    const dec = computeAmendment({ ...bookedBase(), newTotal: 4000 });
    expect(requiresReconsent(dec)).toBe(true);
  });

  it('a zero-delta (cosmetic) amendment does NOT require re-consent', () => {
    const noop = computeAmendment({ ...bookedBase(), newTotal: 5000 });
    expect(requiresReconsent(noop)).toBe(false);
  });

  it('treats sub-cent deltas as zero-delta (no re-consent for float dust)', () => {
    const a = computeAmendment({ ...bookedBase(), newTotal: 5000.004 });
    expect(a.delta).toBe(0);
    expect(requiresReconsent(a)).toBe(false);
  });
});

describe('amendedQuoteStatus — resulting status', () => {
  it('total-changing amendment → re-consent status (reuses changes_requested)', () => {
    const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    expect(amendedQuoteStatus(inc, 'booked')).toBe(AMEND_RECONSENT_STATUS);
    expect(amendedQuoteStatus(inc, 'booked')).toBe('changes_requested');
  });

  it('zero-delta amendment keeps the order booked', () => {
    const noop = computeAmendment({ ...bookedBase(), newTotal: 5000 });
    expect(amendedQuoteStatus(noop, 'booked')).toBe('booked');
  });
});

describe('repeated amendments — each entry stands alone', () => {
  it('a second amendment chains off the first amended total/balance', () => {
    const first = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    // Staff amends again from the post-first state.
    const second = computeAmendment({
      previousTotal: first.new_total,
      depositPaid: first.deposit_applied,
      previousBalance: first.new_balance,
      newTotal: 7000,
      by: 'staff:naldo',
      reason: 'added garland',
    });
    expect(second.previous_total).toBe(6000);
    expect(second.previous_balance).toBe(3500);
    expect(second.new_total).toBe(7000);
    expect(second.new_balance).toBe(4500); // 7000 − 2500 deposit
    expect(second.delta).toBe(1000);
  });

  it('the entries are independent plain objects (safe to append to a trail[])', () => {
    const first = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    const trail: AmendmentTrailEntry[] = [];
    trail.push(first);
    expect(trail).toHaveLength(1);
    expect(Object.isFrozen(first)).toBe(false); // a plain serializable object
  });
});
