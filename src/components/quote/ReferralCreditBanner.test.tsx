// Ledger #41 PR 2 — smoke coverage for the quote builder's referral-credit
// banner. Renders with react-dom/server (same approach as ReferredByPicker.
// test.tsx) — these are static prop-driven states, no need to exercise the
// actual fetch/click.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralCreditBanner } from './ReferralCreditBanner';

const BASE = { customerId: 'c1', quoteId: 'q1', onApplied: vi.fn(), onRemoved: vi.fn() };

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

  it('shows an "Applied" confirmation + a Remove button once the credit has been applied to this quote', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner {...BASE} balanceUsd={0} appliedCredit={{ amount: 125 }} discountSlotOccupied={false} />,
    );
    expect(html).toContain('Applied $125');
    expect(html).not.toContain('Apply as discount');
    expect(html).toContain('Remove');
  });

  // #41 adversarial-review fix: a loud, non-dismissable warning shown ON the
  // banner when the parent's own persist-to-quote (right after Apply/Remove)
  // failed — the credit was already consumed/released server-side.
  it('shows the parent-driven persistError alongside the Applied confirmation', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner
        {...BASE}
        balanceUsd={0}
        appliedCredit={{ amount: 125 }}
        discountSlotOccupied={false}
        persistError="Credit applied but the quote didn't save. Click Calculate to finish."
      />,
    );
    expect(html).toContain('Applied $125');
    // React SSR-escapes the apostrophe as an HTML entity — assert on the
    // apostrophe-free parts of the message rather than the literal string.
    expect(html).toContain('Credit applied but the quote');
    expect(html).toContain('Click Calculate to finish');
  });

  it('shows no persistError banner when the prop is null/omitted', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner {...BASE} balanceUsd={0} appliedCredit={{ amount: 125 }} discountSlotOccupied={false} />,
    );
    expect(html).not.toContain('bg-red-50');
  });

  it('never uses an em dash in the customer-facing copy (voice rules)', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner {...BASE} balanceUsd={125} appliedCredit={null} discountSlotOccupied={true} />,
    );
    expect(html).not.toContain('—');
  });

  it('never uses an em dash in the Applied/Remove state either', () => {
    const html = renderToStaticMarkup(
      <ReferralCreditBanner
        {...BASE}
        balanceUsd={0}
        appliedCredit={{ amount: 125 }}
        discountSlotOccupied={false}
        persistError="Credit applied but the quote didn't save. Click Calculate to finish."
      />,
    );
    expect(html).not.toContain('—');
  });
});
