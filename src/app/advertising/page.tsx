import { redirect } from 'next/navigation';

import { getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import WorkerHome from '@/components/advertising/WorkerHome';

// The advertising worker home (ops hub workstream B): capture a sign, see
// pending/earned money, see rejection reasons, resubmit. The proxy already
// confines advertising sessions TO this surface; this page closes the other
// direction — an operator or admin wandering here is sent back to the
// dashboard (office does not see placement status; admin review lives under
// /admin/advertising). A deactivated or not-yet-set-up login gets a plain
// explanation instead of a capture form whose every submit would 403.
export default async function AdvertisingPage() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    if (caller.reason === 'unauthenticated') redirect('/login?from=%2Fadvertising');
    if (caller.reason === 'not_advertising') redirect('/');
    return (
      <main className="flex min-h-[100svh] flex-col items-center justify-center gap-3 bg-[#0B140F] px-6 text-center text-[#F4EFE6]">
        <h1 className="text-xl font-semibold">
          {caller.reason === 'inactive' ? 'This account is switched off' : 'Almost set up'}
        </h1>
        <p className="max-w-sm text-sm text-[#C9D3CB]">
          {caller.reason === 'inactive'
            ? 'Your sign-crew account is not active right now. Talk to the office if that seems wrong.'
            : 'Your login works, but the office has not finished setting up your worker profile yet. Give them a call.'}
        </p>
      </main>
    );
  }

  return <WorkerHome />;
}
