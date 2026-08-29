// Advertising workers + campaigns management — ADMIN ONLY. This page is the
// account-creation door's UI: add a worker, mint their advertising-role
// login, set campaign rates (a money knob — every future acceptance stamps
// the campaign's current rate).

import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { getSessionRole } from '@/lib/auth/sessionRole';
import PeoplePanel from '@/components/admin/advertising/PeoplePanel';

export const dynamic = 'force-dynamic';

export default async function AdvertisingPeoplePage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <OperatorShell active="advertising-people">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Advertising workers and campaigns</h1>
          <p className="text-sm text-gray-500 mt-1">
            Workers sign in at quote.yulelovelights.com and land on their own capture page. Their
            login can reach nothing else.
          </p>
          <p className="text-sm mt-2 flex gap-4">
            <a href="/admin/advertising" className="underline text-gray-600">← review queue</a>
            <a href="/admin/advertising/pay" className="underline text-gray-600">Pay summary</a>
          </p>
        </div>
        <PeoplePanel />
      </main>
    </OperatorShell>
  );
}
