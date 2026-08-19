// naldo/referral-self-serve + naldo/referral-link-personalized: the
// self-serve referral link request page's post-submit confirmation and
// error copy. Renders with react-dom/server, same approach as
// src/app/refer/[code]/ReferralForm.test.tsx, no jsdom needed for a
// pure-render component.
//
// The confirmation copy is fixed, from the brief, and must render verbatim
// regardless of whether the typed email matched a real GHL contact
// (ReferralLinkSuccess takes no props, exactly because there is nothing it
// is allowed to vary on).
//
// ReferralLinkForm's INTERACTIVE behavior (typing, submitting, the fetch
// round-trip) is NOT exercised here: this repo's test setup has no
// jsdom/testing-library, so every component test in this codebase covers
// copy via a pure-render sub-component instead (see ReferralHeroBadge.
// test.tsx for the same approach). ReferralLinkErrorMessage is that
// extraction for the error state, review fix 1, and ReferralLinkReady is
// the equivalent for the contact-id path's "here is your link" state.
//
// ReferralLinkForm itself IS rendered below, but only for its INITIAL,
// pre-interaction static markup (renderToStaticMarkup never fires an
// onSubmit/onChange handler), to prove which fields a given `contactId`
// prop shows or hides. That is a one-shot render, not an interaction test.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralLinkSuccess, ReferralLinkErrorMessage, ReferralLinkReady, ReferralLinkForm } from './ReferralLinkForm';

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

describe('ReferralLinkReady (naldo/referral-link-personalized)', () => {
  const LINK = 'https://quote.yulelovelights.com/refer/CODE1234';

  it('shows the link and an obvious way to copy it', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} />);
    expect(html).toContain('Your link is ready.');
    expect(html).toContain(LINK);
    // ReferralLinkCopy's own copy button, reused here rather than rebuilt.
    expect(html).toContain('Copy link');
  });

  it('never uses an em dash and never uses the banned words', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} />);
    expect(html).not.toContain('—');
    for (const banned of ['unlock', 'leverage', 'delve']) {
      expect(html.toLowerCase()).not.toContain(banned);
    }
  });
});

describe('ReferralLinkForm initial render (naldo/referral-link-personalized)', () => {
  // Bar item: "The page with no c still renders the email form." page.tsx
  // hands contactId=undefined down whenever ?c= is absent or blank, so this
  // is that exact case at the point where the behavior actually lives.
  it('with no contactId: renders the typed-email form, unchanged', () => {
    const html = renderToStaticMarkup(<ReferralLinkForm />);
    expect(html).toContain('id="referral-link-email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('Send me my link');
    expect(html).not.toContain('Get my referral link');
  });

  it('with a contactId: hides the email input and shows a single button', () => {
    const html = renderToStaticMarkup(<ReferralLinkForm contactId="ghl-contact-xyz" />);
    expect(html).not.toContain('id="referral-link-email"');
    expect(html).not.toContain('type="email"');
    expect(html).toContain('Get my referral link');
    expect(html).not.toContain('Send me my link');
  });

  it('the honeypot field is present in both modes', () => {
    const withoutContactId = renderToStaticMarkup(<ReferralLinkForm />);
    const withContactId = renderToStaticMarkup(<ReferralLinkForm contactId="ghl-contact-xyz" />);
    expect(withoutContactId).toContain('name="company"');
    expect(withContactId).toContain('name="company"');
  });

  it('never uses an em dash in either mode', () => {
    expect(renderToStaticMarkup(<ReferralLinkForm />)).not.toContain('—');
    expect(renderToStaticMarkup(<ReferralLinkForm contactId="ghl-contact-xyz" />)).not.toContain('—');
  });
});
