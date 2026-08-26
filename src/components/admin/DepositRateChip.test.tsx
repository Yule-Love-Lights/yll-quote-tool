import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { DepositRateChip, depositChipState } from './DepositRateChip';
import { BUSINESS_RULES, NCE_DEPOSIT_PERCENT } from '@/lib/pricing/pricingEngine';

// Row 409 — the chip REPORTS a deposit mismatch, it never corrects one (Jason's
// 2026-08-25 ruling). These pin which states are visible and which read as a
// mismatch, because a chip that quietly hides the one case it exists for is
// worse than no chip.

describe('depositChipState (row 409)', () => {
  it('shows an NCE quote sitting at the NCE rate, without flagging it', () => {
    const s = depositChipState(true, NCE_DEPOSIT_PERCENT / 100);
    expect(s.show).toBe(true);
    expect(s.mismatch).toBe(false);
    expect(s.percent).toBe(40);
  });

  it('flags the live case: an NCE quote left on the standard deposit', () => {
    // Measured on prod 2026-08-25: quote #1262, sent, is_nce with a 50% deposit.
    const s = depositChipState(true, BUSINESS_RULES.depositPercentage);
    expect(s.show).toBe(true);
    expect(s.mismatch).toBe(true);
    expect(s.percent).toBe(50);
    expect(s.expectedPercent).toBe(40);
  });

  it('flags the reverse direction: the tag came off and the NCE deposit stayed', () => {
    const s = depositChipState(false, NCE_DEPOSIT_PERCENT / 100);
    expect(s.show).toBe(true);
    expect(s.mismatch).toBe(true);
    expect(s.expectedPercent).toBe(50);
  });

  it('stays out of the way on an ordinary quote at the default deposit', () => {
    expect(depositChipState(false, BUSINESS_RULES.depositPercentage).show).toBe(false);
  });

  it('shows any other staff-set rate on a non-NCE quote', () => {
    const s = depositChipState(false, 0.25);
    expect(s.show).toBe(true);
    expect(s.percent).toBe(25);
  });

  it('compares whole percents, so float noise is not a mismatch', () => {
    // 0.1 + 0.3 = 0.4 with a float tail; the chip must still read 40%.
    const s = depositChipState(true, 0.1 + 0.3);
    expect(s.percent).toBe(40);
    expect(s.mismatch).toBe(false);
  });
});

// Rendered markup, the repo's renderToStaticMarkup idiom (StaffNotesPanel.test.tsx):
// the local browser leg is behind the operator auth gate, so this is what proves
// the chip actually emits a percentage rather than an empty span or NaN%.
describe('DepositRateChip markup (row 409)', () => {
  it('prints the real percentage and marks a mismatch amber', () => {
    const html = renderToStaticMarkup(<DepositRateChip isNce rate={0.5} />);
    expect(html).toContain('50% dep');
    expect(html).toContain('bg-amber-100');
    expect(html).toContain('off the 40% NCE rate');
  });

  it('prints a matching rate without the amber flag', () => {
    const html = renderToStaticMarkup(<DepositRateChip isNce rate={0.4} />);
    expect(html).toContain('40% dep');
    expect(html).not.toContain('bg-amber-100');
  });

  it('renders nothing at all on an ordinary default-deposit quote', () => {
    expect(renderToStaticMarkup(<DepositRateChip isNce={false} rate={0.5} />)).toBe('');
  });

  it('never renders NaN', () => {
    const html = renderToStaticMarkup(<DepositRateChip isNce rate={0.4} />);
    expect(html).not.toContain('NaN');
  });
});
