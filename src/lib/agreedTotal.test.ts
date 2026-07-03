import { describe, it, expect } from 'vitest';
import { resolveAgreedTotal, amendedAgreedTotal } from './agreedTotal';

// The AGREED total precedence must match amend/route.ts's previousTotal chain
// EXACTLY: last amendment new_total ?? snapshot currentTotalUsd ?? result.total ?? 0.

describe('resolveAgreedTotal', () => {
  it('prefers the last amendment new_total (rung 1)', () => {
    const snap = {
      customerSelection: { currentTotalUsd: 5000 },
      amendments: [{ new_total: 5600 }, { new_total: 5200 }],
    };
    expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(5200);
  });

  it('falls back to the snapshot selection total when no amendments (rung 2)', () => {
    const snap = { customerSelection: { currentTotalUsd: 5000 }, amendments: [] };
    expect(resolveAgreedTotal(snap, { total: 5600 })).toBe(5000);
  });

  it('falls back to result.total when no snapshot (rung 3 — legacy row)', () => {
    expect(resolveAgreedTotal(null, { total: 4893.75 })).toBe(4893.75);
    expect(resolveAgreedTotal({}, { total: 4893.75 })).toBe(4893.75);
  });

  it('falls back to 0 when nothing is priceable (rung 4)', () => {
    expect(resolveAgreedTotal(null, null)).toBe(0);
    expect(resolveAgreedTotal(null, undefined)).toBe(0);
    expect(resolveAgreedTotal({}, {})).toBe(0);
  });

  it('the selection total (rung 2) can be BELOW result.total — the diverged case', () => {
    // Customer deselected an item / picked the cheaper roofline tier.
    const snap = { customerSelection: { currentTotalUsd: 3697.5 } };
    expect(resolveAgreedTotal(snap, { total: 5437.5 })).toBe(3697.5);
  });

  it('tolerates a malformed selection total (falls through to result.total)', () => {
    expect(resolveAgreedTotal({ customerSelection: { currentTotalUsd: NaN } }, { total: 100 })).toBe(100);
    expect(
      resolveAgreedTotal({ customerSelection: { currentTotalUsd: 'x' as unknown as number } }, { total: 100 }),
    ).toBe(100);
    expect(resolveAgreedTotal({ customerSelection: { currentTotalUsd: -5 } }, { total: 100 })).toBe(100);
    expect(resolveAgreedTotal({ customerSelection: null }, { total: 100 })).toBe(100);
  });

  it('tolerates a malformed trailing amendment and walks back to an earlier valid one', () => {
    const snap = {
      customerSelection: { currentTotalUsd: 5000 },
      amendments: [{ new_total: 5600 }, { new_total: NaN }],
    };
    expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(5600);
  });

  it('tolerates a non-array amendments field (falls through to selection)', () => {
    const snap = {
      customerSelection: { currentTotalUsd: 5000 },
      amendments: 'oops' as unknown as [],
    };
    expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(5000);
  });

  it('accepts 0 as a valid agreed total (a fully-discounted / waived selection)', () => {
    expect(resolveAgreedTotal({ customerSelection: { currentTotalUsd: 0 } }, { total: 500 })).toBe(0);
  });
});

describe('amendedAgreedTotal', () => {
  const agreed = 5000; // customer approved a $5,000 selection of a $5,600 full quote

  it('returns the agreed total unchanged when the full quote did not move (no phantom increase)', () => {
    // No builder edit: current full total === the approval-time full total.
    const snap = { pricing: { total: 5600 } };
    expect(amendedAgreedTotal(snap, { total: 5600 }, agreed)).toBe(agreed);
  });

  it('applies an amend-UP shift on the agreed basis (staff added $300 of work)', () => {
    const snap = { pricing: { total: 5600 } };
    expect(amendedAgreedTotal(snap, { total: 5900 }, agreed)).toBe(5300); // 5000 + (5900 − 5600)
  });

  it('applies an amend-DOWN shift on the agreed basis (staff removed $400 of work)', () => {
    const snap = { pricing: { total: 5600 } };
    expect(amendedAgreedTotal(snap, { total: 5200 }, agreed)).toBe(4600); // 5000 + (5200 − 5600)
  });

  it('clamps to 0 when the removal exceeds the agreed total', () => {
    const snap = { pricing: { total: 5600 } };
    expect(amendedAgreedTotal(snap, { total: 0 }, agreed)).toBe(0); // 5000 + (0 − 5600) < 0 → 0
  });

  it('falls back to the current full total when the snapshot has no frozen full total (legacy)', () => {
    // No pricing.total → measure on the full basis (pre-fix behavior, safe for
    // the non-diverged path where agreed == full).
    expect(amendedAgreedTotal({}, { total: 5600 }, agreed)).toBe(5600);
    expect(amendedAgreedTotal({ pricing: null }, { total: 5600 }, agreed)).toBe(5600);
  });

  it('returns the agreed total when there is no current result to measure', () => {
    expect(amendedAgreedTotal({ pricing: { total: 5600 } }, null, agreed)).toBe(agreed);
    expect(amendedAgreedTotal({ pricing: { total: 5600 } }, { total: NaN }, agreed)).toBe(agreed);
  });
});
