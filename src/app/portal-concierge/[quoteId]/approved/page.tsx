// Portal v4 — Engagement confirmed page.
// Formal counterpart to v2's ApprovalCelebration (no confetti — concierge
// doesn't celebrate, it confirms). Cream background, embossed "Confirmed"
// mark, serif letter-style body, oxblood signature.

import Link from 'next/link';
import { ArrowRight, Phone } from 'lucide-react';
import { MOCK_QUOTE, MOCK_TEAM } from '@/components/portal/mockQuote';

type Params = { quoteId: string };

export default async function PortalConciergeApprovedPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { quoteId } = await params;
  const quote = MOCK_QUOTE;
  const telHref = `tel:${MOCK_TEAM.phone.replace(/[^0-9+]/g, '')}`;
  const tail = quote.id.split('-').pop() ?? quote.id;
  const fileNumber = `N°${tail.replace(/[^0-9A-Za-z]/g, '')}`;

  return (
    <main className="relative w-full min-h-screen bg-[var(--yc-cream)]">
      {/* Opening: cover-page treatment with "Confirmed" seal */}
      <section
        aria-labelledby="confirmed-headline"
        className="portal-concierge-section relative"
      >
        <div className="max-w-3xl mx-auto px-6 md:px-10 text-center">
          <p className="portal-concierge-eyebrow">
            Yule Love Lights · Engagement confirmed
          </p>
          <div className="portal-concierge-hairline max-w-xs mx-auto my-8" aria-hidden />

          {/* Embossed seal — oxblood outlined circle with "CONFIRMED" */}
          <div
            className="relative mx-auto mb-10 md:mb-12 w-36 h-36 md:w-44 md:h-44 rounded-full border-2 border-[var(--yc-red-deep)] flex items-center justify-center"
            aria-hidden
            style={{
              boxShadow:
                '0 0 0 8px rgba(139,31,43,0.06), inset 0 0 0 1px rgba(139,31,43,0.25)',
            }}
          >
            <div className="absolute inset-3 rounded-full border border-[var(--yc-red-deep)] opacity-60" />
            <div className="flex flex-col items-center justify-center">
              <span className="portal-concierge-eyebrow text-[10px] md:text-[11px] text-[var(--yc-red-deep)]">
                Dossier
              </span>
              <span
                className="font-display-italic text-[22px] md:text-[26px] text-[var(--yc-red-deep)] mt-1 leading-[1]"
              >
                confirmed
              </span>
              <span
                aria-hidden
                className="mt-2 h-px bg-[var(--yc-red-deep)] opacity-50 w-10"
              />
              <span className="portal-concierge-eyebrow mt-2 text-[10px] text-[var(--yc-red-deep)]">
                {fileNumber}
              </span>
            </div>
          </div>

          <h1
            id="confirmed-headline"
            className="font-display text-[44px] md:text-[72px] leading-[1.05] text-[var(--yc-ink)]"
          >
            Thank you, <span className="font-display-italic">{quote.customer.firstName}.</span>
          </h1>

          <p className="mt-6 max-w-xl mx-auto font-display-italic text-[18px] md:text-[22px] text-[var(--yc-ink-soft)] leading-[1.55]">
            Your deposit is received, your installation window reserved, and the {MOCK_TEAM.leaderName} has
            been notified personally.
          </p>
        </div>
      </section>

      {/* Letter-style body: what happens next, signed */}
      <section
        aria-labelledby="what-happens-next"
        className="portal-concierge-band portal-concierge-section"
      >
        <div className="max-w-2xl mx-auto px-6 md:px-10">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">
            II
          </p>
          <p className="portal-concierge-eyebrow mb-4">What happens next</p>
          <h2
            id="what-happens-next"
            className="font-display text-[34px] md:text-[48px] leading-[1.1] text-[var(--yc-ink)] mb-8"
          >
            From here, we take it <span className="font-display-italic">from here.</span>
          </h2>

          <div className="space-y-6 font-display-italic text-[17px] md:text-[19px] text-[var(--yc-ink-soft)] leading-[1.75]">
            <p className="portal-concierge-dropcap">
              A formal receipt has been emailed. The evening before your installation, you will
              receive a two-hour arrival window by text. On the day, our crew arrives in a marked
              vehicle — two to four hours on site, no nails, no staples, nothing left behind but
              the lights.
            </p>
            <p>
              Between January 9 and February 3, we return and remove every strand, clip, timer,
              and extension. The home returns to exactly how we found it.
            </p>
            <p>
              Should anything require my attention between now and install day, please text
              directly.
            </p>
          </div>

          <p
            className="mt-10 font-display-italic text-[30px] md:text-[42px] text-[var(--yc-red-deep)] leading-[1]"
            style={{ transform: 'rotate(-1.5deg)', transformOrigin: 'left' }}
          >
            — {MOCK_TEAM.leaderName}
          </p>
          <p className="mt-2 portal-concierge-eyebrow text-[var(--yc-ink-muted)]">
            {MOCK_TEAM.title} · Yule Love Lights
          </p>
        </div>
      </section>

      {/* Contact + return */}
      <section aria-label="Support" className="portal-concierge-section">
        <div className="max-w-3xl mx-auto px-6 md:px-10 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">III</p>
          <p className="portal-concierge-eyebrow mb-4">Enquiries</p>
          <h3 className="font-display text-[28px] md:text-[36px] text-[var(--yc-ink)]">
            Questions between now and install day?
          </h3>
          <p className="mt-3 font-display-italic text-[16px] md:text-[18px] text-[var(--yc-ink-soft)]">
            Text {MOCK_TEAM.leaderName} directly.
          </p>
          <a
            href={telHref}
            className="portal-concierge-btn-secondary inline-flex items-center gap-2.5 mt-6 px-6 py-3 rounded-sm font-semibold text-[16px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--yc-red-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--yc-cream)]"
          >
            <Phone className="w-4 h-4" aria-hidden />
            {MOCK_TEAM.phone}
          </a>

          <div className="mt-12">
            <Link
              href={`/portal-concierge/${quoteId}`}
              className="portal-concierge-link inline-flex items-center gap-1.5 font-display-italic text-[16px] md:text-[17px]"
            >
              Return to dossier
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      <footer className="bg-[var(--yc-cream)] border-t border-[var(--yc-rule-soft)]">
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-10 md:py-12 text-center">
          <p className="text-[12px] leading-[1.7] text-[var(--yc-ink-muted)] max-w-[60ch] mx-auto">
            Your deposit is fully refundable up until the morning of your scheduled install. A
            receipt has been emailed.
          </p>
        </div>
      </footer>
    </main>
  );
}
