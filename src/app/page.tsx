import {
  listQuotesForDashboard,
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
} from '@/lib/dashboard/serviceMetrics';
import { buildNeedsAction } from '@/lib/dashboard/needsAction';
import { OperatorShell } from '@/components/OperatorShell';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { WorkflowBoard } from '@/components/dashboard/WorkflowBoard';
import { Worklist } from '@/components/dashboard/Worklist';
import { NeedsActionCard } from '@/components/dashboard/NeedsActionCard';
import { ServiceSections } from '@/components/dashboard/ServiceSections';
import { listItemsForMetrics, getReopenCounts } from '@/lib/dashboard/inbox/store';
import { computeResponseAnalytics } from '@/lib/dashboard/inbox/responseMetrics';
import { ResponseAnalytics } from '@/components/dashboard/inbox/ResponseAnalytics';

// Always render fresh — the dashboard reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const now = new Date();
  const [quotes, jobs, invoices, metricsRes, reopen] = await Promise.all([
    listQuotesForDashboard(500),
    listJobsForWorkflowBoard(),
    listInvoicesForWorkflowBoard(),
    listItemsForMetrics(),
    getReopenCounts(now),
  ]);
  const analytics = metricsRes.ok ? computeResponseAnalytics(metricsRes.items, reopen, now, metricsRes.truncated) : null;
  const kpis = computeKpis(quotes, now);
  const worklist = computeWorklist(quotes, now);
  const workflowBoard = computeWorkflowBoard(quotes, jobs, invoices);
  const holiday = computeHolidayBreakdown(quotes);
  const permanent = computePermanentSummary(quotes);
  const event = computeEventSummary(quotes);

  // Needs-Action queue: parallel-fetches jobs + invoices (quotes already loaded above).
  const needsActionData = await loadNeedsActionData(quotes);
  const needsActionItems = buildNeedsAction({ nowMs: now.getTime(), ...needsActionData });

  return (
    <OperatorShell active="home">
      <div className="max-w-6xl mx-auto w-full">
        <DashboardHeader />
        <KpiStrip kpis={kpis} />
        <NeedsActionCard items={needsActionItems} />
        <WorkflowBoard board={workflowBoard} />
        <Worklist items={worklist} />
        <ServiceSections holiday={holiday} permanent={permanent} event={event} />
        {analytics && <ResponseAnalytics data={analytics} />}
      </div>
    </OperatorShell>
  );
}
