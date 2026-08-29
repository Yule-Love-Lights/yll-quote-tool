import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
import ManageCrewScreen from '@/components/advertising/simplecrew/ManageCrewScreen';
import { AdminTabs } from '@/components/advertising/simplecrew/Tabs';

export const dynamic = 'force-dynamic';

// Manage Crew (Simple Crew replica): the accounts door + sign stock.
export default async function AdminCrewPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <>
      <ManageCrewScreen />
      <AdminTabs active="crew" />
    </>
  );
}
