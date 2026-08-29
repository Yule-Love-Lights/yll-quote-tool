import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
import CampaignsScreen from '@/components/advertising/simplecrew/CampaignsScreen';
import { AdminTabs } from '@/components/advertising/simplecrew/Tabs';

export const dynamic = 'force-dynamic';

// Admin advertising home = the Campaigns tab (Simple Crew replica). ADMIN
// ONLY, per Naldo's ruling: office operators do not see placement status.
export default async function AdminAdvertisingPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <>
      <CampaignsScreen
        mode="admin"
        campaignsUrl="/api/admin/advertising/campaigns"
        detailHrefBase="/admin/advertising/campaigns"
        createUrl="/api/admin/advertising/campaigns"
      />
      <AdminTabs active="campaigns" />
    </>
  );
}
