// #41 V2: the referral landing page's post-submit confirmation screen.
// Renders with react-dom/server (same approach as ReferralSection.test.tsx /
// ReferredByPicker.test.tsx: no jsdom needed for a pure-render component).
// Mocks @/lib/analytics/posthog because ReferralForm.tsx imports `track` at
// module scope (only used inside the stateful ReferralForm, not
// ReferralSuccessScreen, but importing the file evaluates that import too).

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/analytics/posthog', () => ({ track: () => {} }));

import { ReferralSuccessScreen } from './ReferralForm';

const FRIEND_SPRITZERS = { count: 2, sizeInches: 16 };

describe('ReferralSuccessScreen: no preview (flag off / capped / deduped / failed)', () => {
  it('shows the original "we will text you" copy, unchanged', () => {
    const html = renderToStaticMarkup(
      <ReferralSuccessScreen preview={null} friendSpritzers={FRIEND_SPRITZERS} />,
    );
    expect(html).toContain('We are on it.');
    expect(html).toContain('Expect a text from us today, and we will get you a free quote.');
    expect(html).not.toContain('ready to glow');
  });

  it('does not promise a preview the visitor will not receive', () => {
    const html = renderToStaticMarkup(
      <ReferralSuccessScreen preview={null} friendSpritzers={FRIEND_SPRITZERS} />,
    );
    expect(html).not.toContain('preview');
  });
});

describe('ReferralSuccessScreen: preview present (#41 V2 auto-analyze succeeded)', () => {
  const preview = {
    photoDataUrl: 'data:image/jpeg;base64,abc123',
    formattedAddress: '123 Main St, Smithtown, NY 11787',
    footageEstimate: 42,
    lines: [{ points: [[0.1, 0.2], [0.3, 0.4]] as [number, number][], label: 'front roofline ~42ft' }],
  };

  it('shows the analyzed-photo headline, the address, and the friend offer', () => {
    const html = renderToStaticMarkup(
      <ReferralSuccessScreen preview={preview} friendSpritzers={FRIEND_SPRITZERS} />,
    );
    expect(html).toContain('ready to glow');
    expect(html).toContain('123 Main St, Smithtown, NY 11787');
    expect(html).toContain('2 free');
    expect(html).toContain('16&quot; spritzers');
    expect(html).not.toContain('We are on it.');
  });

  it('renders the photo and a roofline overlay line', () => {
    const html = renderToStaticMarkup(
      <ReferralSuccessScreen preview={preview} friendSpritzers={FRIEND_SPRITZERS} />,
    );
    expect(html).toContain('data:image/jpeg;base64,abc123');
    expect(html).toContain('<svg');
    expect(html).toContain('polyline');
  });

  it('still shows the photo even when the analyzer found no roofline segments', () => {
    const html = renderToStaticMarkup(
      <ReferralSuccessScreen preview={{ ...preview, lines: [] }} friendSpritzers={FRIEND_SPRITZERS} />,
    );
    expect(html).toContain('data:image/jpeg;base64,abc123');
  });
});

describe('ReferralSuccessScreen: voice rules', () => {
  it('never uses an em dash in either state', () => {
    const preview = {
      photoDataUrl: 'data:image/jpeg;base64,abc123',
      formattedAddress: '123 Main St, Smithtown, NY 11787',
      footageEstimate: 42,
      lines: [],
    };
    const off = renderToStaticMarkup(<ReferralSuccessScreen preview={null} friendSpritzers={FRIEND_SPRITZERS} />);
    const on = renderToStaticMarkup(<ReferralSuccessScreen preview={preview} friendSpritzers={FRIEND_SPRITZERS} />);
    expect(off).not.toContain('—');
    expect(on).not.toContain('—');
  });
});
