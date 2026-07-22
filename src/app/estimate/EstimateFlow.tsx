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
import { SAMPLE_STYLES, SCHEMES, type SampleStyle, type SchemeKey } from './estimateSamples';

type Step = 'address' | 'measuring' | 'result' | 'followup' | 'outofarea' | 'done';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const MEASURING_LINES = ['Fetching your home…', 'Tracing the lines your lights will follow…', 'Pricing it…'];

const SWATCHES: { key: SchemeKey; label: string; dots: string[] }[] = [
  { key: 'warm', label: 'Warm White', dots: SCHEMES.warm },
  { key: 'cool', label: 'Cool White', dots: SCHEMES.cool },
  { key: 'multi', label: 'Multicolor', dots: SCHEMES.multi },
  { key: 'redwhite', label: 'Red & White', dots: SCHEMES.redwhite },
];

const STEP_INDEX: Record<Step, number> = { address: 0, measuring: 1, result: 2, followup: 2, outofarea: 2, done: 2 };

export function EstimateFlow({ embedded = false }: { embedded?: boolean } = {}) {
  const [step, setStep] = useState<Step>('address');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [canFallback, setCanFallback] = useState(false);

  // Sample-home "play with it" state (landing + measuring).
  const [sampleStyle, setSampleStyle] = useState<SampleStyle>(SAMPLE_STYLES[0]);
  const [scheme, setScheme] = useState<SchemeKey>('warm');

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

        {/* Sample-home style picker + before/after — kept up on the address AND
            measuring screens so there's something to play with during the wait. */}
        {showSamples && (
          <section className="est-screen">
            <p className="est-pick-cap">Pick the house style closest to yours</p>
            <div className="est-housepick">
              {SAMPLE_STYLES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`est-housechip ${s.key === sampleStyle.key ? 'on' : ''}`}
                  onClick={() => setSampleStyle(s)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <BeforeAfter style={sampleStyle} scheme={scheme} />
            <div className="est-swatches" style={{ marginTop: 12 }}>
              {SWATCHES.map((sw) => (
                <button
                  key={sw.key}
                  type="button"
                  className={`est-swatch ${sw.key === scheme ? 'on' : ''}`}
                  onClick={() => setScheme(sw.key)}
                >
                  <span className="dots">{sw.dots.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
                  {sw.label}
                </button>
              ))}
            </div>
            <p className="est-hero-hint">Drag to compare · sample styles, swap for your real home once you get your quote</p>
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
            {quoteId && <EstimateVisual quoteId={quoteId} />}
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
