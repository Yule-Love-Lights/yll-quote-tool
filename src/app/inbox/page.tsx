import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { getOperator } from '@/lib/auth/supabaseServer';
import { getReopenCounts, listDueFollowUps, listInWorks, listItemsForMetrics, listOpenItems } from '@/lib/dashboard/inbox/store';
import { getFollowUpDays } from '@/lib/dashboard/inbox/settings';
import { computeResponseAnalytics } from '@/lib/dashboard/inbox/responseMetrics';
import { InboxList } from '@/components/dashboard/inbox/InboxList';
import { FollowUpStrip } from '@/components/dashboard/inbox/FollowUpStrip';
import { InWorksSection } from '@/components/dashboard/inbox/InWorksSection';
import { ResponseAnalytics } from '@/components/dashboard/inbox/ResponseAnalytics';

// Always fresh — the inbox reflects live unanswered messages on every load; the
// client list then revalidates every ~25s.
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const now = new Date();
  const [openRes, followRes, metricsRes, operator, inWorksRes, days, reopen] = await Promise.all([
    listOpenItems(),
    listDueFollowUps(now),
    listItemsForMetrics(),
    getOperator(),
    listInWorks(),
    getFollowUpDays(),
    getReopenCounts(now),
  ]);

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
          <div className="flex gap-4 mt-2">
            <Link href="/inbox/duplicates" className="text-sm inline-block" style={{ color: 'var(--brand-evergreen-3)' }}>
              Manage duplicate contacts →
            </Link>
            <Link href="/inbox/activity" className="text-sm inline-block" style={{ color: 'var(--brand-evergreen-3)' }}>
              Activity log →
            </Link>
          </div>
        </header>

        {followRes.ok && followRes.items.length > 0 && <FollowUpStrip initialItems={followRes.items} />}

        {/* WT-41: above the 100-item page cap, the oldest items are what's shown
            (by design — they're the longest-waiting) but the newest customer
            messages are excluded from the list below until the queue drains.
            Say so explicitly rather than let the "Open leads" count look final. */}
        {openRes.ok && openRes.truncated && (
          <div
            className="rounded-md border p-3 text-sm mb-4"
            style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Showing the oldest {openRes.items.length} of {openRes.totalOpen} open items —{' '}
            {openRes.totalOpen - openRes.items.length} more not shown yet.
          </div>
        )}

        {openRes.ok ? (
          <InboxList initialItems={openRes.items} nowMs={now.getTime()} currentOperatorId={operator?.id ?? null} />
        ) : (
          <div
            className="rounded-md border p-4 text-sm"
            style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Inbox isn’t available yet — the dashboard tables haven’t been provisioned. Apply{' '}
            <code>migrations/2026-06-28-dashboard-tables.sql</code> and set the service-role key.
            <br />
            <span style={{ opacity: 0.7 }}>Details: {openRes.error}</span>
          </div>
        )}

        {inWorksRes.ok && (inWorksRes.awaiting.length > 0 || inWorksRes.handled.length > 0) && (
          <InWorksSection
            awaiting={inWorksRes.awaiting}
            handled={inWorksRes.handled}
            followUpDays={days}
            nowMs={now.getTime()}
          />
        )}

        {metricsRes.ok && (
          <ResponseAnalytics data={computeResponseAnalytics(metricsRes.items, reopen, now, metricsRes.truncated)} />
        )}
      </div>
    </OperatorShell>
  );
}
