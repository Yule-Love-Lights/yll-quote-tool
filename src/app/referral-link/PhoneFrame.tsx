'use client';

// Decorative phone-shaped frame around an <iframe> (naldo/referral-link-
// preview, PIECE 3). Used twice on /referral-link: once showing the
// no-database sample at /refer/preview (PIECE 2) before someone generates a
// link, and once showing their own real /refer/<code> page after they do.
// Same-origin framing is allowed here: next.config.ts sets
// X-Frame-Options: SAMEORIGIN (not a stricter per-path CSP), and both the
// preview route and the real /refer/<code> page are served from this same
// app/origin.
//
// Purely decorative, treated that way on purpose: everything this frame
// shows is already available elsewhere on the page as plain text or a real
// control (the offer copy in page.tsx, the link + Copy button in
// ReferralLinkReady), so it is safe to hide the iframe from assistive tech
// and the tab order entirely, and safe to drop silently if it fails to
// load. The link and Copy button that actually matter are never children
// of this component and never wait on it, so a failed frame never breaks
// the page, only removes a nice-to-have.

import { useState } from 'react';

// A real phone's content viewport, roughly. The iframe always renders at
// this size internally, so its own `md:` Tailwind breakpoints never trigger
// regardless of how small the frame is displayed on the outer page; only
// the CSS transform below changes how big it LOOKS.
const DEVICE_WIDTH = 375;
const DEVICE_HEIGHT = 700;
// Displayed size: how big the frame actually reads on the page. Fixed
// rather than fluid: 375px is the primary target per the brief, and this
// page's own column caps at max-w-lg (512px), so one fixed size reads fine
// at both the mobile and desktop widths this page actually renders at.
const DISPLAY_WIDTH = 260;
const SCALE = DISPLAY_WIDTH / DEVICE_WIDTH;
const DISPLAY_HEIGHT = Math.round(DEVICE_HEIGHT * SCALE);
const BEZEL_PX = 10;

export function PhoneFrame({ src, title, className }: { src: string; title: string; className?: string }) {
  const [failed, setFailed] = useState(false);

  // Decorative only: whatever this frame was showing is always available
  // elsewhere on the page too, so a failed load just means no frame, never
  // a broken page.
  if (failed) return null;

  return (
    <div
      className={`mx-auto rounded-[2.25rem] bg-black p-[10px] shadow-[0_20px_50px_-15px_rgba(0,0,0,0.6)] ring-1 ring-white/10${className ? ` ${className}` : ''}`}
      style={{ width: DISPLAY_WIDTH + BEZEL_PX * 2 }}
    >
      <div
        className="relative overflow-hidden rounded-[1.5rem] bg-[#060B0F]"
        style={{ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT }}
      >
        <iframe
          src={src}
          title={title}
          // Decorative duplicate of content shown elsewhere in real text/
          // controls: out of the tab order and out of the accessibility
          // tree entirely, so it can never trap keyboard focus.
          tabIndex={-1}
          aria-hidden="true"
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute left-0 top-0 border-0"
          style={{
            width: DEVICE_WIDTH,
            height: DEVICE_HEIGHT,
            transform: `scale(${SCALE})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
    </div>
  );
}
