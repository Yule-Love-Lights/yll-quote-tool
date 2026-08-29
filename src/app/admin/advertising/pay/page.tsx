// Advertising pay summary — ADMIN ONLY. Server-rendered straight from the
// data layer: earned = stamped rates on accepted yard signs (history, never
// moves); pending = an estimate at each campaign's CURRENT rate, labeled as
// such so the two numbers are never mistaken for each other.

import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { earningsSummary } from '@/lib/advertising/placements';
import { listAdvertisingWorkers } from '@/lib/advertising/workers';

export const dynamic = 'force-dynamic';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function AdvertisingPayPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  const [summaries, workers] = await Promise.all([
    earningsSummary(),
    listAdvertisingWorkers({ includeInactive: true }),
  ]);
  const nameById = new Map(workers.map((w) => [w.id, w.displayName]));

  return (
    <OperatorShell active="advertising-pay">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Advertising pay</h1>
          <p className="text-sm text-gray-500 mt-1">
            Earned is settled history (the rate stamped when each sign was accepted). Pending is
            an estimate at today&apos;s rates and moves until review happens.
          </p>
          <p className="text-sm mt-2">
            <a href="/admin/advertising" className="underline text-gray-600">← review queue</a>
          </p>
        </div>

        {summaries.length === 0 && (
          <p className="text-sm text-gray-500">No placements yet.</p>
        )}

        {summaries.map((s) => (
          <section key={s.workerId} className="mb-6 rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold text-gray-900">{nameById.get(s.workerId) ?? '(unknown worker)'}</h2>
              <p className="text-sm">
                <span className="font-semibold text-gray-900">{dollars(s.total.acceptedEarnedCents)} earned</span>
                {s.total.pendingEstimatedCents > 0 && (
                  <span className="text-gray-500"> · {dollars(s.total.pendingEstimatedCents)} pending (est.)</span>
                )}
              </p>
            </div>
            {s.byWeek.length > 0 && (
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-1 font-medium">Week of</th>
                    <th className="py-1 font-medium text-right">Earned</th>
                    <th className="py-1 font-medium text-right">Pending (est.)</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byWeek.map((w) => (
                    <tr key={w.weekStart} className="border-t border-gray-100">
                      <td className="py-1 text-gray-700">{w.weekStart}</td>
                      <td className="py-1 text-right text-gray-900">{dollars(w.acceptedEarnedCents)}</td>
                      <td className="py-1 text-right text-gray-500">
                        {w.pendingEstimatedCents > 0 ? dollars(w.pendingEstimatedCents) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </main>
    </OperatorShell>
  );
}
