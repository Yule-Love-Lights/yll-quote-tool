import {
  listQuotesForDashboardResult,
  listJobsForWorkflowBoard,
  listInvoicesForWorkflowBoard,
  loadNeedsActionData,
} from '@/lib/dashboard/queries';
import { computeKpis } from '@/lib/dashboard/metrics';
import { computeWorklist } from '@/lib/dashboard/worklist';
import { computeWorkflowBoard } from '@/lib/dashboard/workflowBoard';
import {
  computeHolidayBreakdown,
  computePermanentSummary,
  computeEventSummary,
  computeBistroSummary,
} from '@/lib/dashboard/serviceMetrics';
import { buildNeedsAction } from '@/lib/dashboard/needsAction';
import { OperatorShell } from '@/components/OperatorShell';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { WorkflowBoard } from '@/components/dashboard/WorkflowBoard';
import { Worklist } from '@/components/dashboard/Worklist';
import { NeedsActionCard } from '@/components/dashboard/NeedsActionCard';
import { ServiceSections } from '@/components/dashboard/ServiceSections';
import { listItemsForMetrics, listOpenItems, getReopenCounts, getOperatorLabels } from '@/lib/dashboard/inbox/store';
import { computeResponseAnalytics, withOperatorLabels } from '@/lib/dashboard/inbox/responseMetrics';
import { buildInboxSummary } from '@/lib/dashboard/inbox/summary';
import { ResponseAnalytics } from '@/components/dashboard/inbox/ResponseAnalytics';
import { loadReferralMetrics } from '@/lib/dashboard/referralMetrics';
import { ReferralMetricsCard } from '@/components/dashboard/ReferralMetricsCard';
import { loadSelfServeMetrics } from '@/lib/dashboard/selfServeMetrics';
import { SelfServeMetricsCard } from '@/components/dashboard/SelfServeMetricsCard';
import OfficeTasksCard from '@/components/dashboard/OfficeTasksCard';

// Always render fresh — the dashboard reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const now = new Date();
  const [quotesResult, jobs, invoices, metricsRes, openRes, reopen, referralMetrics, repLabels, selfServeMetrics] = await Promise.all([
    listQuotesForDashboardResult(500),
    listJobsForWorkflowBoard(),
    listInvoicesForWorkflowBoard(),
    listItemsForMetrics(),
    listOpenItems(),
    getReopenCounts(now),
    loadReferralMetrics(),
    getOperatorLabels(),
    loadSelfServeMetrics(),
  ]);

  // AUDIT FIX (WT-38/WT-46, dashboard-insights-error-visibility): the old
  // listQuotesForDashboard() swallowed a Supabase read failure into `[]`, so
  // every widget below computed over an empty list and rendered $0 KPIs / an
  // empty pipeline — indistinguishable from a genuinely quiet day. Surface a
  // visible error banner instead, before computing anything over the rows.
  if (!quotesResult.ok) {
    return (
      <OperatorShell active="home">
        <div className="max-w-6xl mx-auto w-full">
          <DashboardHeader />
          <div
            role="alert"
            className="rounded-lg border p-4 text-sm mb-8"
            style={{ borderColor: 'var(--op-danger, #b91c1c)', color: 'var(--op-danger, #b91c1c)', background: 'var(--op-danger-bg, rgba(185,28,28,0.08))' }}
          >
            <p className="font-semibold">Couldn&apos;t load the dashboard.</p>
            <p className="mt-1" style={{ color: 'var(--op-text-dim)' }}>
              The quotes query failed, so KPIs and the pipeline are hidden (rather than showing misleading zeros). Try refreshing; if it persists, check the database connection.
            </p>
            <p className="mt-2 font-mono text-xs" style={{ color: 'var(--op-text-dim)' }}>{quotesResult.error}</p>
          </div>
        </div>
      </OperatorShell>
    );
  }

  const quotes = quotesResult.rows;
  const analytics = metricsRes.ok
    ? withOperatorLabels(computeResponseAnalytics(metricsRes.items, reopen, now, metricsRes.truncated), repLabels)
    : null;
  // PS-E2: Inbox nav badge — same buildInboxSummary(listOpenItems()) pairing
  // /inbox's own InboxList uses for its "Open leads" / "Overdue over 4h" tiles.
  const inboxSummary = openRes.ok ? buildInboxSummary(openRes.items, now.getTime()) : null;
  const kpis = computeKpis(quotes, now);
  const worklist = computeWorklist(quotes, now);
  const workflowBoard = computeWorkflowBoard(quotes, jobs, invoices);
  const holiday = computeHolidayBreakdown(quotes);
  const permanent = computePermanentSummary(quotes);
  const event = computeEventSummary(quotes);
  const bistro = computeBistroSummary(quotes);

  // Needs-Action queue: parallel-fetches jobs + invoices (quotes already loaded above).
  const needsActionData = await loadNeedsActionData(quotes);
  const needsActionItems = buildNeedsAction({ nowMs: now.getTime(), ...needsActionData });

  return (
    <OperatorShell active="home" inboxOpenLeads={inboxSummary?.openLeads} inboxOverdue={inboxSummary?.overdue}>
      <div className="max-w-6xl mx-auto w-full">
        <DashboardHeader />
        {quotesResult.capped && (
          // WT-47: listQuotesForDashboardResult hit the row cap — lifetime
          // totals below may exclude the oldest quotes.
          <p className="text-xs mb-4" style={{ color: 'var(--op-text-dim)' }}>
            Based on the newest 500 quotes — lifetime totals may not include older quotes.
          </p>
        )}
        <KpiStrip kpis={kpis} />
        {/* Early-stage worklist (drafts / unsent) above the late-stage
            Needs-Action money queue (overdue follow-ups / deposits / balances). */}
        <Worklist items={worklist} />
        <WorkflowBoard board={workflowBoard} />
        <NeedsActionCard items={needsActionItems} />
        <OfficeTasksCard />
        <ServiceSections holiday={holiday} permanent={permanent} event={event} bistro={bistro} />
        <div className="mb-8">
          <ReferralMetricsCard data={referralMetrics} />
        </div>
        <div className="mb-8">
          <SelfServeMetricsCard data={selfServeMetrics} />
        </div>
        {analytics && <ResponseAnalytics data={analytics} />}
      </div>
    </OperatorShell>
  );
}
