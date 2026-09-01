import { redirect } from 'next/navigation';

import { getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import BlockedNote from '@/components/advertising/simplecrew/BlockedNote';
import CampaignsScreen from '@/components/advertising/simplecrew/CampaignsScreen';
import { WorkerTabs } from '@/components/advertising/simplecrew/Tabs';

// Worker home = the Campaigns tab (Simple Crew replica). The proxy confines
// advertising sessions TO this surface; this gate closes the other
// direction and gives deactivated / not-yet-linked logins a plain answer.
export default async function AdvertisingCampaignsPage() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    if (caller.reason === 'unauthenticated') redirect('/login?from=%2Fadvertising');
    if (caller.reason === 'not_advertising') redirect('/');
    return <BlockedNote reason={caller.reason} />;
  }

  return (
    <>
      <CampaignsScreen
        mode="worker"
        campaignsUrl="/api/advertising/campaigns"
        detailHrefBase="/advertising/campaigns"
      />
      <WorkerTabs active="campaigns" />
    </>
  );
}
