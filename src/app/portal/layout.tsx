// Portal route segment layout. Scoped to /portal/** so the admin UI
// keeps its existing Geist typography unchanged. Loads Playfair Display
// (headings) + Inter (body) via next/font/google for zero-CLS and
// self-hosting (Google Fonts never reach the client — faster LCP).
//
// The portal serves the SNOWGLOBE design (the chosen final customer-
// facing skin). Its CSS layers on top of the dark-theme tokens: the
// below-the-fold components are dark-themed, and snowglobe adds the
// interactive-hero + night-sky overrides. Both files are imported here
// and applied via the `portal-dark-root portal-snowglobe-root` wrapper.

import type { Metadata } from 'next';
import { Playfair_Display, Inter } from 'next/font/google';
import './portal-dark.css';
import './portal-snowglobe.css';

const playfair = Playfair_Display({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-portal-serif',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-portal-sans',
  display: 'swap',
});

// naldo/mobile-app-branding: the quote tool's web manifest starts at `/`, which
// is the OPERATOR login for anyone who is not staff. This segment is customer
// facing, so it drops the manifest rather than inheriting it: a homeowner who
// adds their page to the home screen gets a shortcut back to the page they were
// on, not an app that opens our login screen. `null` is Next's remove-this-field
// value, not merely an absent key. The apple-touch-icon is deliberately left
// inherited, so they still get the YLL logo instead of the old black square.
export const metadata: Metadata = {
  title: 'Your Yule Love Lights Quote',
  description:
    'Your personalized holiday lighting design — tap to see it light up.',
  manifest: null,
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`portal-dark-root portal-snowglobe-root ${playfair.variable} ${inter.variable}`}
    >
      {children}
    </div>
  );
}
