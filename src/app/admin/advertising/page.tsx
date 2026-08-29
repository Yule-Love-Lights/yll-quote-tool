// Advertising review queue — ADMIN ONLY (Naldo's ruling: only he and Jason
// accept or reject; office operators do not see placement status). The gate
// runs server-side on the session role, matching /admin/fleet/clocks.

import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { getSessionRole } from '@/lib/auth/sessionRole';
import ReviewQueue from '@/components/admin/advertising/ReviewQueue';

export const dynamic = 'force-dynamic';

export default async function AdvertisingReviewPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    // active="leads" deliberately: that OperatorArea matches no nav item, so
    // no tab highlights (the OperatorNav line-20 convention). Advertising gets
    // its own nav slot once the #1055 View-as nav mechanism lands.
    <OperatorShell active="leads">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Yard sign review</h1>
          <p className="text-sm text-gray-500 mt-1">
            Accepting a yard sign pays the worker its campaign rate, stamped at that moment.
            Duplicate flags are hints, not verdicts: signs legitimately cluster at corners.
          </p>
          <p className="text-sm mt-2 flex gap-4">
            <a href="/admin/advertising/people" className="underline text-gray-600">Workers and campaigns</a>
            <a href="/admin/advertising/pay" className="underline text-gray-600">Pay summary</a>
          </p>
        </div>
        <ReviewQueue />
      </main>
    </OperatorShell>
  );
}
