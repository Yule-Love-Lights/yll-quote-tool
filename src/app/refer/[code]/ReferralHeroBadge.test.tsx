// naldo/referral-self-serve: the referral page's "One of our real Long
// Island installs" hero badge. Renders with react-dom/server, same approach
// as ReferralForm.test.tsx, no jsdom needed for a pure-render component.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralHeroBadge } from './ReferralHeroBadge';

describe('ReferralHeroBadge', () => {
  it('renders on the photo branch (a fallback gallery photo of someone else\'s house)', () => {
    const html = renderToStaticMarkup(<ReferralHeroBadge kind="photo" />);
    expect(html).toContain('One of our real Long Island installs');
  });

  it('renders nothing on the design branch (the referrer\'s own approved design)', () => {
    const html = renderToStaticMarkup(<ReferralHeroBadge kind="design" />);
    expect(html).toBe('');
  });
});
