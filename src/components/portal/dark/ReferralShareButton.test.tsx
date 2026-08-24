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
  it('states the friend\'s real offer in dollars (never the referrer\'s $125 credit) and still names the physical item', () => {
    const msg = buildReferralShareMessage(LINK, 2, 16, 170);
    expect(msg).toContain('$170 in free lighting');
    expect(msg).toContain('2 staked spotlights for your yard (16" spritzers)');
    expect(msg).toContain('first booked install');
    expect(msg).not.toContain('$125');
  });

  it('embeds the exact referral link at the end of the message', () => {
    const msg = buildReferralShareMessage(LINK, 2, 16, 170);
    expect(msg.endsWith(LINK)).toBe(true);
  });

  it('reflects a different spritzer count/size/value if the constants ever change, never a hardcoded 170', () => {
    const msg = buildReferralShareMessage(LINK, 3, 20, 255);
    expect(msg).toContain('$255 in free lighting');
    expect(msg).toContain('3 staked spotlights for your yard (20" spritzers)');
  });

  it('never uses an em dash (voice rules)', () => {
    expect(buildReferralShareMessage(LINK, 2, 16, 170)).not.toContain('—');
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
