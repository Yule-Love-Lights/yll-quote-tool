// #154 interim — Wisetack prequal CTA eligibility (pure money-adjacent rules).
// Tests written FIRST (money-adjacent → TDD per the working conventions).
//
// The financed balance is agreed total minus deposit, rounded with the SAME
// round2 (roundMoneyGuarded) the invoice/amend/balance chain uses, so the
// number a customer sees next to the financing CTA can never drift a cent
// from what the balance code would bill.
//
// Eligibility is a POSITIVE gate (per AGENTS.md seam rules): flag exactly on,
// service type exactly holiday, permanent, or permanent_bistro, job total at
// least $1,500 (the
// YLL business floor, Naldo 2026-07-18), balance inside [$500, $25,000]
// inclusive. Event / unknown service types are OUT — a future vertical must
// opt in, never inherit.

import { describe, it, expect } from 'vitest';
import { roundMoneyGuarded as round2 } from '@/lib/money';
import {
  WISETACK_MIN_USD,
  WISETACK_MAX_USD,
  YLL_FINANCING_MIN_JOB_TOTAL_USD,
  financedBalanceUsd,
  isFinancingEligible,
} from './eligibility';

describe('financing range constants', () => {
  it('match the Wisetack range ($500–$25,000)', () => {
    expect(WISETACK_MIN_USD).toBe(500);
    expect(WISETACK_MAX_USD).toBe(25000);
  });

  it('YLL job floor is $1,500 (Naldo, 2026-07-18)', () => {
    expect(YLL_FINANCING_MIN_JOB_TOTAL_USD).toBe(1500);
  });
});

describe('financedBalanceUsd', () => {
  it('is agreed total minus deposit, rounded to cents', () => {
    expect(financedBalanceUsd(5000, 2500)).toBe(2500);
    expect(financedBalanceUsd(3697.5, 1848.75)).toBe(1848.75);
  });

  it('rounds float dust away (999.999 − 499.999 → exactly 500)', () => {
    // Raw JS gives 500.00000000000006 here; the round2 pass must clean it.
    expect(financedBalanceUsd(999.999, 499.999)).toBe(500);
  });

  it('half-cent inputs round consistently with round2 (roundMoneyGuarded)', () => {
    expect(financedBalanceUsd(1000.005, 0)).toBe(round2(1000.005));
    expect(financedBalanceUsd(2500.005, 1250)).toBe(round2(2500.005 - 1250));
  });
});

describe('isFinancingEligible', () => {
  const eligibleBase = {
    enabled: true,
    serviceType: 'holiday' as const,
    totalUsd: 5000,
    balanceUsd: 2500,
  };

  it('eligible: flag on, holiday, total over the job floor, balance in range', () => {
    expect(isFinancingEligible(eligibleBase)).toBe(true);
  });

  it('flag off → never eligible, even with a perfect balance', () => {
    expect(isFinancingEligible({ ...eligibleBase, enabled: false })).toBe(false);
  });

  describe('the $1,500 YLL job floor gates on the TOTAL, not the balance', () => {
    it('total 1499.99 → no, even with a financeable balance', () => {
      expect(
        isFinancingEligible({ ...eligibleBase, totalUsd: 1499.99, balanceUsd: 749.99 }),
      ).toBe(false);
    });
    it('total 1500 → yes (floor inclusive; its $750 balance is in the Wisetack range)', () => {
      expect(isFinancingEligible({ ...eligibleBase, totalUsd: 1500, balanceUsd: 750 })).toBe(true);
    });
    it('a $1,000 job is out even though its $500 balance meets the Wisetack floor', () => {
      expect(isFinancingEligible({ ...eligibleBase, totalUsd: 1000, balanceUsd: 500 })).toBe(false);
    });
  });

  describe('balance bounds are inclusive', () => {
    it('499.99 → no (below floor)', () => {
      expect(isFinancingEligible({ ...eligibleBase, balanceUsd: 499.99 })).toBe(false);
    });
    it('500 → yes (floor inclusive)', () => {
      expect(isFinancingEligible({ ...eligibleBase, balanceUsd: 500 })).toBe(true);
    });
    it('25000 → yes (ceiling inclusive)', () => {
      expect(isFinancingEligible({ ...eligibleBase, balanceUsd: 25000 })).toBe(true);
    });
    it('25000.01 → no (above ceiling)', () => {
      expect(isFinancingEligible({ ...eligibleBase, balanceUsd: 25000.01 })).toBe(false);
    });
  });

  describe('service-type positive gate', () => {
    it('holiday → eligible', () => {
      expect(isFinancingEligible({ ...eligibleBase, serviceType: 'holiday' })).toBe(true);
    });
    it('permanent → eligible', () => {
      expect(isFinancingEligible({ ...eligibleBase, serviceType: 'permanent' })).toBe(true);
    });
    it('permanent_bistro → eligible (added by Naldo 2026-07-18)', () => {
      expect(isFinancingEligible({ ...eligibleBase, serviceType: 'permanent_bistro' })).toBe(true);
    });
    it('event → not eligible', () => {
      expect(isFinancingEligible({ ...eligibleBase, serviceType: 'event' })).toBe(false);
    });
    it('unknown (undefined/null) → not eligible', () => {
      expect(isFinancingEligible({ ...eligibleBase, serviceType: undefined })).toBe(false);
      expect(isFinancingEligible({ ...eligibleBase, serviceType: null })).toBe(false);
    });
  });

  it('a pre-round boundary balance decides on the ROUNDED number (rounding before the gate)', () => {
    // 1000 − 500.004 = 499.996 raw → rounds to 500.00 → eligible.
    const balance = financedBalanceUsd(1000, 500.004);
    expect(balance).toBe(500);
    expect(isFinancingEligible({ ...eligibleBase, balanceUsd: balance })).toBe(true);
  });
});
