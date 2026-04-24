// Portal v4 — Disclaimer footer.
// Quiet legal/contact block below the Engagement section. Small serif,
// centered, cream-muted.

export type DisclaimerProps = {
  quoteRef: string;
  phone: string;
};

export function Disclaimer({ quoteRef, phone }: DisclaimerProps) {
  const telHref = `tel:${phone.replace(/[^0-9+]/g, '')}`;
  const year = new Date().getFullYear();

  return (
    <footer className="bg-[var(--yc-cream)] border-t border-[var(--yc-rule-soft)]">
      <div className="max-w-3xl mx-auto px-6 md:px-10 py-14 md:py-16 text-center">
        <div className="portal-concierge-ornament max-w-xs mx-auto mb-8">
          <span className="portal-concierge-ornament-mark" aria-hidden>✦</span>
        </div>
        <p className="font-display-italic text-[15px] md:text-[16px] text-[var(--yc-ink-soft)] leading-[1.7] max-w-xl mx-auto">
          This dossier was prepared by hand for a single residence. Pricing is valid for 30 days
          from issue. Installation is subject to weather and an agreed schedule.
        </p>
        <p className="mt-6 text-[12px] tracking-[0.18em] uppercase text-[var(--yc-ink-muted)]">
          Ref. {quoteRef} · Issued {year}
        </p>
        <p className="mt-4 text-[13px] text-[var(--yc-ink-muted)]">
          Enquiries:{' '}
          <a href={telHref} className="portal-concierge-link">
            {phone}
          </a>
        </p>
        <p className="mt-8 text-[11px] text-[var(--yc-ink-muted)] tracking-wide">
          © {year} Yule Love Lights · Long Island, New York
        </p>
      </div>
    </footer>
  );
}
