import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { DepositRateChip, depositChipState, depositCaution } from './DepositRateChip';
import { BUSINESS_RULES, NCE_DEPOSIT_PERCENT } from '@/lib/pricing/pricingEngine';

// Row 409 — the chip REPORTS a deposit mismatch, it never corrects one (Jason's
// 2026-08-25 ruling). These pin which states are visible and which read as a
// mismatch, because a chip that quietly hides the one case it exists for is
// worse than no chip.

describe('depositChipState (row 409)', () => {
  it('shows an NCE quote sitting at the NCE rate, without flagging it', () => {
    const s = depositChipState(true, NCE_DEPOSIT_PERCENT / 100);
    expect(s.show).toBe(true);
    expect(s.tagConflict).toBe(false);
    expect(s.percent).toBe(40);
  });

  it('flags the live case: an NCE quote left on the standard deposit', () => {
    // Measured on prod 2026-08-25: quote #1262, sent, is_nce with a 50% deposit.
    const s = depositChipState(true, BUSINESS_RULES.depositPercentage);
    expect(s.show).toBe(true);
    expect(s.tagConflict).toBe(true);
    expect(s.percent).toBe(50);
    expect(s.expectedPercent).toBe(40);
  });

  it('flags the reverse direction: the tag came off and the NCE deposit stayed', () => {
    const s = depositChipState(false, NCE_DEPOSIT_PERCENT / 100);
    expect(s.show).toBe(true);
    expect(s.tagConflict).toBe(true);
    expect(s.expectedPercent).toBe(50);
  });

  it('stays out of the way on an ordinary quote at the default deposit', () => {
    expect(depositChipState(false, BUSINESS_RULES.depositPercentage).show).toBe(false);
  });

  it('shows any other staff-set rate on a non-NCE quote, WITHOUT flagging it', () => {
    // Staff-lens MED: a hand-set 25% deposit is somebody doing their job. It is
    // worth showing and it is not a tag conflict; colouring it the same amber as
    // a real NCE disagreement drains the signal out of the case row 409 is for.
    const s = depositChipState(false, 0.25);
    expect(s.show).toBe(true);
    expect(s.tagConflict).toBe(false);
    expect(s.percent).toBe(25);
  });

  it('compares whole percents, so float noise is not a mismatch', () => {
    // 0.1 + 0.3 = 0.4 with a float tail; the chip must still read 40%.
    const s = depositChipState(true, 0.1 + 0.3);
    expect(s.percent).toBe(40);
    expect(s.tagConflict).toBe(false);
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

  it('says whether the rate was agreed at approval or is merely current', () => {
    // Admin-lens MED: 8 of 24 live approved/booked quotes carry no frozen rate,
    // so the chip must not imply the stronger claim for all of them.
    expect(renderToStaticMarkup(<DepositRateChip isNce rate={0.4} frozen />)).toContain(
      'agreed at approval',
    );
    expect(renderToStaticMarkup(<DepositRateChip isNce rate={0.4} />)).toContain('current rate');
  });

  it('never renders NaN', () => {
    const html = renderToStaticMarkup(<DepositRateChip isNce rate={0.4} />);
    expect(html).not.toContain('NaN');
  });
});

// Fix round 2 (delta-verify MED x3): the detail page's caution was shipped
// with zero coverage, its instruction could not run on reprice-locked
// statuses, and its claim over-reached. The enumeration is now a pure
// function; these pin each state.
describe('depositCaution (row 409, fix round 2)', () => {
  const drift = { pricedPercent: 50, configuredPercent: 40 };

  it('is silent when the priced and configured rates agree', () => {
    expect(depositCaution({ pricedPercent: 40, configuredPercent: 40, status: 'sent' })).toBeNull();
  });

  it('instructs a recalculate on statuses where /api/quote allows one', () => {
    for (const status of ['draft', 'sent', 'viewed', 'approved']) {
      expect(depositCaution({ ...drift, status })).toMatchObject({ kind: 'recalc' });
    }
  });

  it('never instructs the impossible: terminal statuses get no caution at all', () => {
    // /api/quote's REPRICE_LOCKED_STATUSES 409s a Calculate on these, and
    // nothing will ever charge them — the old copy told staff to do something
    // the API refuses (delta-verify MED, reachable via the NCE toggle, which
    // only gates on customer_approved_at).
    for (const status of ['declined', 'cancelled', 'abandoned']) {
      expect(depositCaution({ ...drift, status })).toBeNull();
    }
  });

  it('on a booked order the drift is shown as a record, not an action item', () => {
    // Suppressing it entirely would reintroduce the original HIGH (the list
    // chip and detail page disagreeing with nothing explaining it); telling
    // staff to Calculate would 409; claiming "the portal charges X%" is false
    // once the deposit is settled. So: visible, kind 'record'.
    expect(depositCaution({ ...drift, status: 'booked' })).toMatchObject({
      kind: 'record',
      priced: 50,
      configured: 40,
    });
  });
});
