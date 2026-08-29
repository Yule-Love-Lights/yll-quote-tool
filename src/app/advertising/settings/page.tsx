import { redirect } from 'next/navigation';

import { getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import BlockedNote from '@/components/advertising/simplecrew/BlockedNote';
import SettingsScreen from '@/components/advertising/simplecrew/SettingsScreen';
import { WorkerTabs } from '@/components/advertising/simplecrew/Tabs';

// Worker settings (Simple Crew replica): Change Password, Sign Out, Contact
// Support — all against routes inside the advertising namespace, since the
// perimeter confines this population there.
export default async function WorkerSettingsPage() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    if (caller.reason === 'unauthenticated') redirect('/login?from=%2Fadvertising');
    if (caller.reason === 'not_advertising') redirect('/');
    return <BlockedNote reason={caller.reason} />;
  }

  return (
    <>
      <SettingsScreen
        passwordUrl="/api/advertising/account/password"
        logoutUrl="/api/advertising/account/logout"
      />
      <WorkerTabs active="settings" />
    </>
  );
}
