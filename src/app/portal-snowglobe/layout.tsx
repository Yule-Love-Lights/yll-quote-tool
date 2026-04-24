// Portal v6 SNOWGLOBE route layout. Scoped to /portal-snowglobe/** so
// v1 and v2 stay untouched. Layers v6 CSS on top of the dark theme so
// we can reuse dark-themed below-the-fold components without divergence.

import type { Metadata } from 'next';
import { Playfair_Display, Inter } from 'next/font/google';
import '../portal-dark/portal-dark.css';
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

export default function PortalSnowglobeLayout({
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
