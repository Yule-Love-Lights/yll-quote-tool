'use client';

// Referral program (#41) — the /refer/<code> landing page's lead-capture form.
// POSTs to /api/referrals/submit (public, rate-limited, re-validates the code
// server-side). Fires `referral_form_submitted` via the fail-open PostHog
// track() on a successful submit — mirrors QuoteViewTracker's usage.
//
// #41 adversarial-review LOW fix: attribute by `code` alone (see
// ReferralPageTracker's own note) — the route re-derives the referrer from
// the code server-side anyway, so the client never needs their customer id.

import { useState, type FormEvent } from 'react';
import { track } from '@/lib/analytics/posthog';

const inputClass =
  'w-full rounded-lg bg-[#060B0F] border border-[#1F2A23] px-3.5 py-2.5 text-[15px] text-[#F4ECD8] placeholder:text-[#5A5648] focus:outline-none focus:ring-2 focus:ring-[#FFB744]';
const labelClass = 'block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#FFB744] mb-1.5';

export function ReferralForm({ code }: { code: string }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || !phone.trim() || !address.trim()) return;
    setStatus('submitting');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/referrals/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          name: name.trim(),
          phone: phone.trim(),
          address: address.trim(),
          email: email.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}) as { error?: string });
        setErrorMsg(json.error || 'Something went wrong. Please call us instead.');
        setStatus('error');
        return;
      }
      track('referral_form_submitted', { code });
      setStatus('done');
    } catch {
      setErrorMsg('Something went wrong. Please call us instead.');
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-8 text-center">
        <p className="font-display text-[22px] md:text-[26px] font-semibold text-[#F4ECD8]">
          We are on it.
        </p>
        <p className="mt-3 text-[15px] text-[#A89F87] leading-[1.6]">
          Expect a text from us today to set up your free light preview.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-6 md:p-8 flex flex-col gap-4">
      <div>
        <label className={labelClass} htmlFor="ref-name">Name</label>
        <input
          id="ref-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          placeholder="Your name"
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="ref-phone">Phone</label>
        <input
          id="ref-phone"
          required
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={inputClass}
          placeholder="(516) 555-0123"
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="ref-address">Address</label>
        <input
          id="ref-address"
          required
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className={inputClass}
          placeholder="123 Main St, Smithtown, NY"
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="ref-email">Email (optional)</label>
        <input
          id="ref-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
          placeholder="you@example.com"
        />
      </div>
      {errorMsg && <p className="text-[13px] text-[#E88]">{errorMsg}</p>}
      <button
        type="submit"
        disabled={status === 'submitting'}
        className="mt-2 inline-flex items-center justify-center px-5 py-3.5 rounded-xl bg-[#FFB744] text-[#1A1206] font-semibold text-[15px] cursor-pointer transition-colors duration-200 hover:bg-[#FFC565] disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519]"
      >
        {status === 'submitting' ? 'Sending...' : 'See my house in lights'}
      </button>
    </form>
  );
}
