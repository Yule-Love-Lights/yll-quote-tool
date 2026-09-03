import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
import HotSpotMap from '@/components/advertising/simplecrew/HotSpotMap';
import { AdminTabs } from '@/components/advertising/simplecrew/Tabs';

export const dynamic = 'force-dynamic';

// The whole-island map where the owner marks where to send the crew and
// where to keep them out (2026-09-01). Admin only: these marks steer where
// people are sent, so they are not something a crew member sets.
export default async function AdminAdvertisingMapPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <>
      <HotSpotMap />
      <AdminTabs active="settings" />
    </>
  );
}
