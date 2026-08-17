// naldo/referral-self-serve: the self-serve referral link request page's
// post-submit confirmation. Renders with react-dom/server, same approach as
// src/app/refer/[code]/ReferralForm.test.tsx, no jsdom needed for a
// pure-render component.
//
// The confirmation copy is fixed, from the brief, and must render verbatim
// regardless of whether the typed email matched a real GHL contact (this
// component takes no props, exactly because there is nothing it is allowed
// to vary on).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralLinkSuccess } from './ReferralLinkForm';

describe('ReferralLinkSuccess', () => {
  it('shows the exact confirmation copy from the brief, verbatim', () => {
    const html = renderToStaticMarkup(<ReferralLinkSuccess />);
    expect(html).toContain('Check your inbox.');
    // React escapes ' to &#x27; even in plain text content (verified against
    // this component's actual renderToStaticMarkup output), so the source
    // apostrophes are asserted here in their escaped form.
    expect(html).toContain(
      "If that email&#x27;s in our system, your referral link is on its way, give it a few minutes and peek at spam if it&#x27;s not there yet. Still nothing by tonight? Call or text us at (631) 517-0186 and we&#x27;ll send it right over.",
    );
  });

  it('never uses an em dash', () => {
    const html = renderToStaticMarkup(<ReferralLinkSuccess />);
    expect(html).not.toContain('—');
  });
});
