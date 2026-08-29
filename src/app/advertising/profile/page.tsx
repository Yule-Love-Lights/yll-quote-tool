import { redirect } from 'next/navigation';

import { getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { createRouteSupabase } from '@/lib/auth/supabaseServer';
import BlockedNote from '@/components/advertising/simplecrew/BlockedNote';
import ProfileScreen from '@/components/advertising/simplecrew/ProfileScreen';
import { WorkerTabs } from '@/components/advertising/simplecrew/Tabs';

// Worker profile (Simple Crew replica): avatar, name, email, the Photos
// Feed / Map View toggle over their own placements, plus the money strip.
export default async function WorkerProfilePage() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    if (caller.reason === 'unauthenticated') redirect('/login?from=%2Fadvertising');
    if (caller.reason === 'not_advertising') redirect('/');
    return <BlockedNote reason={caller.reason} />;
  }

  const supabase = await createRouteSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };

  return (
    <>
      <ProfileScreen displayName={caller.worker.displayName} email={user?.email ?? null} />
      <WorkerTabs active="profile" />
    </>
  );
}
