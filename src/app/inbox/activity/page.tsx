import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { getOperator } from '@/lib/auth/supabaseServer';
import { listActivity } from '@/lib/dashboard/inbox/store';
import { ActivityLog } from '@/components/dashboard/inbox/ActivityLog';

// Always fresh — show the latest state changes on every load.
export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const [res] = await Promise.all([listActivity(), getOperator()]);

  return (
    <OperatorShell active="inbox">
      <div className="max-w-4xl mx-auto w-full">
        <header className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <Link href="/inbox" className="text-sm" style={{ color: 'var(--brand-evergreen-3)' }}>
              ← Back to Inbox
            </Link>
          </div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--op-text)' }}>
            Activity / Audit log
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-2)' }}>
            Every state change — reverse one if it was marked wrong.
          </p>
        </header>

        {res.ok ? (
          <ActivityLog initialRows={res.rows} />
        ) : (
          <div
            className="rounded-md border p-4 text-sm"
            style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Activity log isn&apos;t available yet — the dashboard tables haven&apos;t been provisioned. Apply{' '}
            <code>migrations/2026-06-28-dashboard-tables.sql</code> and set the service-role key.
            <br />
            <span style={{ opacity: 0.7 }}>Details: {res.error}</span>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
