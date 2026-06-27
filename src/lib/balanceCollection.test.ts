import { describe, it, expect } from 'vitest';
import { planBalanceCollection } from './balanceCollection';

describe('planBalanceCollection', () => {
  it('auto-charges when there is a balance and a saved vault token', () => {
    expect(planBalanceCollection({ balance: 2446.87, hasVaultToken: true })).toEqual({
      method: 'auto_charge',
      amountUsd: 2446.87,
    });
  });

  it('falls back to a pay-link when there is a balance but no token', () => {
    expect(planBalanceCollection({ balance: 2446.87, hasVaultToken: false })).toEqual({
      method: 'pay_link',
      amountUsd: 2446.87,
    });
  });

  it('collects nothing when the balance is zero (deposit covered it)', () => {
    expect(planBalanceCollection({ balance: 0, hasVaultToken: true })).toEqual({
      method: 'none',
      amountUsd: 0,
      reason: 'no_balance',
    });
  });

  it('collects nothing and flags overpaid when there is a credit note', () => {
    expect(
      planBalanceCollection({ balance: 0, creditNote: 120.5, hasVaultToken: true }),
    ).toEqual({ method: 'none', amountUsd: 0, reason: 'overpaid' });
  });

  it('treats a tiny negative balance as nothing-to-collect', () => {
    expect(planBalanceCollection({ balance: -0.004, hasVaultToken: false }).method).toBe('none');
  });
});
