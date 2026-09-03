// Branded 404 for the booking pages. Next renders this when /book/<slug> calls
// notFound() on a slug that is not in the registry.
//
// Pre-merge review 2026-08-31, customer and staff lenses both MEDIUM,
// independently: a booking link gets retyped from a text message, an email
// signature or a screenshot, so a wrong slug is a normal event rather than an
// edge case. Without this the person lands on the bare framework 404, with no
// brand and no way to reach anyone. Mirrors the precedent added one session
// earlier at src/app/refer/[code]/not-found.tsx.

import { MARKETING_SITE_URL, OFFICE_PHONE, OFFICE_TEL_HREF } from './contact';

export default function BookNotFound() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-6 bg-[#0B140F] px-6 py-16 text-center text-[#F4EFE6] [padding-bottom:calc(4rem+env(safe-area-inset-bottom))]">
      <div className="text-5xl" aria-hidden>
        📅
      </div>
      <h1 className="text-2xl font-semibold sm:text-3xl">
        That booking link didn&apos;t work
      </h1>
      <p className="max-w-md text-base leading-relaxed text-[#C9D3CB]">
        The link may be mistyped or out of date. Give us a call and we will find
        a time that works for you.
      </p>
      <a
        href={OFFICE_TEL_HREF}
        className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-[#E8B862] px-8 text-base font-semibold text-[#0B140F] shadow-lg transition-transform active:scale-95"
      >
        Call us: {OFFICE_PHONE}
      </a>
      <a
        href={MARKETING_SITE_URL}
        className="text-sm font-medium text-[#C9D3CB] underline underline-offset-4"
      >
        See what we do
      </a>
    </main>
  );
}
