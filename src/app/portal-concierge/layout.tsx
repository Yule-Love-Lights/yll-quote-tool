// Portal CONCIERGE v4 route layout. Scoped to /portal-concierge/**.
// Typography: Cormorant Garamond for display (more editorial than v1/v2's
// Playfair) + Inter for body text. The display serif change is a big
// part of the "private client dossier" feel.

import type { Metadata } from 'next';
import { Cormorant_Garamond, Inter } from 'next/font/google';
import './portal-concierge.css';

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-concierge-serif',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-concierge-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Your Yule Love Lights Dossier',
  description:
    'Your private holiday lighting dossier — reviewed, considered, and ready for your approval.',
};

export default function PortalConciergeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`portal-concierge-root ${cormorant.variable} ${inter.variable}`}>
      {children}
    </div>
  );
}
