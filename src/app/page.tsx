import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { computeKpis } from '@/lib/dashboard/metrics';
import { computeWorklist } from '@/lib/dashboard/worklist';
import { computeWorkflowBoard } from '@/lib/dashboard/workflowBoard';
import {
  computeHolidayBreakdown,
  computePermanentSummary,
  computeEventSummary,
} from '@/lib/dashboard/serviceMetrics';
import { OperatorShell } from '@/components/OperatorShell';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { WorkflowBoard } from '@/components/dashboard/WorkflowBoard';
import { Worklist } from '@/components/dashboard/Worklist';
import { ServiceSections } from '@/components/dashboard/ServiceSections';

// Always render fresh — the dashboard reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const quotes = await listQuotesForDashboard(500);
  const now = new Date();
  const kpis = computeKpis(quotes, now);
  const worklist = computeWorklist(quotes, now);
  const workflowBoard = computeWorkflowBoard(quotes);
  const holiday = computeHolidayBreakdown(quotes);
  const permanent = computePermanentSummary(quotes);
  const event = computeEventSummary(quotes);

  return (
    <OperatorShell active="home">
      <div className="max-w-6xl mx-auto w-full">
        <DashboardHeader />
        <KpiStrip kpis={kpis} />
        <WorkflowBoard board={workflowBoard} />
        <Worklist items={worklist} />
        <ServiceSections holiday={holiday} permanent={permanent} event={event} />
      </div>
    </OperatorShell>
  );
}
