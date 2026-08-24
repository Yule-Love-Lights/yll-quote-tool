'use client';

// Self-serve referral link request form (naldo/referral-self-serve +
// naldo/referral-link-personalized). POSTs to /api/referrals/request-link.
//
// Two modes, picked by whether a `contactId` prop is present (set by the
// server component from an optional ?c=<ghl-contact-id> query param, itself
// only ever set by a GoHighLevel merge field, never typed by a visitor):
//
// - No contactId: the original typed-email flow. The route responds
//   ok:true whether or not the typed email matched a GHL contact, so
//   ReferralLinkSuccess below is the ONLY confirmation state this mode ever
//   shows, by design: the copy never reveals whether an email belongs to a
//   YLL customer.
// - A contactId: a single button, no typing. The route resolves the id
//   directly and, on a match, returns the referral URL (and a firstName) in
//   the same response, so ReferralLinkReady below can show it immediately.
//   Review fix 3 (prior round): a contactId that fails to resolve gets the
//   exact same ok:true, no-link response the email path uses (route.ts's
//   file header explains why).
//
// naldo/referral-link-preview, TWO fail-safes so nobody ever has to phone
// the office just to get their link:
//   1. CONTACT_ID_RE below mirrors the server's own format guard (same
//      constant, src/app/api/referrals/request-link/route.ts, same measured
//      real-world format: 2,187 real GHL contact ids, all 20-char mixed-case
//      alphanumeric). An implausible ?c= value (stripped, mangled, hand-
//      edited) never even reaches the one-click button, hasContactId is
//      false for it, so this renders the normal typed-email form, same as
//      no ?c= at all.
//   2. A contactId that LOOKS plausible but still comes back with no
//      referralUrl (a stale id, a merged contact, a transient GHL error)
//      used to dead-end on a phone-number-only screen
//      (ReferralLinkContactIdFailed, now removed: it became unreachable
//      the moment this fail-safe replaced it). It now drops back to the
//      SAME typed-email form instead, submittable immediately: see
//      `contactIdFailed` state and `useContactIdFlow` below.
//
// Never imports highlevel.ts or customers.ts here, this component only
// ever fetch()es the API. naldo/referral-link-preview, PIECE 6: the reward
// terms (the credit amount, its expiry, the spritzer count/size/dollar
// value) DO come from src/lib/referrals.ts (+ referralSpritzerValue.ts) now,
// but only as plain numbers page.tsx reads server-side and passes down as
// props, never as a direct import here, mirroring how
// src/app/refer/[code]/page.tsx already hands friendSpritzers down to its
// own client ReferralForm. referralQr.ts is imported directly (see its own
// header): pure computation, no GoHighLevel or Supabase call.

import { useState, useEffect, type FormEvent } from 'react';
import { ReferralLinkCopy } from '@/components/portal/dark/ReferralLinkCopy';
import { ReferralShareButton } from '@/components/portal/dark/ReferralShareButton';
import { QrSvg } from '@/components/QrSvg';
import { formatUsd } from '@/components/portal/format';
import { referralQrSvg } from '@/lib/referralQr';
import { PhoneFrame } from './PhoneFrame';

const inputClass =
  'w-full rounded-lg bg-[#060B0F] border border-[#1F2A23] px-3.5 py-2.5 text-[15px] text-[#F4ECD8] placeholder:text-[#5A5648] focus:outline-none focus:ring-2 focus:ring-[#FFB744]';
const labelClass = 'block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#FFB744] mb-1.5';

// Review fix 1 (naldo/referral-self-serve): this page has no header, nav, or
// footer, so a phone number on the page itself is the ONLY way a visitor who
// hits an error can reach a person. Same env-override-with-fallback pattern
// as src/app/portal/error.tsx and src/components/portal/dark/PersonalContact.tsx.
const PHONE = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
const TEL_HREF = `tel:${PHONE.replace(/[^\d+]/g, '')}`;
// Shared underline-link treatment. Originally just the phone tel: link
// below; review fix 1 (this round) reuses it for ReferralLinkReady's own
// "get your own link" escape hatch, so it's named for what it looks like,
// not just its first use.
const linkClass =
  'text-[#FFB744] underline underline-offset-2 hover:text-[#FFC565] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519] rounded-sm';

// Fail-safe 1 (naldo/referral-link-preview): mirrors CONTACT_ID_RE in
// src/app/api/referrals/request-link/route.ts exactly, same measured
// real-world format, so an implausible id never even reaches the one-click
// button. Duplicated rather than imported: the route file has no shared
// module to import from without pulling server-only route code into this
// client bundle.
const CONTACT_ID_RE = /^[A-Za-z0-9]{16,32}$/;

/**
 * The post-submit confirmation, verbatim copy. Pure-render (no hooks) so it
 * can be unit tested with renderToStaticMarkup, same pattern as
 * src/app/refer/[code]/ReferralForm.tsx's ReferralSuccessScreen, no jsdom or
 * testing-library needed to assert the exact customer copy.
 */
export function ReferralLinkSuccess() {
  return (
    <div className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-8 text-center">
      <p className="font-display text-[22px] md:text-[26px] font-semibold text-[#F4ECD8]">Check your inbox.</p>
      <p className="mt-3 text-[15px] text-[#A89F87] leading-[1.6]">
        If that email&apos;s in our system, your referral link is on its way, give it a few minutes and peek at
        spam if it&apos;s not there yet. Still nothing by tonight? Call or text us at{' '}
        <a href={TEL_HREF} className={linkClass}>
          {PHONE}
        </a>{' '}
        and we&apos;ll send it right over.
      </p>
    </div>
  );
}

/**
 * naldo/referral-link-personalized: the contact-id path's success screen,
 * shown only when the route actually returned a referral URL. Reuses
 * ReferralLinkCopy (src/components/portal/dark/ReferralLinkCopy.tsx), the
 * SAME copy-to-clipboard control the booked-page referral section already
 * uses, so this gets the same dark palette and the same "Copy link" /
 * "Copied" interaction for free, no new component to build or maintain.
 *
 * Review fix 1 (this round): forwarding is exactly what a referral
 * campaign encourages, and the ORIGINAL copy here ("Your link is ready...
 * We also emailed you a copy") was actively wrong for anyone who opens a
 * forwarded copy of the campaign email: it is not their link, and the
 * email did not go to them. `name` (the contact's first name from the
 * route's response, null if GHL has none on file) lets the heading say
 * WHOSE link this is instead of assuming the reader; the "we emailed you"
 * claim is dropped rather than reworded, since this screen has no way to
 * know who is actually looking at it. The line below the copy button is
 * the escape hatch: a plain link to /referral-link with no query string,
 * so a forwarded viewer can get their OWN link instead of using someone
 * else's, whether or not a name was available to name them by.
 *
 * naldo/referral-link-preview, PIECE 6: this is the single highest-intent
 * moment in the whole flow, so it is built to sell the reward, not just
 * report it. The credit amount is the visual anchor (a big styled number,
 * mirroring src/components/portal/dark/ReferralSection.tsx's own booked-
 * page treatment of the exact same $125 line), the "it stacks, no limit"
 * claim gets its own sentence plus one concrete multiple (derived from
 * creditUsd, never a second hardcoded number), and the credit-vs-cash
 * distinction is stated plainly rather than implied. ReferralLinkCopy now
 * carries a real ReferralShareButton in its `after` slot (same composition
 * ReferralSection.tsx already uses) plus a QR code: sending is the goal,
 * copying is only a means to it, and this screen previously gave someone
 * nothing to send with beyond manually selecting the link text.
 *
 * Copy correction (naldo/referral-link-preview, this round): the credit is
 * good toward ANY Yule Love Lights service (consumeCredits in
 * src/lib/referrals.ts carries no service-type filter). A holiday customer
 * can put it toward permanent lighting, a much bigger job, not just a
 * repeat of what they already bought. The copy now says so plainly and
 * frames it as the upgrade it is, instead of implying "next job" means
 * "another one of the same." The spritzer reward is dollarized
 * (spritzerValueUsd, from spritzerRetailValueUsd, never a hardcoded
 * number) since "spritzers" means nothing to a homeowner on its own.
 */
export function ReferralLinkReady({
  link,
  name,
  creditUsd,
  creditExpiryYears,
  spritzerCount,
  spritzerSizeInches,
  spritzerValueUsd,
}: {
  link: string;
  name: string | null;
  creditUsd: number;
  creditExpiryYears: number;
  spritzerCount: number;
  spritzerSizeInches: number;
  spritzerValueUsd: number;
}) {
  // QR generation needs the real link, which only exists client-side here
  // (unlike ReferralSection.tsx's portal page, this page never knows the
  // link at server-render time, see the file header). Fail-open: a null
  // svg (still loading, or referralQrSvg's own caught generation error)
  // just means no QR block below, never a broken render.
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    referralQrSvg(link).then((svg) => {
      if (!cancelled) setQrSvg(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [link]);

  return (
    <div className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-8 text-center">
      <p className="font-display text-[22px] md:text-[26px] font-semibold text-[#F4ECD8]">
        {name ? `${name}'s referral link is ready.` : 'This referral link is ready.'}
      </p>

      {/* Reward anchor: the credit amount as a big styled number, not a
          sentence, mirroring ReferralSection.tsx's own $125 treatment. */}
      <p
        className="mt-5 font-display text-[44px] md:text-[52px] font-bold text-[#FFB744] leading-none tracking-[-0.02em]"
        style={{ textShadow: '0 0 22px rgba(255,183,68,0.35)' }}
      >
        {formatUsd(creditUsd)}
      </p>
      <p className="mt-2 text-[15px] text-[#E0D7C1] leading-[1.6]">
        credit for every friend who books, good toward any Yule Love Lights service. It stacks, so
        there is no limit on how many friends you refer.
      </p>
      <p className="mt-2 text-[13px] text-[#A89F87]">
        Refer two, that is {formatUsd(creditUsd * 2)} off. Already have holiday lights with us? Put
        it toward permanent lighting, an event, or a bistro install instead, whatever is next for
        you. It is a credit, not cash, good for {creditExpiryYears} years.
      </p>

      <p className="mt-6 text-[15px] text-[#E0D7C1] leading-[1.6]">
        Your friend gets {formatUsd(spritzerValueUsd)} in free lighting on their first install:{' '}
        {spritzerCount} staked spotlights for their yard ({spritzerSizeInches}&quot; spritzers). You
        are giving them something, not asking for a favor.
      </p>

      <p className="mt-6 text-[13px] md:text-[14px] font-semibold text-[#E0D7C1]">
        Send it to a friend, or copy your link:
      </p>
      <ReferralLinkCopy
        link={link}
        after={
          <ReferralShareButton
            link={link}
            spritzerCount={spritzerCount}
            spritzerSizeInches={spritzerSizeInches}
            spritzerValueUsd={spritzerValueUsd}
          />
        }
      />
      {qrSvg && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <QrSvg svg={qrSvg} className="w-14 h-14" />
          <p className="text-[12px] text-[#7B7361]">or scan to share</p>
        </div>
      )}

      {/* Live preview (naldo/referral-link-preview, PIECE 3b): their OWN
          real page, in the same phone frame the sample used before they
          generated anything (page.tsx), so they can see it live, house
          render and all, before they send it to anyone. Decorative only:
          the link, Copy, and Share controls above already work with no
          dependency on this rendering. */}
      <PhoneFrame src={link} title="Your referral page, live" className="mt-6" />

      <p className="mt-5 text-[13px] text-[#A89F87] leading-[1.5]">
        Forwarded to you? This link belongs to {name || 'someone else'}.{' '}
        <a href="/referral-link" className={linkClass}>
          Get your own referral link
        </a>
        .
      </p>
    </div>
  );
}

/**
 * The error state's message content. Extracted (mirrors ReferralLinkSuccess
 * above) so it can be unit tested with renderToStaticMarkup, no jsdom
 * needed. `serverError` is a genuine server-supplied message (e.g. a 400
 * validation error) and renders verbatim, no phone number attached, since
 * those are already actionable by the visitor. null covers the OTHER two
 * cases handleSubmit can reach below (a non-ok response with no `error`
 * field, and the catch-block network-failure case) with the same generic
 * fallback plus a tappable phone link, since a person hitting either has no
 * other way to reach us (this page has no header, nav, or footer).
 */
export function ReferralLinkErrorMessage({ serverError }: { serverError: string | null }) {
  if (serverError) return <>{serverError}</>;
  return (
    <>
      Something went wrong. Please call or text us instead at{' '}
      <a href={TEL_HREF} className={linkClass}>
        {PHONE}
      </a>
      .
    </>
  );
}

export function ReferralLinkForm({
  contactId,
  creditUsd,
  creditExpiryYears,
  spritzerCount,
  spritzerSizeInches,
  spritzerValueUsd,
}: {
  contactId?: string;
  /** Reward terms (naldo/referral-link-preview, PIECE 6), sourced from
   *  src/lib/referrals.ts (+ referralSpritzerValue.ts for spritzerValueUsd)
   *  by page.tsx and passed down as plain numbers, so ReferralLinkReady's
   *  copy can never drift from the real program terms. Only read on the
   *  contact-id path's success screen below; the typed-email path never
   *  shows a link and has nothing to anchor them to. */
  creditUsd: number;
  creditExpiryYears: number;
  spritzerCount: number;
  spritzerSizeInches: number;
  spritzerValueUsd: number;
}) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [serverError, setServerError] = useState<string | null>(null);
  const [referralUrl, setReferralUrl] = useState<string | null>(null);
  // Review fix 1 (this round): the contact's first name, alongside
  // referralUrl, so ReferralLinkReady can say WHOSE link this is.
  const [firstName, setFirstName] = useState<string | null>(null);
  // Fail-safe 2 (naldo/referral-link-preview): flips true once a one-click
  // attempt has resolved with no referralUrl. See useContactIdFlow below.
  const [contactIdFailed, setContactIdFailed] = useState(false);

  // naldo/referral-link-personalized: a truthy contactId prop switches this
  // whole form into the one-click mode below. Fail-safe 1 (naldo/referral-
  // link-preview): CONTACT_ID_RE now gates that switch too, so an
  // implausible id (a stripped/mangled query string) is treated exactly
  // like no id at all, never a button that can only fail. The route
  // re-validates the id regardless, this only decides which UI to show.
  const hasContactId = !!contactId && CONTACT_ID_RE.test(contactId);
  // Fail-safe 2: once a plausible-looking contactId submission comes back
  // with no link, the whole component behaves as plain-email mode from then
  // on -- every render check and handleSubmit branch below reads this, not
  // the raw hasContactId, so the fallback is total, not just cosmetic.
  const useContactIdFlow = hasContactId && !contactIdFailed;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!useContactIdFlow && !email.trim()) return;
    setStatus('submitting');
    setServerError(null);
    const data = new FormData(e.currentTarget);
    const company = String(data.get('company') ?? '');
    try {
      const res = await fetch('/api/referrals/request-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(useContactIdFlow ? { contactId, company } : { email: email.trim(), company }),
      });
      const json = await res
        .json()
        .catch(() => ({}) as { ok?: boolean; error?: string; referralUrl?: string; firstName?: string | null });
      if (!res.ok || !json.ok) {
        setServerError(json.error || null);
        setStatus('error');
        return;
      }
      // Fail-safe 2: a contactId that looked plausible but still resolved
      // to no referralUrl (a stale id, a merged contact, a transient GHL
      // error) must not dead-end on a screen with only a phone number.
      // Drop back to the plain email form instead, submittable immediately
      // -- resetting status to 'idle' (not 'done') re-renders the
      // interactive form rather than a terminal screen.
      if (useContactIdFlow && !json.referralUrl) {
        setContactIdFailed(true);
        setStatus('idle');
        return;
      }
      setReferralUrl(json.referralUrl ?? null);
      setFirstName(json.firstName ?? null);
      setStatus('done');
    } catch {
      setServerError(null);
      setStatus('error');
    }
  }

  if (status === 'done') {
    // A referral URL only ever comes back on the contact-id path, and only
    // on a real match (route.ts). referralUrl is guaranteed non-null here:
    // handleSubmit (fail-safe 2 above) intercepts the no-link outcome
    // BEFORE ever setting status to 'done' while useContactIdFlow is true,
    // resetting to the plain email form instead. The email path keeps its
    // one and only, unchanged confirmation state.
    if (useContactIdFlow) {
      return referralUrl ? (
        <ReferralLinkReady
          link={referralUrl}
          name={firstName}
          creditUsd={creditUsd}
          creditExpiryYears={creditExpiryYears}
          spritzerCount={spritzerCount}
          spritzerSizeInches={spritzerSizeInches}
          spritzerValueUsd={spritzerValueUsd}
        />
      ) : null;
    }
    return <ReferralLinkSuccess />;
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-6 md:p-8 flex flex-col gap-4"
    >
      {/* Honeypot: hidden from people, catnip for bots. Off-screen rather
          than display:none or aria-hidden, which would put a focusable field
          inside a hidden subtree, mirrors src/app/forms/[type]/SiteForm.tsx
          and src/app/refer/[code]/ReferralForm's sibling pattern. Kept in
          BOTH modes below: it costs nothing when there is no email field to
          fill either, and the route checks it either way. */}
      <div style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>
        <label>
          Company
          <input type="text" name="company" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      {/* Fail-safe 2 (naldo/referral-link-preview): shown only once a
          one-click attempt has already come back with no link, right above
          the email form it falls back to, so a visitor who expected a link
          understands why a form appeared instead. */}
      {contactIdFailed && (
        <p className="text-[13px] text-[#A89F87]">
          We could not pull up your link automatically. Enter your email below and we will send it.
        </p>
      )}

      {!useContactIdFlow && (
        <div>
          <label className={labelClass} htmlFor="referral-link-email">
            Email
          </label>
          <input
            id="referral-link-email"
            name="email"
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </div>
      )}
      {status === 'error' && (
        <p role="alert" className="text-[13px] text-[#E88]">
          <ReferralLinkErrorMessage serverError={serverError} />
        </p>
      )}
      <button
        type="submit"
        disabled={status === 'submitting'}
        className="mt-2 inline-flex items-center justify-center px-5 py-3.5 rounded-xl bg-[#FFB744] text-[#1A1206] font-semibold text-[15px] cursor-pointer transition-colors duration-200 hover:bg-[#FFC565] disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519]"
      >
        {useContactIdFlow
          ? status === 'submitting'
            ? 'Getting your link...'
            : 'Get my referral link'
          : status === 'submitting'
            ? 'Sending...'
            : 'Send me my link'}
      </button>
      {/* Review fix 8 (this round): the button dimming and its label change
          were the only signal during a wait that can run several seconds
          (the contact-id path now awaits a live GHL lookup plus a mint, see
          route.ts). A short, plain reassurance while in flight. */}
      {status === 'submitting' && (
        <p className="text-center text-[13px] text-[#A89F87]">This can take a few seconds.</p>
      )}
    </form>
  );
}
