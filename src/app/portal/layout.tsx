// Portal route segment layout. Scoped to /portal/** so the admin UI
// keeps its existing Geist typography unchanged. Loads Playfair Display
// (headings) + Inter (body) via next/font/google for zero-CLS and
// self-hosting (Google Fonts never reach the client — faster LCP).

import type { Metadata } from 'next';
import { Playfair_Display, Inter } from 'next/font/google';
import './portal.css';

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
    'Your personalized holiday lighting design — approve and reserve your install date.',
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`portal-root ${playfair.variable} ${inter.variable}`}>
      {children}
    </div>
  );
}
