// Home-screen install page (naldo/mobile-app-branding).
//
// One public URL Naldo can text to a new staffer instead of walking them
// through Add to Home Screen on the phone. Each card is one installable app:
// its real icon, who it is for, a QR code to scan from another phone, a link to
// open it on this one, and the add-to-home-screen steps for iPhone and Android.
//
// Public by design and allowlisted in operatorGate: it reads no customer record
// and touches no database. The only information on it is two of our own URLs,
// which any staffer already has. It is noindex so it never turns up in search.
//
// Server component. It reads PORTAL_BASE_URL through appBaseUrl(), which is a
// runtime env read, so it must not be pre-rendered at build time.

import type { Metadata } from 'next';
import Image from 'next/image';
import { QrSvg } from '@/components/QrSvg';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
// The same generic qrcode wrapper the referral link uses (inline SVG, no browser
// canvas and no remote QR service, so it renders in a server component under a
// strict CSP). Named for its first caller rather than for QR codes in general.
import { referralQrSvg } from '@/lib/referralQr';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Add Yule Love Lights To Your Phone',
  description: 'Install the Yule Love Lights apps on your phone home screen.',
  robots: { index: false, follow: false },
};

type InstallApp = {
  slug: string;
  name: string;
  homeScreenName: string;
  audience: string;
  path: string;
  icon: string;
  /** Shown only when there is something the person must do before installing. */
  caution?: string;
};

const APPS: InstallApp[] = [
  {
    slug: 'quote',
    name: 'YLL Quote Tool',
    homeScreenName: 'YLL Quote',
    audience: 'Office and admin. Quotes, customers, invoices, the dashboard.',
    path: '/',
    icon: '/icons/yll-quote-192.png',
  },
  {
    slug: 'advertising',
    name: 'YLL Advertising',
    homeScreenName: 'YLL Ads',
    audience: 'Field crews. Photographing yard signs and door hangers to get paid.',
    // The worker HOME, not /advertising/capture. Both pages gate on an
    // advertising account, and after signing in the login route sends an
    // advertising worker to /advertising, so this is the page they are actually
    // standing on at the moment they add it to the home screen. Capture is one
    // tap from there.
    path: '/advertising',
    icon: '/icons/yll-advertising-192.png',
    // Two ways this saves the wrong icon, both worth saying out loud. iOS reads
    // the manifest of whatever page is ON SCREEN: a signed-out worker is bounced
    // to /login, which is a root-layout page carrying the QUOTE branding. And an
    // office or admin login is redirected to the quote tool by design (the
    // advertising surface refuses every non-advertising account), so an admin
    // cannot install this one at all, no matter which link they open.
    caution:
      'Crew logins only. Sign in first and wait until you see the Campaigns screen before you add it to your home screen. Office and admin logins are sent to the quote tool instead, so this app can only be installed from a crew login.',
  },
];

export default async function InstallPage() {
  const base = appBaseUrl();

  const cards = await Promise.all(
    APPS.map(async (app) => {
      const url = `${base}${app.path}`;
      return { app, url, qr: await referralQrSvg(url) };
    }),
  );

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10" style={{ color: 'var(--op-text)' }}>
      <h1 className="text-2xl font-bold">Put Yule Love Lights on your phone</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--op-text-dim)' }}>
        Two separate apps. Install the one you use, or both. Open this page on the phone you want to
        set up, or scan a code below from that phone.
      </p>

      <div className="mt-8 space-y-6">
        {cards.map(({ app, url, qr }) => (
          <section
            key={app.slug}
            className="rounded-2xl border p-5"
            style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
          >
            <div className="flex items-start gap-4">
              <Image
                src={app.icon}
                alt={`${app.name} app icon`}
                width={64}
                height={64}
                className="h-16 w-16 shrink-0 rounded-2xl"
                unoptimized
              />
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{app.name}</h2>
                <p className="mt-1 text-sm" style={{ color: 'var(--op-text-dim)' }}>{app.audience}</p>
                <p className="mt-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>
                  Saves to your home screen as{' '}
                  <span className="font-semibold" style={{ color: 'var(--op-text)' }}>{app.homeScreenName}</span>
                </p>
              </div>
            </div>

            {app.caution ? (
              <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900">
                {app.caution}
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-center">
              {qr ? <QrSvg svg={qr} className="h-36 w-36 border" /> : null}

              <div className="min-w-0">
                <a
                  href={app.path}
                  className="inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white"
                  style={{ background: 'var(--op-primary)' }}
                >
                  Open on this phone
                </a>
                <p className="mt-2 break-all text-xs" style={{ color: 'var(--op-text-dim)' }}>{url}</p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold">iPhone</h3>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm" style={{ color: 'var(--op-text-dim)' }}>
                  <li>Open the link above in Safari.</li>
                  <li>Tap the Share button at the bottom.</li>
                  <li>Tap Add to Home Screen.</li>
                  <li>Tap Add.</li>
                </ol>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Android</h3>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm" style={{ color: 'var(--op-text-dim)' }}>
                  <li>Open the link above in Chrome.</li>
                  <li>Tap the three dots at the top right.</li>
                  <li>Tap Add to Home screen.</li>
                  <li>Tap Install.</li>
                </ol>
              </div>
            </div>
          </section>
        ))}
      </div>

      <p className="mt-8 text-xs" style={{ color: 'var(--op-text-dim)' }}>
        On an iPhone this only works in Safari. The other iPhone browsers cannot add an app to the
        home screen.
      </p>
    </main>
  );
}
