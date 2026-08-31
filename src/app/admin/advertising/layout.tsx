// Segment layout for the ADMIN advertising surface. Markup passthrough; it
// exists only to give these pages the advertising app's home-screen identity
// instead of the quote tool's.
//
// iOS reads the manifest of whatever page is on screen when you tap Add to Home
// Screen. The owner's camera lives under /admin/advertising, which is a root
// layout page, so without this the owner installing the advertising app would
// have saved the QUOTE icon and name. Now both cameras, the crew one under
// /advertising and the owner one here, carry the same advertising branding, and
// the manifest's start_url (/advertising/go) routes each account to its own.
//
// Deliberately the SAME icon and name as the crew app rather than a third set:
// it is one advertising app with two doors, and nobody holds both logins on one
// phone. Naldo's call.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  applicationName: 'YLL Advertising',
  manifest: '/manifest-advertising.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'YLL Ads',
    statusBarStyle: 'black',
  },
  icons: {
    icon: '/favicon.ico',
    apple: [
      { url: '/icons/yll-advertising-apple-touch.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

export default function AdminAdvertisingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
