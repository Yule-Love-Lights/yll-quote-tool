// Portal v4 — Section I: Cover / Opener.
// Reads like the opening page of a private client dossier. No navigation,
// no trust bar, no urgency — just the client's name in massive Cormorant
// italic, a formal file reference, and a short inscription that sets the
// tone for the rest of the document.

import { MapPin } from 'lucide-react';

export type CoverPageProps = {
  clientName: string;         // "Jasmine" or "The Smith Family"
  address: string;
  quoteRef: string;           // "YLL-2026-0142"
  dossierYear?: number;       // defaults to current
};

export function CoverPage({ clientName, address, quoteRef, dossierYear }: CoverPageProps) {
  const year = dossierYear ?? new Date().getFullYear();
  // Turn "YLL-2026-0142" into a File number like "N°0142" — keep the
  // full ref available in a monospaced subline for admin/support.
  const fileNumber = (() => {
    const tail = quoteRef.split('-').pop() ?? quoteRef;
    const cleaned = tail.replace(/[^0-9A-Za-z]/g, '');
    return cleaned ? `N°${cleaned}` : quoteRef;
  })();

  return (
    <section
      aria-labelledby="concierge-cover-heading"
      className="portal-concierge-section relative"
    >
      <div className="max-w-4xl mx-auto px-6 md:px-10 text-center">
        <p className="portal-concierge-eyebrow">
          Yule Love Lights · Private Client Dossier
        </p>

        <div className="portal-concierge-hairline max-w-xs mx-auto my-8" aria-hidden />

        <p className="portal-concierge-numeral text-[22px] md:text-[26px] mb-8">
          I
        </p>

        <h1
          id="concierge-cover-heading"
          className="font-display text-[56px] md:text-[96px] lg:text-[112px] leading-[0.95] text-[var(--yc-ink)]"
          style={{ letterSpacing: '-0.012em' }}
        >
          <span className="font-display-italic">for</span>
          <br />
          {clientName}
        </h1>

        <div className="portal-concierge-ornament mt-10 max-w-sm mx-auto">
          <span className="portal-concierge-ornament-mark" aria-hidden>✦</span>
        </div>

        <p className="font-display-italic text-[20px] md:text-[24px] text-[var(--yc-ink-soft)] max-w-xl mx-auto leading-[1.5]">
          A considered holiday lighting proposal, prepared by hand for the {year} season.
        </p>

        <dl className="mt-14 md:mt-20 grid grid-cols-1 sm:grid-cols-2 gap-y-6 gap-x-10 max-w-2xl mx-auto text-left">
          <div>
            <dt className="portal-concierge-eyebrow mb-2">Residence</dt>
            <dd className="flex items-start gap-2 text-[15px] md:text-[16px] text-[var(--yc-ink)] leading-[1.5]">
              <MapPin className="w-4 h-4 mt-1 flex-shrink-0 text-[var(--yc-red-deep)]" aria-hidden />
              <span>{address}</span>
            </dd>
          </div>
          <div>
            <dt className="portal-concierge-eyebrow mb-2">File</dt>
            <dd className="font-display text-[22px] md:text-[26px] text-[var(--yc-red-deep)]">
              {fileNumber}
              <span className="block mt-1 text-[11px] font-mono tracking-wide text-[var(--yc-ink-muted)]">
                Ref. {quoteRef}
              </span>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
