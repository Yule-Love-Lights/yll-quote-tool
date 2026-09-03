// Ledger #41 — the booked-page referral section. Renders with
// react-dom/server (no jsdom / testing-library needed — this component and its
// ReferralLinkCopy child have zero Next.js-specific imports) so the exact
// customer-facing copy is a real assertion, not a description of intent.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralSection } from './ReferralSection';

const PROPS = { creditUsd: 125, spritzerCount: 2, spritzerSizeInches: 16 };

describe('ReferralSection', () => {
  it("states the referrer's credit as $125, never the old $150 figure", () => {
    // $150 was a wrong referrer-credit figure, corrected to $125. It briefly
    // returned as the friend's cash alternative, then went away again on
    // 2026-09-03 when Naldo set both sides to $125. So the page should carry
    // no $150 anywhere at all.
    const html = renderToStaticMarkup(<ReferralSection referralLink={null} {...PROPS} />);
    expect(html).toContain('$125 credit');
    expect(html).not.toContain('$150');
  });

  it('states both sides of the offer: referrer credit (dollarized, good toward any service) + friend spritzers (dollarized)', () => {
    const html = renderToStaticMarkup(<ReferralSection referralLink={null} {...PROPS} />);
    expect(html).toContain('$125 credit');
    expect(html).toContain('any Yule Love Lights service');
    expect(html).toContain('$170');
    expect(html).toContain('$125 off instead');
    expect(html).toContain('2 free 16&quot; spritzers');
    expect(html).toContain('16&quot; spritzers');
    expect(html).toContain('first booked');
    // The old undollarized phrasing and the stale "next season" framing must
    // both be gone (naldo/referral-link-preview).
    expect(html).not.toContain('staked spotlights');
    expect(html).not.toContain('next season');
  });

  // Review fix 6: consumeCredits (src/lib/referrals.ts) flips the referrer's
  // ENTIRE booked balance to spent in one shot, capped at the job subtotal,
  // so a bigger balance than the job costs loses the difference. This page
  // promotes stacking ("It stacks, so there is no limit...") with no
  // warning of that, so it now discloses that a redemption applies the
  // whole balance together to one job.
  it('discloses that the whole balance applies together to one job when redeemed (never alarming, no accrual-logic change)', () => {
    const html = renderToStaticMarkup(<ReferralSection referralLink={null} {...PROPS} />);
    expect(html).toContain('applies together to one job');
  });

  // Review fix 9: "You get $125 credit... Your friend gets $170 in free
  // lighting" used to read as a direct comparison in one sentence. Now
  // split into two paragraphs, and the friend's reward is framed as
  // something the referrer is GIVING, not a competing prize.
  it('does not present the referrer credit and the friend gift as a side-by-side comparison', () => {
    const html = renderToStaticMarkup(<ReferralSection referralLink={null} {...PROPS} />);
    expect(html).not.toContain('bistro. Your friend gets');
    expect(html).toContain('giving your friend');
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
