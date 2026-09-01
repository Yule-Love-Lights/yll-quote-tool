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
//
// naldo/referral-link-preview: the two runtime fail-safes (an implausible
// ?c= falls back to the email form; a resolved-but-linkless response drops
// back to the email form instead of a phone-only dead end) live in
// handleSubmit and the CONTACT_ID_RE gate on hasContactId -- the SECOND one
// is a state transition driven by a fetch response, which this file's
// renderToStaticMarkup approach cannot exercise (same limitation the file
// header above already names for every other interactive path here; see
// the PR description for the manual/browser check that covers it instead).
// The FIRST fail-safe (the plausibility gate) IS exercised below, since it
// only depends on the initial `contactId` prop.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { spritzerRetailValueUsd } from '@/lib/referralSpritzerValue';
import {
  ReferralLinkSuccess,
  ReferralLinkErrorMessage,
  ReferralLinkReady,
  ReferralLinkForm,
} from './ReferralLinkForm';

// naldo/referral-link-preview: the reward terms every ReferralLinkReady /
// ReferralLinkForm call site now requires, so a fixture drift can never
// silently disagree with the real program constants (src/lib/referrals.ts +
// referralSpritzerValue.ts) the way a set of hand-typed literals could.
const REWARD_TERMS = {
  creditUsd: 125,
  creditExpiryYears: 2,
  spritzerCount: 2,
  spritzerSizeInches: 16,
  spritzerValueUsd: spritzerRetailValueUsd(2, 16),
};

// A plausible GHL contact id for test fixtures: mirrors CONTACT_ID_RE in
// both ReferralLinkForm.tsx and src/app/api/referrals/request-link/
// route.ts (16-32 alphanumeric chars, no hyphens) -- 20 chars, matching the
// measured real-world length both files document.
const PLAUSIBLE_CONTACT_ID = 'ghlcontactidxyz12345';

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

describe('ReferralLinkReady (naldo/referral-link-personalized, review fix 1; copy corrected naldo/referral-link-preview)', () => {
  const LINK = 'https://quote.yulelovelights.com/refer/CODE1234';

  it('shows the link and an obvious way to copy it', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain(LINK);
    // ReferralLinkCopy's own copy button, reused here rather than rebuilt.
    expect(html).toContain('Copy link');
  });

  it('also shows their own real page live, in a phone frame, pointed at their exact link (PIECE 3b)', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain(`src="${LINK}"`);
  });

  // Review fix 7: PhoneFrame's `title` prop lands on an aria-hidden,
  // tabIndex={-1} iframe (PhoneFrame.tsx), so it reaches nobody. This is
  // the ONLY visible signal that this second phone frame is now the
  // person's real, live page, not another copy of the sample they just saw.
  it('gives the live phone frame a visible caption (its title attribute is aria-hidden and reaches nobody)', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('This is your real page, live right now.');
  });

  it('the link and Copy button still render if the phone frame is absent (the frame is decoration, the link is the deliverable)', () => {
    // PhoneFrame degrades to `null` on a failed load (see PhoneFrame.test.tsx),
    // which can only remove ITSELF from the tree if it is a sibling of
    // ReferralLinkCopy, never a wrapper around it. Proven structurally here
    // rather than by simulating a load failure: renderToStaticMarkup never
    // fires an iframe's onError (no browser underneath it), so there is no
    // way to drive PhoneFrame's internal `failed` state through the public
    // render path in this test setup, the same limitation every interactive
    // test in this file already works around (see the file header).
    const source = readFileSync(join(__dirname, 'ReferralLinkForm.tsx'), 'utf8');
    const readyBody = source.slice(
      source.indexOf('export function ReferralLinkReady'),
      source.indexOf('export function ReferralLinkErrorMessage'),
    );
    // <ReferralLinkCopy .../> and <PhoneFrame .../> must be independent,
    // self-closing sibling elements, i.e. neither is nested inside the
    // other's own JSX tag.
    expect(readyBody).toMatch(/<ReferralLinkCopy[\s\S]*?\/>/);
    expect(readyBody).toMatch(/<PhoneFrame[^>]*\/>/);
    expect(readyBody.indexOf('<ReferralLinkCopy')).toBeLessThan(readyBody.indexOf('<PhoneFrame'));
  });

  it('names the person in the heading when a name is available', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    // React escapes ' to &#x27; in serialized text content.
    expect(html).toContain('Riley&#x27;s referral link is ready.');
    expect(html).not.toContain('>Your link is ready.<');
  });

  it('falls back to a neutral, non-possessive heading when no name is available', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name={null} {...REWARD_TERMS} />);
    expect(html).toContain('This referral link is ready.');
    // Never claims ownership ("Your link") when there is nobody to name.
    expect(html).not.toContain('Your link is ready.');
  });

  it('never claims the visitor was emailed a copy (review fix 1: that claim is false for a forwarded viewer)', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).not.toContain('emailed you');
  });

  it('gives a forwarded viewer an obvious escape hatch to their own link', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('Forwarded to you?');
    expect(html).toContain('Riley');
    expect(html).toContain('href="/referral-link"');
    expect(html).toContain('Get your own referral link');
    // The escape hatch itself must carry no query string, so it lands on
    // the typed-email form, never re-resolving the same forwarded id.
    expect(html).not.toContain('href="/referral-link?');
  });

  it('the escape hatch still reads sensibly with no name available', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name={null} {...REWARD_TERMS} />);
    expect(html).toContain('someone else');
    expect(html).toContain('href="/referral-link"');
  });

  it('states the credit is good toward any Yule Love Lights service, never a "next job"/"next season" same-service repeat', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('$125');
    expect(html).toContain('any Yule Love Lights service');
    expect(html).not.toContain('next job');
    expect(html).not.toContain('next season');
  });

  it('frames the credit as the upgrade it is: a holiday customer can put it toward permanent lighting', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('permanent lighting');
  });

  it('states the stacking multiple and the credit-vs-cash distinction plainly', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('stacks');
    expect(html).toContain('$250');
    expect(html).toContain('not cash');
    expect(html).toContain(`good for ${REWARD_TERMS.creditExpiryYears} years`);
  });

  // Review fix 5: this screen is shown before any friend has booked, so
  // "good for 2 years" alone reads as "from today." The expiry actually
  // stamps at the FRIEND's booking (accrueOnBooking, src/lib/referrals.ts).
  it('makes clear the expiry clock starts at the friend\'s booking, not today', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('from when your friend');
    expect(html).toContain('books');
  });

  // Review fix 6: consumeCredits (src/lib/referrals.ts) flips the referrer's
  // ENTIRE booked balance to spent in one shot, capped at the job subtotal
  // -- a $250 balance applied to a $180 job burns all $250. The referrer
  // never sees the balance screen staff do, so the sell copy that promotes
  // stacking now discloses it applies together against one job.
  it('discloses that the whole balance applies together to one job when redeemed (never alarming, no accrual-logic change)', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('applies together to one job');
  });

  it('dollarizes the friend spritzer reward and still names the physical item (never hardcodes 170)', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('$170');
    expect(html).toContain('$150 off instead');
    expect(html).toContain('free 16&quot; spritzers');
    expect(html).toContain('16&quot; spritzers');
    // A DIFFERENT spritzerValueUsd must show up verbatim -- proves the
    // number is threaded through as a prop, not a second hardcoded literal.
    const htmlWithDifferentValue = renderToStaticMarkup(
      <ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} spritzerValueUsd={255} />,
    );
    expect(htmlWithDifferentValue).toContain('$255');
  });

  it('renders a real Share control next to the copy button, sourced from the same reward terms', () => {
    const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name="Riley" {...REWARD_TERMS} />);
    expect(html).toContain('Share');
  });

  it('never uses an em dash and never uses the banned words', () => {
    for (const name of ['Riley', null]) {
      const html = renderToStaticMarkup(<ReferralLinkReady link={LINK} name={name} {...REWARD_TERMS} />);
      expect(html).not.toContain('—');
      for (const banned of ['unlock', 'leverage', 'delve']) {
        expect(html.toLowerCase()).not.toContain(banned);
      }
    }
  });
});

describe('ReferralLinkForm initial render (naldo/referral-link-personalized)', () => {
  // Bar item: "The page with no c still renders the email form." page.tsx
  // hands contactId=undefined down whenever ?c= is absent or blank, so this
  // is that exact case at the point where the behavior actually lives.
  it('with no contactId: renders the typed-email form, unchanged', () => {
    const html = renderToStaticMarkup(<ReferralLinkForm {...REWARD_TERMS} />);
    expect(html).toContain('id="referral-link-email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('Send me my link');
    expect(html).not.toContain('Get my referral link');
  });

  it('with a plausible contactId: hides the email input and shows a single button', () => {
    const html = renderToStaticMarkup(<ReferralLinkForm contactId={PLAUSIBLE_CONTACT_ID} {...REWARD_TERMS} />);
    expect(html).not.toContain('id="referral-link-email"');
    expect(html).not.toContain('type="email"');
    expect(html).toContain('Get my referral link');
    expect(html).not.toContain('Send me my link');
  });

  // Fail-safe 1 (naldo/referral-link-preview): an implausible ?c= value
  // (mangled, truncated, hand-edited -- anything that doesn't match
  // CONTACT_ID_RE) must never surface the one-click button at all, since
  // that button could only ever fail. It renders the exact same typed-email
  // form as no ?c=.
  describe('fail-safe 1: an implausible contactId never shows the one-click button', () => {
    it.each([
      ['too short', 'short123'],
      ['contains a hyphen (not alphanumeric)', 'not-a-real-contact-id'],
      ['far too long', 'a'.repeat(40)],
      ['a sentence, not an id', 'please help me find my link'],
    ])('%s', (_label, badContactId) => {
      const html = renderToStaticMarkup(<ReferralLinkForm contactId={badContactId} {...REWARD_TERMS} />);
      expect(html).toContain('id="referral-link-email"');
      expect(html).toContain('Send me my link');
      expect(html).not.toContain('Get my referral link');
    });
  });

  it('the honeypot field is present in both modes', () => {
    const withoutContactId = renderToStaticMarkup(<ReferralLinkForm {...REWARD_TERMS} />);
    const withContactId = renderToStaticMarkup(
      <ReferralLinkForm contactId={PLAUSIBLE_CONTACT_ID} {...REWARD_TERMS} />,
    );
    expect(withoutContactId).toContain('name="company"');
    expect(withContactId).toContain('name="company"');
  });

  it('never uses an em dash in either mode', () => {
    expect(renderToStaticMarkup(<ReferralLinkForm {...REWARD_TERMS} />)).not.toContain('—');
    expect(
      renderToStaticMarkup(<ReferralLinkForm contactId={PLAUSIBLE_CONTACT_ID} {...REWARD_TERMS} />),
    ).not.toContain('—');
  });

  // Review fix 8 (this round): the in-flight reassurance line is gated on
  // status === 'submitting', which the INITIAL (idle) render this file's
  // convention exercises never reaches (renderToStaticMarkup never fires
  // onSubmit; see the file header for why this repo tests it this way).
  // This only proves the line is absent before any submit, not that it
  // appears during one; that leg was checked in the browser.
  it('the in-flight reassurance line is absent before any submit', () => {
    expect(renderToStaticMarkup(<ReferralLinkForm {...REWARD_TERMS} />)).not.toContain(
      'This can take a few seconds.',
    );
    expect(
      renderToStaticMarkup(<ReferralLinkForm contactId={PLAUSIBLE_CONTACT_ID} {...REWARD_TERMS} />),
    ).not.toContain('This can take a few seconds.');
  });

  it('the fail-safe-2 explanatory note is absent on the initial render (only shown after a failed one-click attempt)', () => {
    expect(
      renderToStaticMarkup(<ReferralLinkForm contactId={PLAUSIBLE_CONTACT_ID} {...REWARD_TERMS} />),
    ).not.toContain('We could not pull up your link automatically');
  });
});
