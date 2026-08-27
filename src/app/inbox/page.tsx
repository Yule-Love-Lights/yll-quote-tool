import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { getOperator } from '@/lib/auth/supabaseServer';
import {
  getOperatorLabels,
  getReopenCounts,
  listDueFollowUps,
  listGmailWritebackFailures,
  listInWorks,
  listItemsForMetrics,
  listOpenItems,
  listPendingColorRequests,
} from '@/lib/dashboard/inbox/store';
import { getFollowUpDays } from '@/lib/dashboard/inbox/settings';
import { computeResponseAnalytics, withOperatorLabels } from '@/lib/dashboard/inbox/responseMetrics';
import { InboxList } from '@/components/dashboard/inbox/InboxList';
import { GmailWritebackFailuresBanner } from '@/components/dashboard/inbox/GmailWritebackFailuresBanner';
import { InWorksSection } from '@/components/dashboard/inbox/InWorksSection';
import { PendingColorRequestsSection } from '@/components/dashboard/inbox/PendingColorRequestsSection';
import { ResponseAnalytics } from '@/components/dashboard/inbox/ResponseAnalytics';

// Always fresh — the inbox reflects live unanswered messages on every load; the
// client list then revalidates every ~25s.
export const dynamic = 'force-dynamic';

// #185: zero-behavior-change timing wrapper — records how long `fn` took under
// `label` so a slow load is diagnosable straight from the Vercel server log,
// no repro needed. One summary line per request (below) rather than 8 separate
// log lines, so it stays greppable ("[inbox-timing]").
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number; value: T }> {
  const start = Date.now();
  const value = await fn();
  return { label, ms: Date.now() - start, value };
}

export default async function InboxPage() {
  const now = new Date();
  // Both timing measurements (the outer total + each of the 8 branches) go
  // through `timed()` rather than a bare Date.now() here — a Server Component's
  // render body must stay pure per react-hooks/purity (the eslint gate), and
  // `timed()` is a plain helper so its internal Date.now() calls aren't
  // "during render" as far as that rule is concerned.
  const { ms: totalMs, value: results } = await timed('total', () =>
    Promise.all([
      timed('listOpenItems', () => listOpenItems()),
      timed('listDueFollowUps', () => listDueFollowUps(now)),
      timed('listItemsForMetrics', () => listItemsForMetrics()),
      timed('getOperator', () => getOperator()),
      timed('listInWorks', () => listInWorks(200, now)),
      timed('getFollowUpDays', () => getFollowUpDays()),
      timed('getReopenCounts', () => getReopenCounts(now)),
      timed('getOperatorLabels', () => getOperatorLabels()),
      timed('listPendingColorRequests', () => listPendingColorRequests()),
      timed('listGmailWritebackFailures', () => listGmailWritebackFailures()),
    ]),
  );
  const [openR, dueR, metricsR, operatorR, inWorksR, daysR, reopenR, repLabelsR, colorRequestsR, gmailFailR] = results;
  const openRes = openR.value;
  // Row 430: read ONLY for the exact due count shown beside "Awaiting their
  // reply". The uncapped `totalDue` is the same number the morning digest
  // prints, and it is deliberately the count rather than the rows: the pills
  // themselves come from listInWorks' own capped fetch, so this line stays
  // true even if that cap ever hides a row.
  const dueRes = dueR.value;
  const metricsRes = metricsR.value;
  const operator = operatorR.value;
  const inWorksRes = inWorksR.value;
  const days = daysR.value;
  const reopen = reopenR.value;
  const repLabels = repLabelsR.value;
  const colorRequestsRes = colorRequestsR.value;
  const gmailFailRes = gmailFailR.value;

  console.log(
    `[inbox-timing] total=${totalMs}ms ` + results.map((r) => `${r.label}=${r.ms}ms`).join(' '),
  );

  return (
    <OperatorShell active="inbox">
      <div className="max-w-4xl mx-auto w-full">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--op-text)' }}>
            Inbox
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-2)' }}>
            Every unanswered customer message across channels — these are yours to answer.
            Reply from your phone or GHL, then mark it Handled — or it auto-clears when you
            reply. (Conversations you’ve already followed up on — where you’re waiting on
            THEM — live further down, under “In the works → Awaiting their reply.”)
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

        {/* Row 342: runHandledWriteback's Gmail branch is best-effort (sync.ts) —
            a dead token fails silently unless something reads what it already
            persists into handled_channel_sync. Mirrors the send route's
            eventDateSyncError pattern (a visible failure indicator, not a
            silent swallow) but as a standing banner rather than a one-shot
            toast, because the Handled item that failed to sync has already
            left this page's open list by the time anyone would see a toast.
            Fix round: a query failure gets its OWN visibly-distinct state
            (grey, "couldn't check") rather than being read as a confident
            "0 failures" — the exact silent-monitor bug this row exists to
            fix, reproduced inside round 1 and caught by the staff lens. */}
        {!gmailFailRes.ok && (
          <div
            className="rounded-md border p-3 text-sm mb-4"
            style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Couldn&apos;t check Gmail write-back status ({gmailFailRes.error}) — this does NOT mean nothing
            failed, only that this check didn&apos;t run. Try reloading; tell Jason or Naldo if it keeps
            happening.
          </div>
        )}
        {gmailFailRes.ok && gmailFailRes.items.length > 0 && (
          <GmailWritebackFailuresBanner
            items={gmailFailRes.items}
            total={gmailFailRes.total}
            failedCount={gmailFailRes.failedCount}
            unconfiguredCount={gmailFailRes.unconfiguredCount}
            truncated={gmailFailRes.truncated}
          />
        )}

        {/* Row 321: rendered independent of every inbox_items row's status —
            see listPendingColorRequests' own doc for why this can never be
            hidden the way the old inbox-item-only view could. */}
        {colorRequestsRes.ok && colorRequestsRes.items.length > 0 && (
          <PendingColorRequestsSection items={colorRequestsRes.items} nowMs={now.getTime()} />
        )}

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
            evidenceIncomplete={inWorksRes.evidenceIncomplete}
            followUpsDue={dueRes.ok ? dueRes.totalDue : null}
          />
        )}

        {metricsRes.ok && (
          <ResponseAnalytics
            data={withOperatorLabels(
              computeResponseAnalytics(metricsRes.items, reopen, now, metricsRes.truncated),
              repLabels,
            )}
          />
        )}
      </div>
    </OperatorShell>
  );
}
