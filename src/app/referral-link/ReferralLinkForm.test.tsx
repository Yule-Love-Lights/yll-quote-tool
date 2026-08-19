// naldo/referral-self-serve: the self-serve referral link request page's
// post-submit confirmation and error copy. Renders with react-dom/server,
// same approach as src/app/refer/[code]/ReferralForm.test.tsx, no jsdom
// needed for a pure-render component.
//
// The confirmation copy is fixed, from the brief, and must render verbatim
// regardless of whether the typed email matched a real GHL contact (this
// component takes no props, exactly because there is nothing it is allowed
// to vary on).
//
// ReferralLinkForm itself (the stateful <form>) is NOT rendered here: this
// repo's test setup has no jsdom/testing-library, so every component test
// in this codebase covers copy via a pure-render sub-component instead (see
// ReferralHeroBadge.test.tsx for the same approach). ReferralLinkErrorMessage
// is that extraction for the error state, review fix 1.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralLinkSuccess, ReferralLinkErrorMessage } from './ReferralLinkForm';

describe('ReferralLinkSuccess', () => {
  it('shows the exact confirmation copy from the brief, verbatim, with a tappable phone link', () => {
    const html = renderToStaticMarkup(<ReferralLinkSuccess />);
    expect(html).toContain('Check your inbox.');
    // React escapes ' to &#x27; even in plain text content (verified against
    // this component's actual renderToStaticMarkup output), so the source
    // apostrophes are asserted here in their escaped form.
    expect(html).toContain(
      "If that email&#x27;s in our system, your referral link is on its way, give it a few minutes and peek at spam if it&#x27;s not there yet. Still nothing by tonight? Call or text us at",
    );
    expect(html).toContain("and we&#x27;ll send it right over.");
    // Review fix 1: the phone number is a real tel: link, not plain text.
    expect(html).toContain('href="tel:6315170186"');
    expect(html).toContain('>(631) 517-0186</a>');
  });

  it('never uses an em dash', () => {
    const html = renderToStaticMarkup(<ReferralLinkSuccess />);
    expect(html).not.toContain('—');
  });
});

describe('ReferralLinkErrorMessage (review fix 1)', () => {
  it('falls back to the generic copy with a tappable phone link when there is no server-supplied message', () => {
    // Covers BOTH error states ReferralLinkForm's handleSubmit can reach: a
    // non-ok JSON response with no `error` field, and the catch-block
    // network-failure case. This page has no header, nav, or footer, so the
    // phone number here is the only way a visitor who hits either can reach
    // a person.
    const html = renderToStaticMarkup(<ReferralLinkErrorMessage serverError={null} />);
    expect(html).toContain('Something went wrong. Please call or text us instead at');
    expect(html).toContain('href="tel:6315170186"');
    expect(html).toContain('>(631) 517-0186</a>');
  });

  it('shows a genuine server-supplied message verbatim, with no phone number attached', () => {
    const html = renderToStaticMarkup(<ReferralLinkErrorMessage serverError="A valid email address is required" />);
    expect(html).toBe('A valid email address is required');
    expect(html).not.toContain('517-0186');
  });

  it('never uses an em dash', () => {
    const html = renderToStaticMarkup(<ReferralLinkErrorMessage serverError={null} />);
    expect(html).not.toContain('—');
  });
});
