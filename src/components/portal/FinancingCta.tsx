// #154 interim — the Wisetack financing CTA block. A small, tasteful note +
// link that opens the merchant's real Wisetack prequal page in a new tab.
// Purely presentational (no hooks, no fetch): every gate (flag, URL, service
// type, $500–$25,000 balance) is decided by the CALLER via isFinancingEligible,
// so when this renders, financing is genuinely on offer. Used in two spots:
// the approve/sign modal (under the deposit line, live-selection balance) and
// the /approved page (approved-snapshot balance).
//
// No 'use client' needed: hook-free, so it renders server-side on /approved
// and joins the client bundle only where a client component imports it.

export function FinancingCta({ url }: { url: string }) {
  return (
    <div className="mt-3 rounded-xl border border-[#FFB744]/25 px-4 py-3">
      <p className="text-[13px] text-[#A89F87] leading-[1.55]">
        Prefer monthly payments? Financing through Wisetack: check your options in 60 seconds
        with no credit impact.
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 inline-flex items-center min-h-[44px] text-[13px] font-semibold text-[#FFB744] underline underline-offset-4 hover:text-[#FFD07A] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] rounded-sm"
      >
        See financing options
      </a>
    </div>
  );
}
