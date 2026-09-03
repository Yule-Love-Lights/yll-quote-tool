// Segment layout for the advertising surface. It exists ONLY to give this
// surface its own home-screen identity: field workers install the photo capture
// as a separate app from the office quote tool, so it needs its own name, its
// own icon and its own manifest. The markup is a passthrough, so nothing about
// how these pages render changes.
//
// Next merges metadata down the segment tree by REPLACING a field a nested
// segment sets, so naming `manifest`, `icons` and `appleWebApp` here overrides
// all three from the root layout for every /advertising path. `title` and the
// rest are deliberately left alone and still inherit.
//
// One thing worth knowing before telling a worker to install this: iOS reads
// the manifest of whatever page is on screen when you tap Add to Home Screen.
// A signed-out worker sent to /advertising/capture is redirected to /login,
// which is a root-layout page, so installing from there would save the QUOTE
// icon. The /install page tells them to sign in first for exactly this reason.

import type { Metadata } from 'next';

import { AppShell } from '@/components/advertising/simplecrew/ui';

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

// The markup is no longer a bare passthrough: AppShell caps the surface at
// phone width and centres it, because on a desktop screen every one of these
// screens stretched the whole window (Naldo, 2026-09-01). Nothing about the
// phone rendering changes: the cap only binds above 520px.
export default function AdvertisingLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
