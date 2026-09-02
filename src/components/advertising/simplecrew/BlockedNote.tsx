// Plain server-rendered answer for a login the population lock admits but
// the worker table cannot serve (deactivated, or not yet linked).
//
// It carries a Sign out button because this screen is otherwise a dead end.
// The advertising app installs as a standalone home-screen icon, so there is
// no address bar and no back button, and every other page in the surface,
// including the Settings screen holding the only other Sign out control,
// gates on the same check that produced this block. Without this the only way
// out is to force-quit the app. Found by the S84 wrap staff lens.

import { BlockedNoteSignOut } from './BlockedNoteSignOut';
export default function BlockedNote({ reason }: { reason: 'inactive' | 'no_worker_row' }) {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-3 bg-[#0B140F] px-6 text-center text-[#F4EFE6]">
      <h1 className="text-xl font-semibold">
        {reason === 'inactive' ? 'This account is switched off' : 'Almost set up'}
      </h1>
      <p className="max-w-sm text-sm text-[#C9C0A6]">
        {reason === 'inactive'
          ? 'Your sign-crew account is not active right now. Talk to the office if that seems wrong.'
          : 'Your login works, but the office has not finished setting up your worker profile yet. Give them a call.'}
      </p>
      <BlockedNoteSignOut />
    </main>
  );
}
