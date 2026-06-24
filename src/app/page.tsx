import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { computeKpis } from '@/lib/dashboard/metrics';
import { computeWorklist } from '@/lib/dashboard/worklist';
import { OperatorNav } from '@/components/dashboard/OperatorNav';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { Worklist } from '@/components/dashboard/Worklist';

// Always render fresh — the dashboard reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const quotes = await listQuotesForDashboard(500);
  const now = new Date();
  const kpis = computeKpis(quotes, now);
  const worklist = computeWorklist(quotes, now);

  return (
    <>
      <OperatorNav active="home" />
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
        <DashboardHeader />
        <KpiStrip kpis={kpis} />
        <Worklist items={worklist} />
      </main>
    </>
  );
}
