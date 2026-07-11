// Ledger #41 PR 2 — smoke coverage for the quote builder's referral-credit
// banner. Renders with react-dom/server (same approach as ReferredByPicker.
// test.tsx) — these are static prop-driven states, no need to exercise the
// actual fetch/click.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralCreditBanner } from './ReferralCreditBanner';

const BASE = { customerId: 'c1', quoteId: 'q1', onApplied: vi.fn() };

describe('ReferralCreditBanner', () => {
  it('renders nothing when there is no balance and nothing has been applied', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner {...BASE} balanceUsd={0} appliedCredit={null} discountSlotOccupied={false} />,
    );
    expect(html).toBe('');
  });

  it('shows the balance + an enabled Apply button when nothing occupies the discount slot', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner {...BASE} balanceUsd={125} appliedCredit={null} discountSlotOccupied={false} />,
    );
    expect(html).toContain('$125');
    expect(html).toContain('referral credit');
    expect(html).toContain('Apply as discount');
    // Not the literal disabled="" ATTRIBUTE (the button's Tailwind classes
    // legitimately contain the substring "disabled:..." as a CSS variant).
    expect(html).not.toContain('disabled=""');
  });

  it('disables the Apply button + shows the hint when a manual discount is already in use', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner {...BASE} balanceUsd={125} appliedCredit={null} discountSlotOccupied={true} />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('Manual discount in use');
  });

  it('shows an "Applied" confirmation (no button) once the credit has been applied to this quote', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner {...BASE} balanceUsd={0} appliedCredit={{ amount: 125 }} discountSlotOccupied={false} />,
    );
    expect(html).toContain('Applied $125');
    expect(html).not.toContain('Apply as discount');
  });

  it('never uses an em dash in the customer-facing copy (voice rules)', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner {...BASE} balanceUsd={125} appliedCredit={null} discountSlotOccupied={true} />,
    );
    expect(html).not.toContain('—');
  });
});
