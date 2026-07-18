// Referral route segment layout (ledger #41, referral page bug batch
// 2026-07-17, fix 2). Scoped to /refer/** — mirrors src/app/portal/layout.tsx:
// loads the SAME dark-portal fonts (Playfair Display for `font-display`
// headings, Inter for body) and the SAME portal-dark.css design tokens the
// refer page's markup already assumes.
//
// Root cause of the bug this fixes: TrustSection's `.trust-marquee*` rules
// live in portal-dark.css, imported ONLY by the portal layout — the refer
// route never loaded it, so the trust logos rendered as giant unstyled
// stacked images instead of a scrolling marquee row. The refer page's
// `font-display` headings had the same gap (no Playfair Display loaded, so
// they silently fell back to a generic serif).
//
// portal-dark-root ONLY (no portal-snowglobe-root): snowglobe layers the
// interactive-hero / night-sky overrides for InteractiveHero, which the refer
// page doesn't use — its hero is its own bespoke markup.

import { Playfair_Display, Inter } from 'next/font/google';
import '../portal/portal-dark.css';

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

export default function ReferLayout({
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
