'use client';

// Error boundary for the customer quote portal segment. Next renders this when
// a portal page (or its data load) throws — e.g. Supabase is down or a render
// dependency fails — instead of the bare framework error page. The customer
// gets a calm, on-brand message, a "Try again" that re-runs the segment, and a
// phone CTA so a transient outage never reads as a dead end.
// Audit 2026-06 (UX — no error boundary; a thrown error showed a raw page).

import { useEffect } from 'react';

const PHONE = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
const TEL_HREF = `tel:${PHONE.replace(/[^\d+]/g, '')}`;

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the server logs / monitoring; the customer never sees details.
    console.error('[portal] render error:', error);
  }, [error]);

  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-6 bg-[#0B140F] px-6 py-16 text-center text-[#F4EFE6] [padding-bottom:calc(4rem+env(safe-area-inset-bottom))]">
      <div className="text-5xl" aria-hidden>
        🎄
      </div>
      <h1 className="text-2xl font-semibold sm:text-3xl">
        Something went wrong on our end
      </h1>
      <p className="max-w-md text-base leading-relaxed text-[#C9D3CB]">
        Sorry about that — your quote is safe. Give it another try in a moment,
        and if it keeps happening just call us and we&apos;ll sort it out.
      </p>
      <div className="flex flex-col items-stretch gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-[#E8B862] px-8 text-base font-semibold text-[#0B140F] shadow-lg transition-transform active:scale-95"
        >
          Try again
        </button>
        <a
          href={TEL_HREF}
          className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[#E8B862]/50 px-8 text-base font-semibold text-[#F4EFE6] transition-transform active:scale-95"
        >
          Call us: {PHONE}
        </a>
      </div>
    </main>
  );
}
