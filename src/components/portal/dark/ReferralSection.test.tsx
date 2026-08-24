// Ledger #41 — the booked-page referral section. Renders with
// react-dom/server (no jsdom / testing-library needed — this component and its
// ReferralLinkCopy child have zero Next.js-specific imports) so the exact
// customer-facing copy is a real assertion, not a description of intent.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralSection } from './ReferralSection';

const PROPS = { creditUsd: 125, spritzerCount: 2, spritzerSizeInches: 16 };

describe('ReferralSection', () => {
  it('states the $125 credit and never the old $150 figure', () => {
    const html = renderToStaticMarkup(<ReferralSection referralLink={null} {...PROPS} />);
    expect(html).toContain('$125');
    expect(html).not.toContain('$150');
  });

  it('states both sides of the offer: referrer credit (dollarized, good toward any service) + friend spritzers (dollarized)', () => {
    const html = renderToStaticMarkup(<ReferralSection referralLink={null} {...PROPS} />);
    expect(html).toContain('$125 credit');
    expect(html).toContain('any Yule Love Lights service');
    expect(html).toContain('$170 in free lighting');
    expect(html).toContain('2 staked spotlights');
    expect(html).toContain('16&quot; spritzers');
    expect(html).toContain('first booked');
    // The old undollarized phrasing and the stale "next season" framing must
    // both be gone (naldo/referral-link-preview).
    expect(html).not.toContain('2 free 16&quot; spritzers');
    expect(html).not.toContain('next season');
  });

  it('renders the personal referral link + copy control when one is available', () => {
    const html = renderToStaticMarkup(
      <ReferralSection referralLink="https://quote.yulelovelights.com/refer/ABCD1234" {...PROPS} />,
    );
    expect(html).toContain('https://quote.yulelovelights.com/refer/ABCD1234');
    expect(html).toContain('Copy link');
  });

  it('renders the Share button next to the copy button (growth feature 1)', () => {
    const html = renderToStaticMarkup(
      <ReferralSection referralLink="https://quote.yulelovelights.com/refer/ABCD1234" {...PROPS} />,
    );
    expect(html).toContain('Share');
  });

  it('renders the QR code when an svg is supplied, subordinate to the link+share (growth feature 2)', () => {
    const html = renderToStaticMarkup(
      <ReferralSection
        referralLink="https://quote.yulelovelights.com/refer/ABCD1234"
        qrSvg={'<svg><path d="M0 0h1v1H0z" /></svg>'}
        {...PROPS}
      />,
    );
    expect(html).toContain('or scan to share');
    expect(html).toContain('<svg>');
  });

  it('omits the QR block entirely when no svg is supplied (fail-open)', () => {
    const html = renderToStaticMarkup(
      <ReferralSection referralLink="https://quote.yulelovelights.com/refer/ABCD1234" {...PROPS} />,
    );
    expect(html).not.toContain('or scan to share');
  });

  it('falls back to copy-only (no link, no copy button) when the quote has no customer row', () => {
    const html = renderToStaticMarkup(<ReferralSection referralLink={null} {...PROPS} />);
    expect(html).not.toContain('Copy link');
    expect(html).toContain('mention your name');
  });

  it('never uses an em dash in the customer-facing copy (voice rules)', () => {
    const html = renderToStaticMarkup(
      <ReferralSection referralLink="https://quote.yulelovelights.com/refer/ABCD1234" {...PROPS} />,
    );
    expect(html).not.toContain('—');
  });
});
