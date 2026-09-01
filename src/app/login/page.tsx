// Operator login page (ledger #81, Option B — Supabase Auth). A SERVER
// component now; the form itself lives in LoginForm.tsx and is unchanged.
//
// Why it had to move: iOS reads the manifest of whatever page is on screen when
// you tap Add to Home Screen. Anyone heading for the advertising app while
// signed out is bounced here first, and this page inherited the QUOTE app's
// manifest, icon and name from the root layout, so installing from the login
// screen saved the wrong app. A page can only vary that per request through
// generateMetadata, which a 'use client' module cannot export.
//
// The whole change is metadata. Nothing about signing in moved.

import { Suspense } from 'react';
import type { Metadata } from 'next';

import { LoginForm } from './LoginForm';

// The paths that mean "this person is on their way to the advertising app".
// /advertising covers the crew doors including the /advertising/go router the
// installed icon opens; /admin/advertising covers the owner's camera, which the
// router sends an admin to.
function isAdvertisingDestination(from: string): boolean {
  const path = from.length > 1 && from.endsWith('/') ? from.slice(0, -1) : from;
  return (
    path === '/advertising' ||
    path.startsWith('/advertising/') ||
    path === '/admin/advertising' ||
    path.startsWith('/admin/advertising/')
  );
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[] }>;
}): Promise<Metadata> {
  const { from } = await searchParams;
  // A repeated ?from= gives an array. Take nothing rather than guess.
  const target = typeof from === 'string' ? from : '';

  // `from` is attacker-controllable, so it is only ever COMPARED here, never
  // interpolated into a URL or any emitted tag. The two outcomes are fixed
  // literals; the worst a crafted value can do is pick the other one.
  if (!isAdvertisingDestination(target)) {
    // Inherit the root layout's quote-tool identity unchanged.
    return {};
  }

  return {
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
}

export default function LoginPage() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-8 bg-[#0B140F] px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold text-[#F4EFE6]">Yule Love Lights — Operator</h1>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
