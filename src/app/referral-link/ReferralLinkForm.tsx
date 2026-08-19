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
//   directly and, on a match, returns the referral URL in the same
//   response, so ReferralLinkReady below can show it immediately. A
//   contactId that fails to resolve gets the exact same ok:true, no-link
//   response the email path uses, so this mode falls back to the same
//   ReferralLinkSuccess screen too, see route.ts's file header for why that
//   is the right fallback either way.
//
// Never imports highlevel.ts, customers.ts, or referrals.ts here, this
// component only ever fetch()es the API.

import { useState, type FormEvent } from 'react';
import { ReferralLinkCopy } from '@/components/portal/dark/ReferralLinkCopy';

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
 */
export function ReferralLinkReady({ link, name }: { link: string; name: string | null }) {
  return (
    <div className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-8 text-center">
      <p className="font-display text-[22px] md:text-[26px] font-semibold text-[#F4ECD8]">
        {name ? `${name}'s referral link is ready.` : 'This referral link is ready.'}
      </p>
      <p className="mt-3 text-[15px] text-[#A89F87] leading-[1.6]">
        Share it with a friend or neighbor. When they book, you get $125 off your next job. They get 2 free
        16&quot; spritzers.
      </p>
      <ReferralLinkCopy link={link} />
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

export function ReferralLinkForm({ contactId }: { contactId?: string }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [serverError, setServerError] = useState<string | null>(null);
  const [referralUrl, setReferralUrl] = useState<string | null>(null);
  // Review fix 1 (this round): the contact's first name, alongside
  // referralUrl, so ReferralLinkReady can say WHOSE link this is.
  const [firstName, setFirstName] = useState<string | null>(null);

  // naldo/referral-link-personalized: a truthy contactId prop switches this
  // whole form into the one-click mode below. The page only ever passes a
  // trimmed, non-empty string or undefined (see referral-link/page.tsx), so
  // no further validation is needed here, the route re-validates it anyway.
  const hasContactId = !!contactId;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!hasContactId && !email.trim()) return;
    setStatus('submitting');
    setServerError(null);
    const data = new FormData(e.currentTarget);
    const company = String(data.get('company') ?? '');
    try {
      const res = await fetch('/api/referrals/request-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(hasContactId ? { contactId, company } : { email: email.trim(), company }),
      });
      const json = await res
        .json()
        .catch(() => ({}) as { ok?: boolean; error?: string; referralUrl?: string; firstName?: string | null });
      if (!res.ok || !json.ok) {
        setServerError(json.error || null);
        setStatus('error');
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
    // on a real match (route.ts). Every other outcome, either path, falls
    // back to the same generic "check your inbox" screen.
    return referralUrl ? <ReferralLinkReady link={referralUrl} name={firstName} /> : <ReferralLinkSuccess />;
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

      {!hasContactId && (
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
        {hasContactId
          ? status === 'submitting'
            ? 'Getting your link...'
            : 'Get my referral link'
          : status === 'submitting'
            ? 'Sending...'
            : 'Send me my link'}
      </button>
    </form>
  );
}
