// Approval confirmation page. Shown after the customer approves on
// /portal/[quoteId] (pre-Valor flow: no online payment yet — we tell them
// we'll reach out to collect the 50% deposit). Confetti, booking summary,
// next steps, and a referral mention.
//
// This is the SNOWGLOBE celebration (gold-only confetti, dark raised
// cards, amber accent, product-page-tight spacing). It reuses the dark
// ApprovalCelebration component.
//
// Server component (zero JS until the confetti/copy-link child mounts);
// ApprovalCelebration is the only client boundary here.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Truck, MessageSquare, PackageOpen, Phone, CreditCard, ArrowRight } from 'lucide-react';
import { MOCK_QUOTE, MOCK_TEAM } from '@/components/portal/mockQuote';
import { ApprovalCelebration } from '@/components/portal/dark/ApprovalCelebration';
import { loadPortalQuote, PortalConfigError } from '@/lib/portal/loader';
import { formatQuoteRef, formatUsd } from '@/components/portal/format';
import type { PortalQuote } from '@/components/portal/types';

type Params = { quoteId: string };

// Real DB first; MOCK only when Supabase isn't configured (dev). 404 on a
// missing row, AND 404 unless the customer has actually approved — prevents
// previewing the celebration page before booking. notFound() lives OUTSIDE
// the try so it isn't swallowed.
async function resolveQuote(quoteId: string): Promise<PortalQuote> {
  let real: PortalQuote | null = null;
  try {
    real = await loadPortalQuote(quoteId);
  } catch (err) {
    if (err instanceof PortalConfigError) return MOCK_QUOTE;
    throw err;
  }
  if (!real) notFound();
  if (!real.approval) notFound();
  return real;
}

export default async function PortalApprovedPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ balance?: string }>;
}) {
  const { quoteId } = await params;
  // `?balance=paid` (set by the pay-balance hosted-page successUrl) means the
  // customer just paid off the remaining balance, not the deposit. The copy
  // below must confirm that payment instead of saying it's still owed.
  const { balance } = await searchParams;
  const balancePaid = balance === 'paid';
  const quote = await resolveQuote(quoteId);
  const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || MOCK_TEAM.phone;
  const telHref = `tel:${phone.replace(/[^0-9+]/g, '')}`;

  // #39/#40 — the booking summary reflects the customer's actual choices.
  // Install window follows the Sep/Oct early-install pick; takedown follows the
  // premium-takedown add-on (premium pulls everything down before Jan 9).
  // Optional-chained so the dev MOCK_QUOTE (no approval) renders the standard
  // windows.
  // Service line drives the confirmation copy (3-valued — holiday / permanent / event).
  // Permanent = year-round: no seasonal window, no takedown, track-mounted (not clipped).
  // Event (#96, live) = date-driven + short-term: it DOES take down (but not on the
  // holiday season window) and is clip-installed like holiday. Only holiday gets the
  // seasonal install window + the Jan 9–Feb 3 takedown copy.
  const isPermanent = quote.serviceType === 'permanent';
  const isEvent = quote.serviceType === 'event';
  const headlineEmoji = isPermanent ? '💡' : isEvent ? '🎉' : '🎄';
  const installWindow =
    isPermanent || isEvent
      ? "We'll confirm your install date"
      : quote.approval?.installTiming === 'september'
        ? 'Mid-Late September'
        : quote.approval?.installTiming === 'october'
          ? 'October'
          : 'Mid-November – Early December';
  const takedownWindow = quote.approval?.takedownSelected ? 'Starting Jan 1' : 'Jan 9 – Feb 3';
  // Summary field: permanent = lifetime warranty (no takedown); event = after the
  // event (no holiday window); holiday = the seasonal window.
  const takedownFieldLabel = isPermanent ? 'Warranty' : 'Takedown';
  const takedownFieldValue = isPermanent
    ? 'Lifetime materials'
    : isEvent
      ? 'After your event'
      : takedownWindow;

  // Deposit amount from the approval snapshot (shown when we have it).
  const depositUsd = quote.approval?.depositUsd ?? 0;
  const depositPhrase = depositUsd > 0 ? ` (about ${formatUsd(depositUsd)})` : '';
  // #38 — once the deposit webhook confirms payment this becomes the "you're
  // BOOKED" page (deposit received) instead of the placeholder "we'll reach out
  // to collect it". Drives the headline, intro line, and step 1 below.
  const isPaid = !!quote.approval?.depositPaidAt;

  const nextSteps: Array<{
    icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    title: string;
    body: string;
  }> = [
    isPaid || balancePaid
      ? {
          icon: CreditCard,
          title: balancePaid ? 'Balance paid in full' : 'Deposit received',
          body: balancePaid
            ? `We've got your final balance payment. You're paid in full, thanks for choosing Yule Love Lights.`
            : `We've got your 50% deposit${depositPhrase} — your spot is locked in. The remaining balance is collected after your install is complete.`,
        }
      : {
          icon: CreditCard,
          title: 'We reach out to collect your deposit',
          body: `A quick call or text to take your 50% deposit${depositPhrase} and confirm your install date — that locks in your spot.`,
        },
    {
      icon: MessageSquare,
      title: 'We text you the day before',
      body: 'You get a 2-hour arrival window the night before your install date.',
    },
    {
      icon: Truck,
      title: 'Our team installs',
      body: isPermanent
        ? '2–4 hours on-site. We mount the track to your roofline and set the LED pucks — clean and low-profile. You don\'t need to be home.'
        : '2–4 hours on-site. Clips only — no nails, no staples, no damage. You don\'t need to be home.',
    },
    isPermanent
      ? {
          icon: PackageOpen,
          title: 'Lifetime materials warranty',
          body: 'Your lights stay up year-round — no takedown. The LED pucks and track carry a lifetime materials warranty (labor billed separately, non-transferable).',
        }
      : isEvent
        ? {
            icon: PackageOpen,
            title: 'We take everything down',
            body: 'After your event, our team returns to remove everything — lights, clips, extensions — all gone. We confirm the takedown timing with you.',
          }
        : {
            icon: PackageOpen,
            title: 'We take everything down',
            body: `Takedown ${quote.approval?.takedownSelected ? 'starts Jan 1' : 'runs Jan 9 – Feb 3'}. Lights, clips, extensions — all gone.`,
          },
  ];

  return (
    <main className="relative min-h-screen w-full bg-[#060B0F] overflow-hidden">
      <ApprovalCelebration />

      <section aria-labelledby="snow-approved-headline" className="relative w-full">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 md:pt-32 pb-10 md:pb-14 text-center">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-4">
            Quote {isPaid ? 'booked' : 'approved'} · Quote {formatQuoteRef(quote.id)}
          </p>
          <h1
            id="snow-approved-headline"
            className="font-display text-[40px] leading-[1.05] md:text-[68px] md:leading-[1.02] font-semibold text-[#F4ECD8] tracking-[-0.02em]"
            style={{ textShadow: '0 0 36px rgba(255,183,68,0.22)' }}
          >
            <span aria-hidden>{headlineEmoji}</span> You&apos;re {isPaid ? 'booked' : 'approved'}!
          </h1>
          <p className="font-display italic text-[20px] md:text-[24px] text-[#E0D7C1] mt-4">
            Here&apos;s what happens next.
          </p>
          {isPaid ? (
            <p className="mt-6 text-[16px] md:text-[17px] text-[#A89F87] max-w-xl mx-auto leading-[1.65]">
              Thanks,{' '}
              <span className="font-semibold text-[#E0D7C1]">{quote.customer.firstName}</span>. Your
              deposit{depositPhrase} is in and your install is locked in — you&apos;re officially
              booked. We&apos;ll be in touch to confirm your install date.
            </p>
          ) : (
            <p className="mt-6 text-[16px] md:text-[17px] text-[#A89F87] max-w-xl mx-auto leading-[1.65]">
              Thanks,{' '}
              <span className="font-semibold text-[#E0D7C1]">{quote.customer.firstName}</span>. We&apos;ve
              got your approval — we&apos;ll reach out shortly to collect your 50% deposit{depositPhrase} and
              lock in your install date.
            </p>
          )}
        </div>
      </section>

      <section aria-label="Quote summary" className="w-full">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-10 md:pb-16">
          <div className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-6 md:p-8 shadow-[0_2px_6px_rgba(0,0,0,0.55),0_32px_72px_-16px_rgba(0,0,0,0.80)]">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.22em] uppercase text-[#FFB744]">
                  Address
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#F4ECD8] mt-1">
                  {quote.customer.address}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.22em] uppercase text-[#FFB744]">
                  Install window
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#F4ECD8] mt-1">
                  {installWindow}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.22em] uppercase text-[#FFB744]">
                  {takedownFieldLabel}
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#F4ECD8] mt-1">
                  {takedownFieldValue}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="snow-approved-next"
        className="w-full bg-[#0D1519] border-y border-[#1F2A23]"
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20">
          <div className="max-w-xl mb-10 md:mb-12">
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-3">
              What Happens Next
            </p>
            <h2
              id="snow-approved-next"
              className="font-display text-[28px] md:text-[40px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
            >
              You don&apos;t lift a finger from here.
            </h2>
          </div>

          <ol className="grid grid-cols-1 sm:grid-cols-2 gap-5 md:gap-6">
            {nextSteps.map((step, i) => (
              <li
                key={step.title}
                className="relative rounded-2xl bg-[#060B0F] border border-[#1F2A23] p-6 md:p-7 shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]"
              >
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-[#060B0F] border border-[#FFB744]/45 text-[#FFB744] shadow-[0_0_22px_rgba(255,183,68,0.35)]"
                >
                  <step.icon className="w-5 h-5" aria-hidden />
                </span>
                <p className="mt-4 text-[11px] font-semibold tracking-[0.22em] uppercase text-[#FFB744]">
                  Step {i + 1}
                </p>
                <h3 className="mt-1 font-display text-[19px] md:text-[20px] font-semibold text-[#F4ECD8] leading-[1.25]">
                  {step.title}
                </h3>
                <p className="mt-2 text-[14px] md:text-[15px] text-[#A89F87] leading-[1.6]">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="snow-approved-referral" className="w-full bg-[#060B0F]">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
          <div className="max-w-2xl">
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-3">
              Want to help a neighbor?
            </p>
            <h2
              id="snow-approved-referral"
              className="font-display text-[28px] md:text-[42px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
            >
              Refer a neighbor, get{' '}
              <span className="text-[#FFB744]" style={{ textShadow: '0 0 22px rgba(255,183,68,0.35)' }}>
                $150 off
              </span>{' '}
              next year.
            </h2>
            <p className="mt-4 text-[16px] md:text-[17px] text-[#A89F87] leading-[1.65]">
              Tell them to mention you when they call us! When they book an install, we&apos;ll
              credit your account automatically, stackable for every friend who joins.
            </p>
          </div>
        </div>
      </section>

      <section aria-label="Support" className="w-full bg-[#0D1519] border-t border-[#1F2A23]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20 text-center">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-3">
            Questions between now and install day?
          </p>
          <h3 className="font-display text-[26px] md:text-[32px] font-semibold text-[#F4ECD8]">
            Text Us Directly.
          </h3>
          <a
            href={telHref}
            className="inline-flex items-center gap-2.5 mt-5 px-5 py-3 rounded-xl bg-transparent text-[#FFB744] border border-[#FFB744]/45 font-semibold text-[16px] cursor-pointer transition-[background-color,box-shadow,color] duration-200 hover:bg-[#FFB744]/10 hover:text-[#FFD07A] shadow-[0_0_16px_rgba(255,183,68,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519]"
            style={{ textShadow: '0 0 14px rgba(255,183,68,0.3)' }}
          >
            <Phone className="w-5 h-5" aria-hidden />
            {phone}
          </a>

          <div className="mt-10">
            <Link
              href={`/portal/${quoteId}`}
              className="inline-flex items-center gap-1.5 font-display underline underline-offset-4 text-[#FFB744] hover:text-[#FFD07A] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519] rounded-sm"
            >
              View your quote
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      <footer className="w-full bg-[#060B0F] border-t border-[#1F2A23]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-12 text-center">
          <p className="text-[12px] leading-[1.65] text-[#7B7361] max-w-[65ch] mx-auto">
            {balancePaid
              ? 'Your balance is paid in full. Thank you for choosing Yule Love Lights.'
              : isPaid
                ? 'Your deposit is paid and your spot is locked in — the remaining balance is collected after your install is complete.'
                : "No payment is due right now — we'll reach out to collect your deposit and confirm your install date."}
          </p>
        </div>
      </footer>
    </main>
  );
}
