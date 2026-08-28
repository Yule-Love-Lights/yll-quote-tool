// Branded 404 for the referral landing page. Next renders this when
// /refer/<code> calls notFound() — a mistyped, expired, or made-up code —
// instead of the bare framework "This page could not be found".
//
// Wrap-review 2026-08-28, customer lens MEDIUM: these links get retyped from a
// screenshot, a yard sign, or a half-copied text, so a wrong code is a normal
// event, not an edge case. The person on the other end is a stranger we are
// trying to earn, and the framework 404 gives them no brand, no offer, and no
// way to reach us. Mirrors the precedent at
// src/app/portal/[quoteId]/not-found.tsx.

const PHONE = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
const TEL_HREF = `tel:${PHONE.replace(/[^\d+]/g, '')}`;

export default function ReferNotFound() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-6 bg-[#0B140F] px-6 py-16 text-center text-[#F4EFE6] [padding-bottom:calc(4rem+env(safe-area-inset-bottom))]">
      <div className="text-5xl" aria-hidden>
        ✨
      </div>
      <h1 className="text-2xl font-semibold sm:text-3xl">
        That referral link didn&apos;t work
      </h1>
      <p className="max-w-md text-base leading-relaxed text-[#C9D3CB]">
        The code may be mistyped or out of date. If a neighbor sent it to you,
        ask them to tap their own link and send it again — or just call us and
        we&apos;ll set you up with a free quote either way.
      </p>
      <a
        href={TEL_HREF}
        className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-[#E8B862] px-8 text-base font-semibold text-[#0B140F] shadow-lg transition-transform active:scale-95"
      >
        Call us: {PHONE}
      </a>
      <a
        href="https://yulelovelights.com"
        className="text-sm font-medium text-[#C9D3CB] underline underline-offset-4"
      >
        See what we do
      </a>
    </main>
  );
}
