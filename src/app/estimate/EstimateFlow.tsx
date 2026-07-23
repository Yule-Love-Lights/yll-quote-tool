'use client';

// Customer self-serve estimate — interactive flow (ledger self-serve, S48 redesign).
//
// The dark "cinematic" front door ported from the approved mockup. Same REAL
// pipeline as before (address → /api/estimate → range + measured-roofline visual →
// progressive contact capture); this slice re-skins it and adds the landing's
// sample-home style picker + before/after hero (kept up through the measuring step
// so there's something to play with while we look up the customer's house).
//
// Steps: address → measuring → (result | followup | outofarea) → done.

import './estimate-dark.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EstimateVisual } from './EstimateVisual';
import { BeforeAfter } from './BeforeAfter';
import type { SampleDesign } from '@/lib/designs';
import { DEFAULT_COLOR_SCHEMES, DEFAULT_COLOR_SCHEME_ID } from '@/lib/design/colorSchemes';
import { COLOR_MAP } from '@/components/design/editor-core/colors';

type Step = 'address' | 'measuring' | 'result' | 'followup' | 'outofarea' | 'done';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
// Holiday-flavored so the wait is fun (Naldo).
const MEASURING_LINES = [
  'Untangling the lights…',
  'Waking up the elves…',
  'Measuring your roof from space…',
  'Testing every bulb (twice)…',
  "Consulting Santa's blueprints…",
  'Warming up the ladder…',
];
// The customer-facing color options — the real quote-tool schemes minus "Staff's
// pick" (the as-designed no-override), which Naldo pulled from the picker.
const COLOR_SCHEMES = DEFAULT_COLOR_SCHEMES.filter((s) => s.id !== DEFAULT_COLOR_SCHEME_ID);

const STEP_INDEX: Record<Step, number> = { address: 0, measuring: 1, result: 2, followup: 2, outofarea: 2, done: 2 };

export function EstimateFlow({ embedded = false }: { embedded?: boolean } = {}) {
  const [step, setStep] = useState<Step>('address');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [canFallback, setCanFallback] = useState(false);

  // Featured real-job gallery + "play with it" state (landing + measuring).
  const [schemeId, setSchemeId] = useState<string>(COLOR_SCHEMES[0].id);
  const [samples, setSamples] = useState<SampleDesign[]>([]);
  const [sampleIdx, setSampleIdx] = useState(0);
  const activeScheme = COLOR_SCHEMES.find((s) => s.id === schemeId) ?? COLOR_SCHEMES[0];
  // The customer recoloring their OWN measured house on the result screen.
  const [resultSchemeId, setResultSchemeId] = useState<string>(COLOR_SCHEMES[0].id);
  const resultScheme = COLOR_SCHEMES.find((s) => s.id === resultSchemeId) ?? COLOR_SCHEMES[0];

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
  const company = useRef(''); // honeypot
  const mountedAt = useRef(0);
  const rootRef = useRef<HTMLElement>(null);

  // Embedded height handshake (unchanged): post our content height to the parent.
  useEffect(() => {
    if (!embedded || typeof window === 'undefined' || window.parent === window) return;
    const el = rootRef.current;
    if (!el) return;
    const post = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      for (const origin of ['https://yulelovelights.com', 'https://www.yulelovelights.com']) {
        window.parent.postMessage({ type: 'yll-estimate-height', height }, origin);
      }
    };
    post();
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [embedded]);
  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);

  // Featured real completed-job designs for the gallery. Best-effort: no samples →
  // the gallery is simply omitted, never blocks the estimator.
  useEffect(() => {
    let alive = true;
    fetch('/api/estimate/samples')
      .then((r) => (r.ok ? r.json() : { samples: [] }))
      .then((d) => { if (alive && Array.isArray(d.samples)) setSamples(d.samples); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const [measureLine, setMeasureLine] = useState(0);
  useEffect(() => {
    if (step !== 'measuring') return;
    const t = setInterval(() => setMeasureLine((i) => (i + 1) % MEASURING_LINES.length), 1600);
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
      } else if (data.served === false) {
        setStep('outofarea');
      } else if (data.reason === 'address_not_found') {
        setError("We couldn't find that address. Please check it and try again.");
        setCanFallback(true);
        setStep('address');
      } else if (data.reason === 'unavailable') {
        setError('One moment — please try that again.');
        setStep('address');
      } else {
        setStep('followup');
      }
    } catch {
      setError('We could not reach the estimator. Please try again.');
      setStep('address');
    }
  }, [address]);

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
        body: JSON.stringify({ quoteId, name: name.trim(), email: email.trim(), phone: phone.trim(), address: formattedAddress ?? address, consent: true, rangeLabel, company: company.current }),
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

  const contactProps = { name, setName, email, setEmail, phone, setPhone, consent, setConsent, error, submitting, savePartial, submitContact };
  const showSamples = step === 'address' || step === 'measuring';

  return (
    <main ref={rootRef} className="est-dark">
      <div className={`est-shell ${embedded ? '' : ''}`} style={embedded ? { paddingTop: 12 } : undefined}>
        <div className="est-stepper" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className={STEP_INDEX[step] >= i ? 'on' : ''} />
          ))}
        </div>

        {/* Honeypot — offscreen, real users never fill it. */}
        <input
          type="text" tabIndex={-1} autoComplete="off" aria-hidden
          style={{ position: 'absolute', left: -9999, height: 0, width: 0, opacity: 0 }}
          onChange={(e) => (company.current = e.target.value)}
        />

        {step === 'address' && (
          <section className="est-screen">
            {!embedded && <p className="est-eyebrow">Yule Love Lights</p>}
            <h1 className="est-h1 est-display">See your house lit.<br />Get your price tonight.</h1>
            <p className="est-sub">Type your address. We measure your roof from above and price it on the spot — no visit needed to see your number.</p>
          </section>
        )}

        {/* Featured real completed-job designs + before/after — kept up on the
            address AND measuring screens so there's something to look at during the
            wait. Omitted entirely until the gallery loads. */}
        {showSamples && samples.length > 0 && (
          <section className="est-screen">
            <p className="est-pick-cap">Homes we&apos;ve lit up on Long Island — drag to compare</p>
            <BeforeAfter design={samples[Math.min(sampleIdx, samples.length - 1)]} colorOverride={activeScheme.colorIds} />
            {samples.length > 1 && (
              <div className="est-dots">
                {samples.map((s, i) => (
                  <button
                    key={s.quoteId ?? i}
                    type="button"
                    aria-label={`Show home ${i + 1}`}
                    onClick={() => setSampleIdx(i)}
                    className={`est-dot ${i === Math.min(sampleIdx, samples.length - 1) ? 'on' : ''}`}
                  />
                ))}
              </div>
            )}
            <ColorSwatches value={schemeId} onChange={setSchemeId} />
            <p className="est-hero-hint">Real Yule Love Lights installs · tap a color to see your options</p>
          </section>
        )}

        {step === 'address' && (
          <section className="est-screen">
            <label className="est-flabel" htmlFor="addr">Your home address</label>
            <input
              id="addr" type="text" className="est-field" value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && measure()}
              placeholder="123 Candy Cane Ln, Huntington NY"
              autoComplete="street-address"
            />
            {error && <p className="est-error">{error}</p>}
            <button className="est-btn" onClick={measure}>Get my instant quote</button>
            <p className="est-hero-hint" style={{ margin: '10px 0 0' }}>Free. No obligation. Takes about 15 seconds.</p>
            {canFallback && (
              <button className="est-backlink" onClick={() => { setError(null); setStep('followup'); }}>
                Still not finding your home? Leave your info and we&apos;ll quote it by hand
              </button>
            )}
          </section>
        )}

        {step === 'measuring' && (
          <section className="est-screen" style={{ textAlign: 'center', marginTop: 18 }}>
            <div className="est-spinner" />
            <p className="est-scan-status">{MEASURING_LINES[measureLine]}</p>
            <p className="est-price-note">Reading the satellite view of {address}</p>
          </section>
        )}

        {step === 'result' && range && (
          <section className="est-screen" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="est-price-card">
              <p className="est-price-note">Estimated holiday lighting for</p>
              <p className="est-price-note" style={{ color: 'var(--est-cream-2)' }}>{formattedAddress}</p>
              <div className="est-price-band">{usd.format(range.low)} – {usd.format(range.high)}</div>
              <p className="est-price-note">A real range from your measured roofline.</p>
              <span className="est-verify-tag">Our team confirms your final number before anything is due</span>
            </div>
            {quoteId && (
              <div>
                <EstimateVisual quoteId={quoteId} colorOverride={resultScheme.colorIds} />
                <p className="est-pick-cap" style={{ marginTop: 12 }}>See your home in your colors</p>
                <ColorSwatches value={resultSchemeId} onChange={setResultSchemeId} />
              </div>
            )}
            <ContactCard heading="Save your quote" blurb="Enter your info and we'll lock in your design, confirm the final price, and send you a link to review and book." cta="Save my quote" {...contactProps} />
          </section>
        )}

        {step === 'followup' && (
          <ContactCard heading="Let's finish your custom quote" blurb="Your home needs a closer look for an exact price. Leave your info and we'll put together a custom quote and reach out within one business day." cta="Get my custom quote" {...contactProps} />
        )}

        {step === 'outofarea' && (
          <section className="est-screen" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="est-price-card">
              <p className="est-price-band" style={{ fontSize: 20 }}>We&apos;re not in your area just yet</p>
              <p className="est-price-note">We currently install across Nassau and Suffolk County. Leave your info and we&apos;ll reach out if we expand near you.</p>
            </div>
            <ContactCard heading="Get on the list" blurb="We'll let you know as soon as we're installing in your area." cta="Keep me posted" {...contactProps} />
          </section>
        )}

        {step === 'done' && (
          <section className="est-screen" style={{ textAlign: 'center' }}>
            <div className="est-price-card">
              <div className="est-price-band" style={{ fontSize: 22 }}>You&apos;re all set ✓</div>
              <p className="est-price-note">
                {rangeLabel ? `We saved your ${rangeLabel} estimate. ` : ''}
                Our team will confirm your details and reach out shortly.
              </p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

// The quote-tool color options, reused by the sample gallery and the customer's own
// result. Each swatch previews its real palette colors and drives DesignCanvas's
// colorOverride.
function ColorSwatches({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="est-swatches" style={{ marginTop: 12 }}>
      {COLOR_SCHEMES.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`est-swatch ${s.id === value ? 'on' : ''}`}
          onClick={() => onChange(s.id)}
        >
          <span className="dots">
            {(s.colorIds ?? []).slice(0, 4).map((id, i) => <i key={i} style={{ background: COLOR_MAP.get(id)?.hex ?? '#fff' }} />)}
          </span>
          {s.label}
        </button>
      ))}
    </div>
  );
}

type ContactCardProps = {
  heading: string; blurb: string; cta: string;
  name: string; setName: (v: string) => void;
  email: string; setEmail: (v: string) => void;
  phone: string; setPhone: (v: string) => void;
  consent: boolean; setConsent: (v: boolean) => void;
  error: string | null; submitting: boolean;
  savePartial: () => void; submitContact: () => void;
};

function ContactCard(p: ContactCardProps) {
  return (
    <section className="est-price-card" style={{ textAlign: 'left' }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{p.heading}</h2>
      <p className="est-price-note" style={{ margin: '6px 0 0' }}>{p.blurb}</p>
      <label className="est-flabel" htmlFor="cname">Full name</label>
      <input id="cname" type="text" className="est-field" value={p.name} onChange={(e) => p.setName(e.target.value)} placeholder="Full name" autoComplete="name" />
      <label className="est-flabel" htmlFor="cemail">Email</label>
      <input id="cemail" type="email" className="est-field" value={p.email} onChange={(e) => p.setEmail(e.target.value)} onBlur={p.savePartial} placeholder="you@example.com" autoComplete="email" />
      <label className="est-flabel" htmlFor="cphone">Phone</label>
      <input id="cphone" type="tel" className="est-field" value={p.phone} onChange={(e) => p.setPhone(e.target.value)} onBlur={p.savePartial} placeholder="(516) 555-0100" autoComplete="tel" />
      <label className="est-checkline">
        <input type="checkbox" checked={p.consent} onChange={(e) => p.setConsent(e.target.checked)} />
        <span>It&apos;s okay to text or email me about my quote.</span>
      </label>
      {p.error && <p className="est-error" style={{ textAlign: 'left' }}>{p.error}</p>}
      <button className="est-btn" onClick={p.submitContact} disabled={p.submitting}>{p.submitting ? 'Sending…' : p.cta}</button>
    </section>
  );
}
