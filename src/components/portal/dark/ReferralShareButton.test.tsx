// Ledger #41 growth feature 1 — smoke + message-composition coverage for the
// share button. Rendered with react-dom/server (same approach as
// ReferralSection.test.tsx): useEffect never runs under renderToStaticMarkup,
// so the component deterministically renders its SSR-safe default — the
// `sms:` fallback link — which is exactly the branch worth asserting on
// without a browser/jsdom navigator.share to fake.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralShareButton, buildReferralShareMessage } from './ReferralShareButton';

const LINK = 'https://quote.yulelovelights.com/refer/ABCD1234';

describe('buildReferralShareMessage', () => {
  it("states the FRIEND's offer, never the referrer's own credit", () => {
    // This is the text a customer sends to their neighbour, so it must read as
    // a gift to the reader, not as what the sender earns. Both sides are $125
    // as of 2026-09-03, so the dollar figure no longer tells the two apart:
    // "credit" is the referrer-side word, and it must not appear here.
    const msg = buildReferralShareMessage(LINK, 2, 16, 170);
    expect(msg).toContain('$170');
    expect(msg).toContain('$125 off instead');
    expect(msg).toContain('2 free 16" spritzers');
    expect(msg).toContain('first booked install');
    expect(msg.toLowerCase()).not.toContain('credit');
  });

  it('embeds the exact referral link at the end of the message', () => {
    const msg = buildReferralShareMessage(LINK, 2, 16, 170);
    expect(msg.endsWith(LINK)).toBe(true);
  });

  it('reflects a different spritzer count/size/value if the constants ever change, never a hardcoded 170', () => {
    const msg = buildReferralShareMessage(LINK, 3, 20, 255);
    expect(msg).toContain('3 free 20" spritzers');
    expect(msg).toContain('$255');
  });

  it('offers the cash alternative, so a friend who is not doing lights still has a reason', () => {
    // Naldo, 2026-08-28: an event, wedding or bistro customer has no use
    // for spritzers. $125 matches the referrer's own credit (Naldo,
    // 2026-09-03: "125 per person") and is deliberately not the spritzers'
    // $170 retail value.
    const msg = buildReferralShareMessage(LINK, 2, 16, 170);
    expect(msg).toContain('$125 off instead');
    expect(msg).toContain('your choice');
  });

  it('never uses an em dash (voice rules)', () => {
    expect(buildReferralShareMessage(LINK, 2, 16, 170)).not.toContain('—');
  });

  // Review fix 8: this is the exact text a customer SENDS, the single
  // most-read sentence in the whole program (it's what lands in a
  // neighbor's phone). Every sibling copy block on the page was rewritten
  // to any-service framing; this one said "the holiday lights I'm getting"
  // and got missed.
  it('never says "holiday lights" -- service-neutral, like every other copy block on this page', () => {
    const msg = buildReferralShareMessage(LINK, 2, 16, 170);
    expect(msg.toLowerCase()).not.toContain('holiday lights');
    expect(msg).toContain('Yule Love Lights');
  });
});

describe('ReferralShareButton', () => {
  it('renders a Share control with an sms: fallback carrying the composed message', () => {
    const html = renderToStaticMarkup(
      <ReferralShareButton link={LINK} spritzerCount={2} spritzerSizeInches={16} spritzerValueUsd={170} />,
    );
    expect(html).toContain('Share');
    expect(html).toContain('sms:?&amp;body=');
    // The encoded message includes the link — assert on the encoded form
    // since renderToStaticMarkup HTML-escapes the href attribute.
    expect(html).toContain(encodeURIComponent(LINK));
  });
});
