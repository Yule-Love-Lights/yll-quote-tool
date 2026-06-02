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

export const metadata: Metadata = {
  title: 'Your Yule Love Lights Quote',
  description:
    'Your personalized holiday lighting design — tap to see it light up.',
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
