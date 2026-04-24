// Portal DARK v2 route layout. Scoped to /portal-dark/** so v1 stays
// untouched at /portal/**. Same font pair as v1 for visual continuity
// (Playfair Display + Inter); the difference is in the CSS theme.

import type { Metadata } from 'next';
import { Playfair_Display, Inter } from 'next/font/google';
import './portal-dark.css';

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

export default function PortalDarkLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`portal-dark-root ${playfair.variable} ${inter.variable}`}>
      {children}
    </div>
  );
}
