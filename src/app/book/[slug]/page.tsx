// Branded booking pages: /book/<slug>.
//
// GoHighLevel hosts the calendar and we host the page around it. The widget is
// framed exactly as GoHighLevel's own embed code frames it, including its
// form_embed.js, which is what measures the widget and resizes the iframe to
// match. Without that script the calendar renders at the wrong height.
//
// Public: allowlisted in src/lib/auth/operatorGate.ts. The page reads no
// customer record and no database. Everything on it is either a constant in
// this folder or a photo that already ships in public/references.
//
// Note the direction of the framing. We frame GoHighLevel; nobody frames us.
// The app's baseline X-Frame-Options: SAMEORIGIN in next.config.ts still
// applies to this route, and deliberately so.

import type { Metadata } from 'next';
import Image from 'next/image';
import Script from 'next/script';
import { notFound } from 'next/navigation';
import {
  BOOKING_CALENDARS,
  GHL_FORM_EMBED_SCRIPT,
  bookingWidgetSrc,
  findBookingCalendar,
} from './calendars';
import { BACKDROP_PHOTOS } from './backdropPhotos';
import { MARKETING_SITE_URL, OFFICE_PHONE, OFFICE_TEL_HREF } from './contact';
import { BookingBackdrop } from './BookingBackdrop';

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return BOOKING_CALENDARS.map((calendar) => ({ slug: calendar.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const calendar = findBookingCalendar(slug);
  if (!calendar) return { title: 'Yule Love Lights' };
  return {
    title: `${calendar.heading} | Yule Love Lights`,
    description: calendar.subheading,
    // Not indexed, matching src/app/forms/[type] and src/app/refer/[code]. This
    // is a link we hand to one person at a time, and it is a thin page whose
    // only real content belongs to GoHighLevel. Letting a search engine rank it
    // would put it in competition with the marketing site for the same terms.
    robots: { index: false, follow: false },
  };
}

export default async function BookingPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const calendar = findBookingCalendar(slug);
  if (!calendar) notFound();

  return (
    // shrink-0 because the root layout makes <body> a flex column, and a flex
    // item is shrunk to the container height by default. Without it this div
    // stays exactly one viewport tall while the booking widget overflows past
    // it, and the operator surface's cream body background shows through below
    // the fold.
    <div className="relative min-h-screen w-full shrink-0 bg-[#060B0F] text-white">
      <BookingBackdrop photos={BACKDROP_PHOTOS} />

      {/* pt-72 clears the mobile photo band (h-64) that BookingBackdrop pins to
          the top of the page. From md up the backdrop is fixed behind
          everything, so that clearance is not needed and the padding shrinks.
          Deliberately NOT vertically centred: the booking widget is taller than
          a laptop viewport once GoHighLevel measures it, and centring content
          taller than its container overflows in both directions, which puts the
          top of the card above the scroll origin where nobody can reach it. */}
      <main className="relative mx-auto flex w-full max-w-2xl flex-col items-center px-4 pt-72 pb-16 md:pt-16 md:pb-20">
        {/* The logo is the way back to the rest of the business, which is the
            only navigation a single-purpose page like this needs. */}
        <a href={MARKETING_SITE_URL} className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
          <Image
            src="/yule-site-logo-2.png"
            alt="Yule Love Lights"
            width={598}
            height={385}
            priority
            className="h-auto w-40 drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] sm:w-48"
          />
        </a>

        <h1 className="mt-6 text-center text-3xl font-semibold tracking-tight drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)] sm:text-4xl">
          {calendar.heading}
        </h1>
        <p className="mt-3 max-w-xl text-center text-base text-white/80 drop-shadow-[0_1px_6px_rgba(0,0,0,0.7)]">
          {calendar.subheading}
        </p>

        <div className="mt-8 w-full overflow-hidden rounded-2xl bg-white shadow-[0_24px_60px_rgba(0,0,0,0.55)] ring-1 ring-white/10">
          <iframe
            // GoHighLevel's script finds the frame by id, so the id has to be
            // present and unique on the page. Derived from the calendar id
            // rather than the random timestamp their copy-paste snippet uses,
            // so it stays stable between renders.
            id={`${calendar.calendarId}_booking`}
            src={bookingWidgetSrc(calendar.calendarId)}
            title={calendar.heading}
            allow="payment"
            // Deliberately NOT scrolling="no", which is what GoHighLevel's own
            // snippet uses. That is safe only while form_embed.js is alive to
            // size the frame exactly. If the script is blocked, slow, or the
            // vendor is down, a fixed height plus no scrolling means everything
            // past the fold is unreachable and the customer cannot book at all.
            // Leaving the frame scrollable costs nothing on the happy path,
            // because the script sets the exact height and no overflow remains.
            //
            // The starting height is a guess for the same reason: GoHighLevel's
            // snippet starts at zero and shows nothing until measured. Real
            // measured heights are 926 on desktop and 983 on a phone, so this is
            // deliberately short of both and the scroll is what covers the gap.
            style={{ width: '100%', border: 'none', height: 720 }}
          />
        </div>

        {/* Always visible, not conditional on the widget failing. There is no
            reliable way to detect a cross-origin iframe rendering nothing, and
            a booking page whose only path forward is a third-party script is a
            dead end the moment that script is blocked by an ad blocker or the
            vendor has an outage. */}
        <p className="mt-6 text-center text-sm text-white/70 drop-shadow-[0_1px_6px_rgba(0,0,0,0.7)]">
          Prefer to talk it through?{' '}
          <a
            href={OFFICE_TEL_HREF}
            className="font-semibold text-white underline underline-offset-4 hover:text-white/90"
          >
            Call us at {OFFICE_PHONE}
          </a>
        </p>
      </main>

      <Script src={GHL_FORM_EMBED_SCRIPT} strategy="afterInteractive" />
    </div>
  );
}
