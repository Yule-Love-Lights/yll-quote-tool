import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
import PayScreen from '@/components/advertising/simplecrew/PayScreen';
import { AdminTabs } from '@/components/advertising/simplecrew/Tabs';

export const dynamic = 'force-dynamic';

// The admin profile tab, repurposed as PAY (our money view in the replica's
// card language).
export default async function AdminPayPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <>
      <PayScreen />
      <AdminTabs active="pay" />
    </>
  );
}
