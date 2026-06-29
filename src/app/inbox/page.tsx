import { OperatorShell } from '@/components/OperatorShell';
import { listOpenItems } from '@/lib/dashboard/inbox/store';
import { InboxList } from '@/components/dashboard/inbox/InboxList';

// Always fresh — the inbox reflects live unanswered messages on every load; the
// client list then revalidates every ~25s.
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const res = await listOpenItems();

  return (
    <OperatorShell active="inbox">
      <div className="max-w-4xl mx-auto w-full">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--op-text)' }}>
            Inbox
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-2)' }}>
            Every unanswered customer message across channels. Reply from your phone or GHL, then
            mark it Handled — or it auto-clears when you reply.
          </p>
        </header>

        {res.ok ? (
          <InboxList initialItems={res.items} nowMs={new Date().getTime()} />
        ) : (
          <div
            className="rounded-md border p-4 text-sm"
            style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Inbox isn’t available yet — the dashboard tables haven’t been provisioned. Apply{' '}
            <code>migrations/2026-06-28-dashboard-tables.sql</code> and set the service-role key.
            <br />
            <span style={{ opacity: 0.7 }}>Details: {res.error}</span>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
