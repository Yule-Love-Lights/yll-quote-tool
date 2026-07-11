// Ledger #41 growth feature 2 — the operator-facing referral profile panel.
// Pure/presentational, rendered with react-dom/server (same style as
// ReferralSection.test.tsx) since it takes plain props with no data fetching
// of its own.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomerReferralPanel } from './CustomerReferralPanel';
import type { ReferralRow } from '@/lib/referrals';

function makeReferral(over: Partial<ReferralRow> = {}): ReferralRow {
  return {
    id: crypto.randomUUID(),
    referrer_customer_id: 'c1',
    referee_quote_id: null,
    referee_contact_name: 'Sam Rivera',
    referee_contact_email: null,
    referee_contact_phone: null,
    source: 'link',
    status: 'pending',
    amount_usd: 125,
    booked_at: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...over,
  };
}

const LINK = 'https://quote.yulelovelights.com/refer/ABCD1234';
const SAMPLE_SVG = '<svg viewBox="0 0 41 41"><path d="M0 0h1v1H0z" /></svg>';

describe('CustomerReferralPanel', () => {
  it('shows a clear empty state when the customer has no referral link', () => {
    const html = renderToStaticMarkup(
      <CustomerReferralPanel referralLink={null} creditBalanceUsd={0} referrals={[]} qrSvg={null} />,
    );
    expect(html).toContain('No referral link yet');
    expect(html).not.toContain('credit balance');
  });

  it('shows the personal link, credit balance, and QR code when available', () => {
    const html = renderToStaticMarkup(
      <CustomerReferralPanel referralLink={LINK} creditBalanceUsd={250} referrals={[]} qrSvg={SAMPLE_SVG} />,
    );
    expect(html).toContain(LINK);
    expect(html).toContain('$250');
    expect(html).toContain('credit balance');
    expect(html).toContain('<svg');
    expect(html).toContain('Print for a yard sign or door hanger');
  });

  it('renders without the QR block when generation failed (fail-open)', () => {
    const html = renderToStaticMarkup(
      <CustomerReferralPanel referralLink={LINK} creditBalanceUsd={0} referrals={[]} qrSvg={null} />,
    );
    expect(html).toContain(LINK);
    expect(html).not.toContain('Print for a yard sign');
  });

  it('shows "hasn\'t referred anyone yet" when the referrals list is empty', () => {
    const html = renderToStaticMarkup(
      <CustomerReferralPanel referralLink={LINK} creditBalanceUsd={0} referrals={[]} qrSvg={null} />,
    );
    expect(html).toContain("hasn&#x27;t referred anyone yet");
  });

  it('lists every referred friend with a name and status label', () => {
    const html = renderToStaticMarkup(
      <CustomerReferralPanel
        referralLink={LINK}
        creditBalanceUsd={125}
        referrals={[
          makeReferral({ referee_contact_name: 'Jordan Smith', status: 'booked' }),
          makeReferral({ referee_contact_name: 'Alex Chen', status: 'pending' }),
          makeReferral({ referee_contact_name: 'Riley Park', status: 'credited' }),
        ]}
        qrSvg={null}
      />,
    );
    expect(html).toContain('Jordan Smith');
    expect(html).toContain('Booked');
    expect(html).toContain('Alex Chen');
    expect(html).toContain('Pending');
    expect(html).toContain('Riley Park');
    expect(html).toContain('Credited');
    expect(html).toContain('Referred friends (3)');
  });

  it('falls back to email or phone when a referee has no name on file', () => {
    const html = renderToStaticMarkup(
      <CustomerReferralPanel
        referralLink={LINK}
        creditBalanceUsd={0}
        referrals={[makeReferral({ referee_contact_name: null, referee_contact_email: 'sam@example.com' })]}
        qrSvg={null}
      />,
    );
    expect(html).toContain('sam@example.com');
  });
});
