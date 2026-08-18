'use client';

// Self-serve referral link request form (naldo/referral-self-serve). POSTs
// to /api/referrals/request-link, which responds ok:true whether or not the
// typed email matched a GHL contact, so ReferralLinkSuccess below is the
// ONLY confirmation state this form ever shows. That is by design: the copy
// is written so it never reveals whether an email belongs to a YLL
// customer. Never imports highlevel.ts, customers.ts, or referrals.ts here,
// this component only ever fetch()es the API.

import { useState, type FormEvent } from 'react';

const inputClass =
  'w-full rounded-lg bg-[#060B0F] border border-[#1F2A23] px-3.5 py-2.5 text-[15px] text-[#F4ECD8] placeholder:text-[#5A5648] focus:outline-none focus:ring-2 focus:ring-[#FFB744]';
const labelClass = 'block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#FFB744] mb-1.5';

// Review fix 1 (naldo/referral-self-serve): this page has no header, nav, or
// footer, so a phone number on the page itself is the ONLY way a visitor who
// hits an error can reach a person. Same env-override-with-fallback pattern
// as src/app/portal/error.tsx and src/components/portal/dark/PersonalContact.tsx.
const PHONE = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
const TEL_HREF = `tel:${PHONE.replace(/[^\d+]/g, '')}`;
const phoneLinkClass =
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
        <a href={TEL_HREF} className={phoneLinkClass}>
          {PHONE}
        </a>{' '}
        and we&apos;ll send it right over.
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
      <a href={TEL_HREF} className={phoneLinkClass}>
        {PHONE}
      </a>
      .
    </>
  );
}

export function ReferralLinkForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [serverError, setServerError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus('submitting');
    setServerError(null);
    const data = new FormData(e.currentTarget);
    try {
      const res = await fetch('/api/referrals/request-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), company: String(data.get('company') ?? '') }),
      });
      const json = await res.json().catch(() => ({}) as { ok?: boolean; error?: string });
      if (!res.ok || !json.ok) {
        setServerError(json.error || null);
        setStatus('error');
        return;
      }
      setStatus('done');
    } catch {
      setServerError(null);
      setStatus('error');
    }
  }

  if (status === 'done') {
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
          and src/app/refer/[code]/ReferralForm's sibling pattern. */}
      <div style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>
        <label>
          Company
          <input type="text" name="company" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

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
        {status === 'submitting' ? 'Sending...' : 'Send me my link'}
      </button>
    </form>
  );
}
