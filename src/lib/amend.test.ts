import { describe, it, expect } from 'vitest';
import {
  computeAmendment,
  requiresReconsent,
  amendedQuoteStatus,
  AMEND_RECONSENT_STATUS,
  latestAmendment,
  latestConsentAmendment,
  blocksSettlement,
  isAmendmentConsentPending,
  isSupersededPendingAmendment,
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

describe('latestAmendment — trail lookup (WT-18 settlement gate)', () => {
  it('returns null for an empty/missing/undefined trail', () => {
    expect(latestAmendment([])).toBeNull();
    expect(latestAmendment(null)).toBeNull();
    expect(latestAmendment(undefined)).toBeNull();
  });

  it('returns the LAST entry (amendments are append-only)', () => {
    const first = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    const second = computeAmendment({
      previousTotal: first.new_total,
      depositPaid: first.deposit_applied,
      previousBalance: first.new_balance,
      newTotal: 7000,
      by: 'staff:naldo',
      reason: 'added garland',
    });
    expect(latestAmendment([first, second])).toBe(second);
  });
});

describe('latestConsentAmendment — consent survives cosmetic trail entries', () => {
  it('returns the newest total-changing entry instead of a later cosmetic entry', () => {
    const financial = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    financial.consent = { status: 'pending' };
    const cosmetic = computeAmendment({
      previousTotal: 6000,
      depositPaid: financial.deposit_applied,
      previousBalance: financial.new_balance,
      newTotal: 6000,
      by: 'staff:naldo',
      reason: 'added free spritzers',
    });

    expect(latestAmendment([financial, cosmetic])).toBe(cosmetic);
    expect(latestConsentAmendment([financial, cosmetic])).toBe(financial);
  });

  it('returns null when the trail contains only cosmetic entries', () => {
    const cosmetic = computeAmendment({ ...bookedBase(), newTotal: 5000 });
    expect(latestConsentAmendment([cosmetic])).toBeNull();
    expect(latestConsentAmendment([])).toBeNull();
  });

  it('keeps an accepted financial amendment accepted after a cosmetic edit', () => {
    const financial = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    financial.consent = {
      status: 'accepted',
      accepted_at: '2026-07-18T12:00:00.000Z',
      signature: {
        name: 'Jordan Smith',
        kind: 'typed',
        value: 'Jordan Smith',
        signed_at: '2026-07-18T12:00:00.000Z',
        ip: null,
      },
    };
    const cosmetic = computeAmendment({
      previousTotal: 6000,
      depositPaid: financial.deposit_applied,
      previousBalance: financial.new_balance,
      newTotal: 6000,
      by: 'staff:naldo',
      reason: 'added free spritzers',
    });

    expect(blocksSettlement(latestConsentAmendment([financial, cosmetic]))).toBe(false);
  });
});

// FIX6 (review MED): only the LATEST total-changing amendment is reachable
// via consent/decline — a real live incident on a real order: +342.56
// (pending, never resolved) then -342.56 (accepted). The admin trail views
// (src/app/admin/quotes/[id]/page.tsx, src/app/admin/jobs/[id]/page.tsx) use
// this to badge the first row "Superseded" instead of "still awaiting the
// customer" — nothing will ever resolve it, since amend-consent/amend-decline
// both 409 'stale-amendment' on anything but the current latest.
describe('isSupersededPendingAmendment', () => {
  it('an earlier PENDING amendment is superseded once a later one is recorded', () => {
    const first = computeAmendment({ ...bookedBase(), newTotal: 5343, reason: 'added a wreath' });
    first.consent = { status: 'pending' };
    const second = computeAmendment({
      previousTotal: first.new_total,
      depositPaid: first.deposit_applied,
      previousBalance: first.new_balance,
      newTotal: 5000.44,
      by: 'staff:naldo',
      reason: 'removed the wreath (customer changed their mind before answering)',
    });
    second.consent = {
      status: 'accepted',
      accepted_at: '2026-07-19T00:00:00.000Z',
      signature: { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith', signed_at: '2026-07-19T00:00:00.000Z', ip: null },
    };

    expect(isSupersededPendingAmendment(first, [first, second])).toBe(true);
    expect(isSupersededPendingAmendment(second, [first, second])).toBe(false); // the live, actionable one
  });

  it('the CURRENT latest pending amendment is never superseded', () => {
    const only = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    only.consent = { status: 'pending' };
    expect(isSupersededPendingAmendment(only, [only])).toBe(false);
  });

  it('an earlier amendment that already resolved (accepted) is NOT superseded — it has a real answer', () => {
    const first = computeAmendment({ ...bookedBase(), newTotal: 5343 });
    first.consent = {
      status: 'accepted',
      accepted_at: '2026-07-18T00:00:00.000Z',
      signature: { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith', signed_at: '2026-07-18T00:00:00.000Z', ip: null },
    };
    const second = computeAmendment({
      previousTotal: first.new_total,
      depositPaid: first.deposit_applied,
      previousBalance: first.new_balance,
      newTotal: 5700,
      by: 'staff:naldo',
      reason: 'added a garland',
    });
    second.consent = { status: 'pending' };

    expect(isSupersededPendingAmendment(first, [first, second])).toBe(false);
  });

  it('an earlier amendment that already resolved (declined) is NOT superseded — it has a real answer', () => {
    const first = computeAmendment({ ...bookedBase(), newTotal: 5343 });
    first.consent = { status: 'declined', declined_at: '2026-07-18T00:00:00.000Z', ip: null };
    const second = computeAmendment({
      previousTotal: bookedBase().previousTotal, // the decline reverted the total
      depositPaid: first.deposit_applied,
      previousBalance: first.previous_balance,
      newTotal: 5700,
      by: 'staff:naldo',
      reason: 'a different change entirely',
    });
    second.consent = { status: 'pending' };

    expect(isSupersededPendingAmendment(first, [first, second])).toBe(false);
  });

  it('a cosmetic (zero-delta) entry is never superseded (requiresReconsent is false)', () => {
    const cosmetic = computeAmendment({ ...bookedBase(), newTotal: 5000 });
    const another = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    another.consent = { status: 'pending' };
    expect(isSupersededPendingAmendment(cosmetic, [cosmetic, another])).toBe(false);
  });

  it('a lone amendment with no later entries is not superseded', () => {
    const only = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    only.consent = { status: 'pending' };
    expect(isSupersededPendingAmendment(only, [only])).toBe(false);
  });
});

describe('blocksSettlement — WT-18 re-consent settlement gate', () => {
  it('blocks a price-INCREASING amendment', () => {
    const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    expect(inc.delta).toBeGreaterThan(0);
    expect(blocksSettlement(inc)).toBe(true);
  });

  it('does NOT block a price-DECREASING amendment (non-increasing never over-collects)', () => {
    const dec = computeAmendment({ ...bookedBase(), newTotal: 4000 });
    expect(dec.delta).toBeLessThan(0);
    // requiresReconsent is true for a decrease too (it's a real total change),
    // but the settlement gate only cares about un-consented INCREASES.
    expect(requiresReconsent(dec)).toBe(true);
    expect(blocksSettlement(dec)).toBe(false);
  });

  it('does NOT block a zero-delta (cosmetic) amendment', () => {
    const noop = computeAmendment({ ...bookedBase(), newTotal: 5000 });
    expect(blocksSettlement(noop)).toBe(false);
  });

  it('does NOT block a sub-cent (float-dust) delta', () => {
    const dust = computeAmendment({ ...bookedBase(), newTotal: 5000.004 });
    expect(blocksSettlement(dust)).toBe(false);
  });

  it('does NOT block when there is no amendment at all (null/undefined)', () => {
    expect(blocksSettlement(null)).toBe(false);
    expect(blocksSettlement(undefined)).toBe(false);
  });
});

describe('amendment consent — booked re-sign flow', () => {
  it('treats an unsigned historical or pending amendment as awaiting consent', () => {
    const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    expect(blocksSettlement(inc)).toBe(true);
    expect(amendedQuoteStatus(inc, 'booked')).toBe('changes_requested');
  });

  it('releases settlement and preserves booked status after customer consent', () => {
    const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
    inc.consent = {
      status: 'accepted',
      accepted_at: '2026-07-18T12:00:00.000Z',
      signature: {
        name: 'Jordan Smith',
        kind: 'typed',
        value: 'Jordan Smith',
        signed_at: '2026-07-18T12:00:00.000Z',
        ip: null,
      },
    };
    expect(blocksSettlement(inc)).toBe(false);
    expect(amendedQuoteStatus(inc, 'booked')).toBe('booked');
  });

  // Ledger #83 follow-up (a real live incident — a customer with no way to say
  // no had to phone in): the customer can now DECLINE. This is the
  // money-critical case — a decline must NOT become collectable just because
  // it is no longer literally "pending".
  describe('a DECLINED amendment', () => {
    it('a declined price INCREASE still blocks settlement — declining is not consenting', () => {
      const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
      inc.consent = { status: 'declined', declined_at: '2026-07-19T09:00:00.000Z', ip: null };
      expect(blocksSettlement(inc)).toBe(true);
      expect(isAmendmentConsentPending(inc)).toBe(true);
      // Still reads as "back in staff/customer hands" — same conceptual state
      // as pending, never silently re-promoted to booked by a decline.
      expect(amendedQuoteStatus(inc, 'booked')).toBe('changes_requested');
    });

    it('a declined price DECREASE still does not block settlement (a decrease never over-collects)', () => {
      const dec = computeAmendment({ ...bookedBase(), newTotal: 4000 });
      dec.consent = { status: 'declined', declined_at: '2026-07-19T09:00:00.000Z', ip: null };
      expect(blocksSettlement(dec)).toBe(false);
      // But it is still NOT accepted — latestConsentAmendment/portal-adapter
      // callers must be able to tell "declined" apart from "accepted".
      expect(isAmendmentConsentPending(dec)).toBe(true);
    });

    it('carries an optional customer-typed reason and an IP breadcrumb, same shape as a signature', () => {
      const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
      inc.consent = {
        status: 'declined',
        declined_at: '2026-07-19T09:00:00.000Z',
        reason: 'too expensive, please remove the wreath',
        ip: '203.0.113.7',
      };
      expect(inc.consent.status).toBe('declined');
      expect(blocksSettlement(inc)).toBe(true);
    });

    it('a decline reason is optional', () => {
      const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
      inc.consent = { status: 'declined', declined_at: '2026-07-19T09:00:00.000Z', ip: null };
      expect(inc.consent).not.toHaveProperty('reason');
      expect(blocksSettlement(inc)).toBe(true);
    });

    it('only a FRESH amendment lifts a decline — the decline itself has no undo here', () => {
      // This module only computes/derives; it never mutates a past entry.
      // FIX3 (review HIGH, corrected 2026-08-19): "undo" in practice is a NEW
      // amendment from staff (computeAmendment again) — NOT the customer
      // re-hitting accept on the SAME declined entry. This comment used to say
      // the latter was a legitimate path; amend-consent/route.ts now explicitly
      // REFUSES it (409 'already-declined', mirroring amend-decline's own
      // already-accepted guard in reverse) because it would silently overwrite
      // a real refusal — destroying declined_at/reason/ip and unblocking
      // settlement — on nothing more than a stale tab or the back button.
      // Enforcing the refusal is the caller's (the route's) job, not this pure
      // module's; this test only confirms the entry itself stays inert.
      const inc = computeAmendment({ ...bookedBase(), newTotal: 6000 });
      inc.consent = { status: 'declined', declined_at: '2026-07-19T09:00:00.000Z', ip: null };
      const stillDeclined = { ...inc };
      expect(blocksSettlement(stillDeclined)).toBe(true);
    });
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
