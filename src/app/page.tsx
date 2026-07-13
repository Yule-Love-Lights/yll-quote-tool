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
import { DashboardErrorBanner, CappedCaveat } from '@/components/dashboard/ErrorBanner';

// Always render fresh — the dashboard reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const now = new Date();
  const [quotesResult, jobs, invoices, metricsRes, openRes, reopen, referralMetrics, repLabels] = await Promise.all([
    listQuotesForDashboardResult(500),
    listJobsForWorkflowBoard(),
    listInvoicesForWorkflowBoard(),
    listItemsForMetrics(),
    listOpenItems(),
    getReopenCounts(now),
    loadReferralMetrics(),
    getOperatorLabels(),
  ]);

  // AUDIT FIX (dashboard-insights-error-visibility, WT-38/46): surface a
  // visible banner instead of silently rendering a fully-populated-looking
  // but empty dashboard ($0 KPIs, "all caught up") on a read failure — that
  // used to be indistinguishable from a real quiet day.
  if (!quotesResult.ok) {
    return (
      <OperatorShell active="home">
        <div className="max-w-6xl mx-auto w-full">
          <DashboardHeader />
          <DashboardErrorBanner title="Couldn't load the dashboard." error={quotesResult.error} />
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
        {quotesResult.capped && <CappedCaveat limit={quotesResult.limit} />}
        <KpiStrip kpis={kpis} />
        {/* Early-stage worklist (drafts / unsent) above the late-stage
            Needs-Action money queue (overdue follow-ups / deposits / balances). */}
        <Worklist items={worklist} />
        <WorkflowBoard board={workflowBoard} />
        <NeedsActionCard items={needsActionItems} />
        <ServiceSections holiday={holiday} permanent={permanent} event={event} bistro={bistro} />
        <div className="mb-8">
          <ReferralMetricsCard data={referralMetrics} />
        </div>
        {analytics && <ResponseAnalytics data={analytics} />}
      </div>
    </OperatorShell>
  );
}
