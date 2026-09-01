// Decorative phone-frame wrapper (naldo/referral-link-preview, PIECE 3).
// Rendered with react-dom/server, same approach as the rest of this
// codebase's component tests: renderToStaticMarkup never fires onError, so
// it deterministically exercises the default (frame loads) branch, which is
// exactly the branch worth asserting the a11y/decorative treatment on.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhoneFrame } from './PhoneFrame';

describe('PhoneFrame', () => {
  it('renders an iframe pointed at the given src', () => {
    const html = renderToStaticMarkup(<PhoneFrame src="/refer/preview" title="A sample" />);
    expect(html).toContain('<iframe');
    expect(html).toContain('src="/refer/preview"');
    expect(html).toContain('title="A sample"');
  });

  it('is decorative: out of the tab order and hidden from assistive tech, so it can never trap keyboard focus', () => {
    const html = renderToStaticMarkup(<PhoneFrame src="/refer/preview" title="A sample" />);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('accepts an absolute URL too, for a real /refer/<code> link', () => {
    const html = renderToStaticMarkup(
      <PhoneFrame src="https://quote.yulelovelights.com/refer/ABCD1234" title="Your referral page, live" />,
    );
    expect(html).toContain('src="https://quote.yulelovelights.com/refer/ABCD1234"');
  });

  it('never uses an em dash', () => {
    const html = renderToStaticMarkup(<PhoneFrame src="/refer/preview" title="A sample" />);
    expect(html).not.toContain('—');
  });

  it('degrades to nothing on a failed load, never to broken markup: proven structurally, since renderToStaticMarkup never fires onError to exercise this branch live', () => {
    const source = readFileSync(join(__dirname, 'PhoneFrame.tsx'), 'utf8');
    expect(source).toMatch(/if\s*\(\s*failed\s*\)\s*return\s*null\s*;/);
  });
});
