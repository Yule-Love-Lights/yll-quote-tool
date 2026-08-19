// Ledger #83 follow-up (a real live incident — a customer with no way to
// decline had to phone in). Rendered with react-dom/server (same approach as
// ReferralSection.test.tsx): useEffect/useState event handlers never fire
// under renderToStaticMarkup, so this asserts the DEFAULT rendered markup for
// each consentStatus — exactly the customer-facing copy/controls that matter,
// without needing jsdom + testing-library (not set up in this repo).
//
// useRouter (next/navigation) throws outside an app-router context — this
// component calls it unconditionally (React hook-order rules), including on
// the read-only declined branch — so it's mocked here, same shape as this
// repo's other vi.mock('@/lib/...') fakes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { AmendmentConsentCard } from './AmendmentConsentCard';
import type { PortalPendingAmendment } from '@/components/portal/types';

const BASE: PortalPendingAmendment = {
  amendedAt: '2026-07-18T12:00:00.000Z',
  reason: 'Added a 36" wreath to the front door',
  previousTotalUsd: 1428.16,
  newTotalUsd: 1770.72,
  deltaUsd: 342.56,
  depositAppliedUsd: 714.08,
  newBalanceUsd: 1056.64,
  consentStatus: 'pending',
};

describe('AmendmentConsentCard — pending (ask)', () => {
  it('renders both the approve control and the new decline control', () => {
    const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={BASE} />);
    expect(html).toContain('Review and approve this change');
    expect(html).toContain('Approve updated order');
    expect(html).toContain('Keep my order as it was');
  });

  it('shows the staff-typed reason and the money figures', () => {
    const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={BASE} />);
    expect(html).toContain('Added a 36&quot; wreath to the front door');
    expect(html).toContain('$1,428.16');
    expect(html).toContain('$1,770.72');
    expect(html).toContain('$714.08');
    expect(html).toContain('$1,056.64');
  });

  it('the approve button starts disabled (no signature captured yet)', () => {
    const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={BASE} />);
    // A crude but real check: the disabled attribute on the approve button's
    // markup, before any client-side signature state exists.
    const approveButtonMatch = html.match(/<button[^>]*>Approve updated order<\/button>/);
    expect(approveButtonMatch).toBeTruthy();
    expect(approveButtonMatch![0]).toContain('disabled=""');
  });

  // The decline reason textarea/confirm panel is behind a client-side
  // "declining" state toggle (setDeclining(true)) that only fires on a click
  // event — inert under a static server render. Its presence is covered by
  // this file's compile-time typechecking of the component + the "Keep my
  // order as it was" button assertion above; a real click-through belongs to
  // a browser/E2E check, not this SSR smoke test (repo convention, per the
  // ReferralSection.test.tsx header comment this file mirrors).
});

describe('AmendmentConsentCard — declined (read-only confirmation)', () => {
  const declined: PortalPendingAmendment = {
    ...BASE,
    consentStatus: 'declined',
    declinedAt: '2026-07-19T09:00:00.000Z',
    declinedReason: 'too expensive, please remove the wreath',
  };

  it('renders a read-only confirmation, NOT the approve/decline ask again', () => {
    const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={declined} />);
    expect(html).toContain('You kept your order as it was');
    expect(html).not.toContain('Review and approve this change');
    expect(html).not.toContain('Approve updated order');
    expect(html).not.toContain('Keep my order as it was');
  });

  it('states the order stays at the PREVIOUS total, not the declined new total', () => {
    const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={declined} />);
    expect(html).toContain('$1,428.16'); // previousTotalUsd
    // The declined-to total should not be presented as what they now owe.
    expect(html).not.toContain('now owe $1,770.72');
  });

  it('shows the customer their own decline reason when they left one', () => {
    const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={declined} />);
    expect(html).toContain('too expensive, please remove the wreath');
  });

  it('omits the reason block entirely when no reason was given', () => {
    const noReason: PortalPendingAmendment = { ...declined, declinedReason: undefined };
    const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={noReason} />);
    expect(html).toContain('You kept your order as it was');
    expect(html).not.toContain('What you told us');
  });

  // FIX9 (review MED): this screen's own comment says "changing their mind
  // means calling/texting" — but had no phone number on it; the only one on
  // the whole portal sat ~10 sections down.
  describe('phone number (FIX9)', () => {
    const OLD_PHONE = process.env.NEXT_PUBLIC_PORTAL_PHONE;
    afterEach(() => {
      if (OLD_PHONE === undefined) delete process.env.NEXT_PUBLIC_PORTAL_PHONE;
      else process.env.NEXT_PUBLIC_PORTAL_PHONE = OLD_PHONE;
    });

    it('shows the default portal phone number with a tel: link', () => {
      delete process.env.NEXT_PUBLIC_PORTAL_PHONE;
      const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={declined} />);
      expect(html).toContain('(631) 517-0186');
      expect(html).toContain('href="tel:6315170186"');
    });

    it('uses the configured phone when set — same source as the rest of the portal', () => {
      process.env.NEXT_PUBLIC_PORTAL_PHONE = '(555) 111-2222';
      const html = renderToStaticMarkup(<AmendmentConsentCard quoteId="q1" amendment={declined} />);
      expect(html).toContain('(555) 111-2222');
      expect(html).toContain('href="tel:5551112222"');
    });
  });
});
