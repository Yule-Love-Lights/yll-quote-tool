import { redirect } from 'next/navigation';

import { getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import BlockedNote from '@/components/advertising/simplecrew/BlockedNote';
import CameraScreen from '@/components/advertising/simplecrew/CameraScreen';

// The worker camera (Simple Crew replica): full screen, no tab bar. All the
// interesting behavior lives in CameraScreen; this page only gates.
export default async function WorkerCapturePage() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    if (caller.reason === 'unauthenticated') redirect('/login?from=%2Fadvertising');
    if (caller.reason === 'not_advertising') redirect('/');
    return <BlockedNote reason={caller.reason} />;
  }

  return (
    <CameraScreen
      campaignsUrl="/api/advertising/campaigns"
      submitUrl="/api/advertising/placements"
      noteBase="/api/advertising/placements"
      backHref="/advertising"
    />
  );
}
