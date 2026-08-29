import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
import PayScreen from '@/components/advertising/simplecrew/PayScreen';
import SettingsScreen from '@/components/advertising/simplecrew/SettingsScreen';
import { AdminTabs } from '@/components/advertising/simplecrew/Tabs';

export const dynamic = 'force-dynamic';

// Admin settings (Simple Crew replica): the Pay summary and settings are
// ONE screen (Naldo's device round, 2026-08-29), with password + sign out
// against the OPERATOR routes (admins are operators), the way back to the
// main quote tool, and a jump to the inventory stock page.
export default async function AdminAdvertisingSettingsPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <>
      <SettingsScreen
        passwordUrl="/api/account/password"
        logoutUrl="/api/auth/logout"
        topSection={<PayScreen />}
        extraRows={[
          { label: 'Back to the quote tool', href: '/' },
          { label: 'Inventory stock (yard-sign SKU)', href: '/inventory/stock' },
        ]}
      />
      <AdminTabs active="settings" />
    </>
  );
}
