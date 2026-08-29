import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
import SettingsScreen from '@/components/advertising/simplecrew/SettingsScreen';
import { AdminTabs } from '@/components/advertising/simplecrew/Tabs';

export const dynamic = 'force-dynamic';

// Admin settings (Simple Crew replica): password + sign out against the
// OPERATOR routes (admins are operators), plus a jump to the inventory
// stock page where the yard-sign SKU also lives.
export default async function AdminAdvertisingSettingsPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <>
      <SettingsScreen
        passwordUrl="/api/account/password"
        logoutUrl="/api/auth/logout"
        extraRows={[{ label: 'Inventory stock (yard-sign SKU)', href: '/inventory/stock' }]}
      />
      <AdminTabs active="settings" />
    </>
  );
}
