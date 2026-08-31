import { redirect } from 'next/navigation';

import BlockedNote from '@/components/advertising/simplecrew/BlockedNote';
import { getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { getSessionRole } from '@/lib/auth/sessionRole';

export const dynamic = 'force-dynamic';

// The advertising app's front door, and the only thing it does is send you to
// YOUR camera. It exists because there are two of them: crews shoot at
// /advertising/capture under an advertising login, and the owner shoots at
// /admin/advertising/capture under an admin login (the "owners shoot too"
// camera, which auto-provisions its own worker row so the photos run through
// the same review and pay rules). One installed icon, one tap, straight into
// the camera, whichever account you are.
//
// Naldo asked for exactly that: "I just wanna be able to click the app and then
// start taking photos." Before this, the app opened /advertising, which refuses
// every non-advertising account, so his admin login was bounced to the quote
// tool and the ads app looked broken to the one person who owns the company.
//
// This is a ROUTER, not a new permission: each destination keeps the gate it
// already had, and nothing here widens who may reach either camera. An admin
// could always open /admin/advertising/capture by typing it; the crew surface
// still refuses admins exactly as before.
export default async function AdvertisingEntryPage() {
  // Admin first. getSessionRole returns null for an advertising login, so this
  // cannot swallow a crew member, and an admin has no advertising marker, so
  // getAdvertisingCaller would only ever refuse them.
  const role = await getSessionRole();
  if (role === 'admin') redirect('/admin/advertising/capture');

  const caller = await getAdvertisingCaller();
  if (caller.ok) redirect('/advertising/capture');

  // Same three refusals the two camera pages already handle, worded the same
  // way, so this door behaves identically to walking up to either of them.
  if (caller.reason === 'unauthenticated') redirect('/login?from=%2Fadvertising%2Fgo');
  if (caller.reason === 'not_advertising') redirect('/');
  return <BlockedNote reason={caller.reason} />;
}
