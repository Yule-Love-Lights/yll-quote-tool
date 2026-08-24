'use client';

// The embeddable non-lead forms (#195). One component covers all five
// placements; the marketing site iframes /forms/<type>.
//
// Styling mirrors yulelovelights.com on purpose (Poppins headings, DM Sans
// body, #CF0303 pill buttons) so an embedded form reads as part of the page
// rather than a bolted-on widget. `theme=dark` is for the footer, which sits
// on the red band.

import { useEffect, useRef, useState } from 'react';

export type FormType = 'newsletter' | 'careers' | 'intern' | 'nomination';

type Props = {
  formType: FormType;
  formVariant: string;
  theme: 'light' | 'dark';
  compact: boolean;
};

const API = process.env.NEXT_PUBLIC_APP_URL
  ? `${process.env.NEXT_PUBLIC_APP_URL}/api/site-forms`
  : '/api/site-forms';

// Visually hidden, still read aloud. Not display:none, which removes it from
// the accessibility tree entirely.
const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

// The only pages allowed to embed these forms, and therefore the only origins
// we will post our height to. Mirrors the frame-ancestors allowlist in
// next.config.ts — never '*'.
const EMBED_PARENT_ORIGINS = ['https://yulelovelights.com', 'https://www.yulelovelights.com'];

// Matches the server cap, which itself matches this app's established multipart
// ceiling (headroom under Vercel's ~4.5MB raw-body limit). Checked on the
// client too so an oversized resume is refused with a clear message BEFORE a
// round trip that the platform would reject with an unreadable 413.
const RESUME_MAX_BYTES = 4 * 1024 * 1024;

const COPY: Record<FormType, { heading: string; blurb: string; button: string; done: string }> = {
  newsletter: {
    heading: 'Join our community',
    blurb: 'Seasonal lighting tips and early booking dates. No spam.',
    button: 'Subscribe',
    done: 'You are on the list. Watch your inbox.',
  },
  careers: {
    heading: 'Work with us',
    blurb: 'Tell us about yourself and attach a resume. We read every one.',
    button: 'Send application',
    done: 'Application received. We will be in touch.',
  },
  intern: {
    heading: 'Intern program',
    blurb: 'Learn the trade with our crew. Attach a resume if you have one.',
    button: 'Apply now',
    done: 'Application received. We will be in touch.',
  },
  nomination: {
    heading: 'Light Up For Hope',
    blurb: 'Know a family who could use a bright season? Nominate them here.',
    button: "Let's make their season bright",
    done: 'Thank you. We will review your nomination and follow up.',
  },
};

export default function SiteForm({ formType, formVariant, theme, compact }: Props) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string>('');
  // Set on mount, not during render: Date.now() during render is impure and
  // would also be the SSR clock rather than the visitor's.
  const renderedAt = useRef<number>(0);

  // Tell the embedding page how tall we are, so the <iframe> can size itself.
  // A fixed height either clips a long form on a phone or leaves a gap under a
  // short one, and the nomination form is three times the height of the footer
  // signup. Posted only to our own marketing origins, never '*', so the height
  // (and the fact a form is here at all) is not broadcast to any other frame.
  // Typed as HTMLElement because the success state swaps the <form> for a
  // <div>: without measuring that too, the frame would keep the form's height
  // and leave a tall empty box under a one-line thank-you.
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;
    const node = rootRef.current;
    if (!node) return;
    const send = () => {
      // Measure the FORM, not documentElement. documentElement stretches to
      // fill the iframe, so measuring it just reports back whatever height the
      // frame already has — the value can never grow or shrink, which is
      // exactly the bug this reported-height feature exists to avoid. The
      // form's own box is the real content height. +2 absorbs sub-pixel
      // rounding that would otherwise leave a 1px scrollbar inside the frame.
      const height = Math.ceil(node.getBoundingClientRect().height) + 2;
      for (const origin of EMBED_PARENT_ORIGINS) {
        window.parent.postMessage({ type: 'yll-form-height', formType, height }, origin);
      }
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(node);
    return () => observer.disconnect();
  }, [formType, status]);

  useEffect(() => {
    renderedAt.current = Date.now();
  }, []);

  const dark = theme === 'dark';
  const copy = COPY[formType];
  const needsResume = formType === 'careers' || formType === 'intern';
  const needsConsent = formType !== 'newsletter';
  const isNomination = formType === 'nomination';

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending');
    setError('');

    const form = e.currentTarget;
    const data = new FormData(form);

    const payload: Record<string, string> = {};
    for (const key of [
      'holidayMemory',
      'lightingMemory',
      'role',
      'message',
      'nomineeName',
      'nomineeAddress',
      'nomineeEmail',
      'nomineePhone',
      'relationship',
      'story',
    ]) {
      const v = data.get(key);
      if (typeof v === 'string' && v.trim()) payload[key] = v.trim();
    }

    const resume = data.get('resume');
    const hasFile = resume instanceof File && resume.size > 0;

    if (hasFile && (resume as File).size > RESUME_MAX_BYTES) {
      setError('That file is over 4MB. Please attach a smaller PDF or Word document.');
      setStatus('error');
      return;
    }

    try {
      let res: Response;
      const common = {
        formType,
        formVariant,
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        phone: String(data.get('phone') ?? ''),
        consent: data.get('consent') === 'on',
        company: String(data.get('company') ?? ''),
        elapsedMs: Date.now() - renderedAt.current,
        landingUrl: typeof document !== 'undefined' ? document.referrer : '',
      };

      if (hasFile) {
        const body = new FormData();
        Object.entries(common).forEach(([k, v]) => body.append(k, String(v)));
        body.append('payload', JSON.stringify(payload));
        body.append('resume', resume as File);
        res = await fetch(API, { method: 'POST', body });
      } else {
        res = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...common, payload }),
        });
      }

      // A body the platform rejected for size comes back as PLAIN TEXT with a
      // 413, not JSON. Parsing that blindly throws and the applicant sees a
      // meaningless error, so handle it before touching res.json().
      if (res.status === 413) {
        setError('That file is too large for the server. Please attach a smaller one.');
        setStatus('error');
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error || 'Something went wrong, please try again.');
        setStatus('error');
        return;
      }
      setStatus('done');
      form.reset();
    } catch {
      setError('Could not reach the server. Please try again.');
      setStatus('error');
    }
  }

  const text = dark ? '#fff' : '#1C2230';
  const muted = dark ? 'rgba(255,255,255,.85)' : '#565e70';
  const fieldBg = dark ? 'rgba(255,255,255,.12)' : '#fff';
  const fieldBorder = dark ? 'rgba(255,255,255,.35)' : '#D1D5DB';

  if (status === 'done') {
    return (
      <div
        ref={(el) => {
          rootRef.current = el;
        }}
        style={{ fontFamily: '"DM Sans", sans-serif', color: text, padding: compact ? 0 : 8 }}
      >
        <p style={{ fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 16, margin: 0 }}>
          {copy.done}
        </p>
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 16px',
    borderRadius: 50,
    border: `1px solid ${fieldBorder}`,
    background: fieldBg,
    color: dark ? '#fff' : '#1C2230',
    fontFamily: '"DM Sans", sans-serif',
    fontSize: 15,
    boxSizing: 'border-box',
  };
  const areaStyle: React.CSSProperties = { ...inputStyle, borderRadius: 16, minHeight: 96 };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: '"DM Sans", sans-serif',
    fontSize: 13,
    fontWeight: 700,
    color: muted,
    margin: '0 0 6px 2px',
  };

  return (
    <form
      onSubmit={onSubmit}
      ref={(el) => {
        rootRef.current = el;
      }}
      style={{ fontFamily: '"DM Sans", sans-serif', color: text, maxWidth: compact ? 520 : 680 }}
    >
      {!compact && (
        <>
          <h2
            style={{
              fontFamily: 'Poppins, sans-serif',
              fontWeight: 600,
              fontSize: 26,
              textTransform: 'uppercase',
              margin: '0 0 6px',
              color: text,
            }}
          >
            {copy.heading}
          </h2>
          <p style={{ color: muted, margin: '0 0 18px', fontSize: 15 }}>{copy.blurb}</p>
        </>
      )}

      {/* Honeypot: hidden from people, catnip for bots. Deliberately NOT
          aria-hidden, since that would put a focusable field inside a hidden
          subtree, which accessibility checkers flag. Off-screen plus
          tabIndex={-1} plus autoComplete="off" is the standard pattern. */}
      <div style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>
        <label>
          Company
          <input type="text" name="company" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {formType !== 'newsletter' && (
          <div>
            <label style={labelStyle} htmlFor="name">
              Your name
            </label>
            <input id="name" name="name" required style={inputStyle} autoComplete="name" />
          </div>
        )}

        {formType === 'newsletter' && !compact && (
          <div>
            <label style={labelStyle} htmlFor="name">
              Your name
            </label>
            <input id="name" name="name" style={inputStyle} autoComplete="name" />
          </div>
        )}

        <div style={compact ? { display: 'flex', gap: 8 } : undefined}>
          <div style={{ flex: 1 }}>
            {compact ? (
              // The footer form has no room for a visible label, but a
              // placeholder is not a label: it is not reliably announced and it
              // vanishes the moment someone starts typing. Hide it visually
              // only, never with display:none.
              <label htmlFor="email" style={SR_ONLY}>
                Email address
              </label>
            ) : (
              <label style={labelStyle} htmlFor="email">
                Email address
              </label>
            )}
            <input
              id="email"
              name="email"
              type="email"
              required
              placeholder={compact ? 'Your email address' : undefined}
              style={inputStyle}
              autoComplete="email"
            />
          </div>
          {compact && (
            <button
              type="submit"
              disabled={status === 'sending'}
              style={{
                fontFamily: 'Poppins, sans-serif',
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: '#fff',
                background: '#CF0303',
                border: 'none',
                borderRadius: 50,
                padding: '12px 22px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {status === 'sending' ? '...' : copy.button}
            </button>
          )}
        </div>

        {formType !== 'newsletter' && (
          <div>
            <label style={labelStyle} htmlFor="phone">
              Phone number
            </label>
            <input id="phone" name="phone" required style={inputStyle} autoComplete="tel" />
          </div>
        )}

        {formType === 'newsletter' && !compact && (
          <div>
            <label style={labelStyle} htmlFor="phone">
              Phone number (optional)
            </label>
            <input id="phone" name="phone" style={inputStyle} autoComplete="tel" />
          </div>
        )}

        {formType === 'careers' && (
          <>
            <div>
              <label style={labelStyle} htmlFor="role">
                What role are you interested in?
              </label>
              <input id="role" name="role" style={inputStyle} placeholder="Installer, crew lead, office" />
            </div>
            <div>
              <label style={labelStyle} htmlFor="lightingMemory">
                What is your favorite holiday lighting memory?
              </label>
              <textarea id="lightingMemory" name="lightingMemory" style={areaStyle} />
            </div>
          </>
        )}

        {formType === 'intern' && (
          <div>
            <label style={labelStyle} htmlFor="holidayMemory">
              What is your favorite holiday memory?
            </label>
            <textarea id="holidayMemory" name="holidayMemory" style={areaStyle} />
          </div>
        )}

        {needsResume && (
          <div>
            <label style={labelStyle} htmlFor="resume">
              Attach your resume (PDF or Word, up to 4MB)
            </label>
            <input
              id="resume"
              name="resume"
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              style={{ ...inputStyle, borderRadius: 12, padding: 10 }}
            />
          </div>
        )}

        {isNomination && (
          <>
            <div style={{ height: 1, background: fieldBorder, margin: '6px 0' }} />
            <p style={{ ...labelStyle, fontSize: 14, margin: 0 }}>About the person you are nominating</p>
            <div>
              <label style={labelStyle} htmlFor="nomineeName">
                Their full name
              </label>
              <input id="nomineeName" name="nomineeName" required style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="relationship">
                Your relationship to them
              </label>
              <input id="relationship" name="relationship" required style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="nomineeAddress">
                Their home address
              </label>
              <input id="nomineeAddress" name="nomineeAddress" required style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="nomineeEmail">
                Their email (if you have it)
              </label>
              <input id="nomineeEmail" name="nomineeEmail" type="email" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="nomineePhone">
                Their phone (if you have it)
              </label>
              <input id="nomineePhone" name="nomineePhone" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="story">
                Their story
              </label>
              <textarea id="story" name="story" style={areaStyle} />
            </div>
          </>
        )}

        {needsConsent && (
          <label
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              fontSize: 13,
              color: muted,
              lineHeight: 1.45,
            }}
          >
            <input type="checkbox" name="consent" required style={{ marginTop: 3 }} />
            {/* No "message and data rates" line: these submissions never enter
                a text campaign, so promising one would describe something that
                does not happen. */}
            <span>I agree to be contacted by Yule Love Lights about this submission.</span>
          </label>
        )}

        {!compact && (
          <button
            type="submit"
            disabled={status === 'sending'}
            style={{
              fontFamily: 'Poppins, sans-serif',
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: '#fff',
              background: '#CF0303',
              border: 'none',
              borderRadius: 50,
              padding: '14px 28px',
              cursor: 'pointer',
              justifySelf: 'start',
            }}
          >
            {status === 'sending' ? 'Sending...' : copy.button}
          </button>
        )}

        {status === 'error' && (
          <p role="alert" style={{ color: dark ? '#FFD1D1' : '#B00020', fontSize: 14, margin: 0 }}>
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
