'use client';

// Customer self-serve estimate — interactive flow (ledger self-serve, Phase A).
//
// Steps: address → measuring → (result | followup) → done.
//   result   — we measured the roof and priced it: show a RANGE (never a binding
//              number in Phase A) + a "save my quote" contact form.
//   followup — no Street View / low confidence / no footage: no price, capture
//              contact so staff can finish a custom quote and reach out.
// Contact info is saved progressively (on field blur) so an abandoned form still
// leaves the team a lead. The price is shown BEFORE the contact form — the whole
// point vs the competitors' contact-wall-first flows.

import { useCallback, useEffect, useRef, useState } from 'react';

type Step = 'address' | 'measuring' | 'result' | 'followup' | 'done';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const MEASURING_LINES = ['Locating your home…', 'Tracing your roofline…', 'Pricing your lights…'];

export function EstimateFlow() {
  const [step, setStep] = useState<Step>('address');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Measured result
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [range, setRange] = useState<{ low: number; high: number } | null>(null);
  const [formattedAddress, setFormattedAddress] = useState<string | null>(null);

  // Contact fields
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const company = useRef(''); // honeypot (never rendered visibly for real users)
  const mountedAt = useRef(0);
  useEffect(() => {
    // Stamp mount time in an effect (Date.now() is impure — not allowed during render).
    mountedAt.current = Date.now();
  }, []);

  // Rotate the measuring status lines (reset happens in measure(), not here — a
  // setState in an effect body triggers cascading renders).
  const [measureLine, setMeasureLine] = useState(0);
  useEffect(() => {
    if (step !== 'measuring') return;
    const t = setInterval(() => setMeasureLine((i) => (i + 1) % MEASURING_LINES.length), 1400);
    return () => clearInterval(t);
  }, [step]);

  const rangeLabel = range ? `${usd.format(range.low)}–${usd.format(range.high)}` : null;

  const measure = useCallback(async () => {
    const addr = address.trim();
    if (addr.length < 5) {
      setError('Please enter your full home address.');
      return;
    }
    setError(null);
    setMeasureLine(0);
    setStep('measuring');
    try {
      const res = await fetch('/api/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, company: company.current, elapsedMs: Date.now() - mountedAt.current }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        setError('A lot of people are trying this right now. Give it a minute and try again.');
        setStep('address');
        return;
      }
      if (!res.ok && res.status !== 200) {
        setError(data?.error || 'Something went wrong. Please try again.');
        setStep('address');
        return;
      }
      if (data.measured) {
        setQuoteId(data.quoteId ?? null);
        setRange({ low: data.low, high: data.high });
        setFormattedAddress(data.formattedAddress ?? addr);
        setStep('result');
      } else {
        // no_streetview / low_confidence / no_footage / analyzer_unavailable
        setStep('followup');
      }
    } catch {
      setError('We could not reach the estimator. Please try again.');
      setStep('address');
    }
  }, [address]);

  // Progressive save on blur — an abandoned form still leaves a lead.
  const savePartial = useCallback(() => {
    const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
    const hasPhone = (phone.match(/\d/g)?.length ?? 0) >= 7;
    if (!hasEmail && !hasPhone) return;
    void fetch('/api/estimate/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ partial: true, quoteId, name: name.trim(), email: email.trim(), phone: phone.trim(), address: formattedAddress ?? address, company: company.current }),
    }).catch(() => {});
  }, [email, phone, name, quoteId, formattedAddress, address]);

  const submitContact = useCallback(async () => {
    setError(null);
    if (!name.trim()) return setError('Please enter your name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Please enter a valid email.');
    if ((phone.match(/\d/g)?.length ?? 0) < 7) return setError('Please enter a valid phone number.');
    if (!consent) return setError('Please check the box so we can reach out about your quote.');
    setSubmitting(true);
    try {
      const res = await fetch('/api/estimate/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId,
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          address: formattedAddress ?? address,
          consent: true,
          rangeLabel,
          company: company.current,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }
      setStep('done');
    } catch {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }, [name, email, phone, consent, quoteId, formattedAddress, address, rangeLabel]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-amber-50 to-white text-slate-900">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-5 py-12 sm:py-20">
        <header className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Yule Love Lights</p>
          <h1 className="mt-2 text-balance text-3xl font-bold sm:text-4xl">Your holiday lighting price, in seconds</h1>
          <p className="mt-3 text-slate-600">Type your address. We measure your roof from above and show you a real range. No photos, no waiting.</p>
        </header>

        {/* Honeypot — off-screen, real users never see or fill it */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="absolute left-[-9999px] h-0 w-0 opacity-0"
          onChange={(e) => (company.current = e.target.value)}
        />

        {step === 'address' && (
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <label htmlFor="addr" className="block text-sm font-medium text-slate-700">Home address</label>
            <input
              id="addr"
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && measure()}
              placeholder="123 Main St, Your Town, NY"
              autoComplete="street-address"
              className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 text-base outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
            />
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button
              onClick={measure}
              className="mt-4 w-full rounded-lg bg-amber-600 px-4 py-3 text-base font-semibold text-white transition hover:bg-amber-700"
            >
              See my instant estimate
            </button>
            <p className="mt-3 text-center text-xs text-slate-500">Free. No obligation. Takes about 15 seconds.</p>
          </section>
        )}

        {step === 'measuring' && (
          <section className="rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-slate-200">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-amber-200 border-t-amber-600" />
            <p className="mt-5 text-lg font-medium text-slate-700">{MEASURING_LINES[measureLine]}</p>
            <p className="mt-1 text-sm text-slate-500">Reading the satellite view of {address}</p>
          </section>
        )}

        {step === 'result' && range && (
          <section className="flex flex-col gap-5">
            <div className="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-200">
              <p className="text-sm text-slate-500">Estimated holiday lighting for</p>
              <p className="text-sm font-medium text-slate-700">{formattedAddress}</p>
              <p className="mt-4 text-4xl font-bold text-amber-700">{usd.format(range.low)} – {usd.format(range.high)}</p>
              <p className="mt-3 text-sm text-slate-500">A real range from your measured roofline. We confirm the exact number before anything is due.</p>
            </div>
            <ContactCard
              heading="Save your quote"
              blurb="Enter your info and we'll lock in your design, confirm the final price, and send you a link to review and book."
              cta="Save my quote"
              {...{ name, setName, email, setEmail, phone, setPhone, consent, setConsent, error, submitting, savePartial, submitContact }}
            />
          </section>
        )}

        {step === 'followup' && (
          <ContactCard
            heading="Let's finish your custom quote"
            blurb="Your home needs a closer look for an exact price. Leave your info and we'll put together a custom quote and reach out within one business day."
            cta="Get my custom quote"
            {...{ name, setName, email, setEmail, phone, setPhone, consent, setConsent, error, submitting, savePartial, submitContact }}
          />
        )}

        {step === 'done' && (
          <section className="rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-slate-200">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl">✓</div>
            <h2 className="mt-4 text-2xl font-bold">You&apos;re all set</h2>
            <p className="mt-2 text-slate-600">
              {rangeLabel ? `We saved your ${rangeLabel} estimate. ` : ''}
              Our team will confirm your details and reach out shortly.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

type ContactCardProps = {
  heading: string;
  blurb: string;
  cta: string;
  name: string; setName: (v: string) => void;
  email: string; setEmail: (v: string) => void;
  phone: string; setPhone: (v: string) => void;
  consent: boolean; setConsent: (v: boolean) => void;
  error: string | null;
  submitting: boolean;
  savePartial: () => void;
  submitContact: () => void;
};

function ContactCard(p: ContactCardProps) {
  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-lg font-semibold text-slate-800">{p.heading}</h2>
      <p className="mt-1 text-sm text-slate-600">{p.blurb}</p>
      <div className="mt-4 flex flex-col gap-3">
        <input
          type="text" value={p.name} onChange={(e) => p.setName(e.target.value)}
          placeholder="Full name" autoComplete="name"
          className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
        />
        <input
          type="email" value={p.email} onChange={(e) => p.setEmail(e.target.value)} onBlur={p.savePartial}
          placeholder="Email" autoComplete="email"
          className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
        />
        <input
          type="tel" value={p.phone} onChange={(e) => p.setPhone(e.target.value)} onBlur={p.savePartial}
          placeholder="Phone" autoComplete="tel"
          className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
        />
        <label className="flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={p.consent} onChange={(e) => p.setConsent(e.target.checked)} className="mt-1" />
          <span>It&apos;s okay to text or email me about my quote.</span>
        </label>
        {p.error && <p className="text-sm text-red-600">{p.error}</p>}
        <button
          onClick={p.submitContact}
          disabled={p.submitting}
          className="w-full rounded-lg bg-amber-600 px-4 py-3 text-base font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"
        >
          {p.submitting ? 'Sending…' : p.cta}
        </button>
      </div>
    </section>
  );
}
