// Branded 404 for the customer quote portal. Next renders this when a portal
// page calls notFound() — an unknown, mistyped, or stale quote id — instead of
// the bare framework 404. A customer who taps an old link still lands somewhere
// warm with a clear way to reach us. Audit 2026-06 (UX — no error/not-found
// boundary; quote-not-found showed a raw framework page).

const PHONE = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
const TEL_HREF = `tel:${PHONE.replace(/[^\d+]/g, '')}`;

export default function PortalNotFound() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-6 bg-[#0B140F] px-6 py-16 text-center text-[#F4EFE6] [padding-bottom:calc(4rem+env(safe-area-inset-bottom))]">
      <div className="text-5xl" aria-hidden>
        ✨
      </div>
      <h1 className="text-2xl font-semibold sm:text-3xl">
        We couldn&apos;t find that quote
      </h1>
      <p className="max-w-md text-base leading-relaxed text-[#C9D3CB]">
        The link may be out of date or mistyped. If you got it from us by text or
        email, try tapping it again — or give us a call and we&apos;ll send you a
        fresh one right away.
      </p>
      <a
        href={TEL_HREF}
        className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-[#E8B862] px-8 text-base font-semibold text-[#0B140F] shadow-lg transition-transform active:scale-95"
      >
        Call us: {PHONE}
      </a>
    </main>
  );
}
