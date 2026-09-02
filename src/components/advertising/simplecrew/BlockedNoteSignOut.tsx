'use client';

import { useState } from 'react';

// The escape hatch on BlockedNote. Installed as a standalone home-screen app the
// advertising surface has no address bar and no back button, and every page in
// it gates on the same getAdvertisingCaller() that produced the block, including
// the Settings screen that holds the only other Sign Out control. So a
// deactivated or not-yet-linked crew member had nowhere to go at all: not to a
// different account, not back to a working screen. Found by the S84 wrap staff
// lens.
//
// The logout route itself does NOT gate on the worker row (it just clears the
// caller's own session), and the perimeter admits an advertising session
// anywhere under /api/advertising, so this reaches its endpoint from exactly the
// state that is blocked.
export function BlockedNoteSignOut() {
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      await fetch('/api/advertising/account/logout', { method: 'POST' });
    } catch {
      // Sending them to the login screen is the right move either way: if the
      // POST failed the session may still be live, and the login page is the
      // one screen that can replace it.
    }
    window.location.href = '/login';
  };

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="mt-2 min-h-[44px] rounded-full border border-white/25 px-6 text-sm font-semibold text-[#F4EFE6] disabled:opacity-60"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
