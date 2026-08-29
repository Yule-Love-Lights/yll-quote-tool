import { redirect } from 'next/navigation';

import { createRouteSupabase, isAdvertisingAccount } from '@/lib/auth/supabaseServer';
import WorkerHome from '@/components/advertising/WorkerHome';

// The advertising worker home (ops hub workstream B): capture a sign, see
// pending/earned money, see rejection reasons, resubmit. The proxy already
// confines advertising sessions TO this surface; this page closes the other
// direction — an operator or admin wandering here is sent back to the
// dashboard (office does not see placement status; admin review lives under
// /admin/advertising).
export default async function AdvertisingPage() {
  const supabase = await createRouteSupabase();
  if (!supabase) redirect('/login');
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?from=%2Fadvertising');
  if (!isAdvertisingAccount(user.app_metadata)) redirect('/');

  return <WorkerHome />;
}
