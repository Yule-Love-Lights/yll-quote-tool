import type { WorkflowBoard as WorkflowBoardData } from '@/lib/dashboard/workflowBoard';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function StatusLine({ label, count, totalUsd }: { label: string; count: number; totalUsd: number }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span style={{ color: 'var(--op-text-dim)' }}>{label}</span>
      <span className="tabular-nums" style={{ color: 'var(--op-text)' }}>
        {count}
        {totalUsd > 0 ? ` · ${fmtMoney(totalUsd)}` : ''}
      </span>
    </div>
  );
}

function StageCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{
        background: 'var(--op-bg-raised)',
        borderColor: 'var(--op-border)',
        borderTop: `3px solid ${accent}`,
      }}
    >
      <div className="text-sm font-semibold mb-2" style={{ color: 'var(--op-text)' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

/** The Jobber-style pipeline board (ledger #83). Quotes + Jobs stages are live
 *  from real data; Invoices arrives in #83 Phase 3. */
export function WorkflowBoard({ board }: { board: WorkflowBoardData }) {
  const q = board.quotes;
  const j = board.jobs;
  // "Active" = jobs still in flight (everything before done/cancelled). The
  // headline count + its value, mirroring the Quotes column's "booked" headline.
  const activeJobsCount =
    j.to_schedule.count + j.scheduled.count + j.installed.count + j.requires_invoicing.count;
  const activeJobsUsd =
    j.to_schedule.totalUsd + j.scheduled.totalUsd + j.installed.totalUsd + j.requires_invoicing.totalUsd;
  return (
    <section aria-label="Workflow pipeline" className="mb-8">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        Workflow
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StageCard title="Quotes" accent="#D4537E">
          <div className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {q.booked.count}{' '}
            <span className="text-xs font-normal" style={{ color: 'var(--op-text-dim)' }}>
              booked · {fmtMoney(q.booked.totalUsd)}
            </span>
          </div>
          <div className="mt-3 pt-2 border-t" style={{ borderColor: 'var(--op-border)' }}>
            <StatusLine label="Draft" count={q.draft.count} totalUsd={q.draft.totalUsd} />
            <StatusLine label="Awaiting response" count={q.awaitingResponse.count} totalUsd={q.awaitingResponse.totalUsd} />
            <StatusLine label="Approved · awaiting deposit" count={q.approved.count} totalUsd={q.approved.totalUsd} />
            <StatusLine label="Booked · deposit paid" count={q.booked.count} totalUsd={q.booked.totalUsd} />
          </div>
        </StageCard>

        <StageCard title="Jobs" accent="#639922">
          <div className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {activeJobsCount}{' '}
            <span className="text-xs font-normal" style={{ color: 'var(--op-text-dim)' }}>
              active{activeJobsUsd > 0 ? ` · ${fmtMoney(activeJobsUsd)}` : ''}
            </span>
          </div>
          <div className="mt-3 pt-2 border-t" style={{ borderColor: 'var(--op-border)' }}>
            <StatusLine label="To schedule" count={j.to_schedule.count} totalUsd={j.to_schedule.totalUsd} />
            <StatusLine label="Scheduled" count={j.scheduled.count} totalUsd={j.scheduled.totalUsd} />
            <StatusLine label="Installed" count={j.installed.count} totalUsd={j.installed.totalUsd} />
            <StatusLine label="Requires invoicing" count={j.requires_invoicing.count} totalUsd={j.requires_invoicing.totalUsd} />
            <StatusLine label="Done" count={j.done.count} totalUsd={j.done.totalUsd} />
          </div>
          <div className="mt-2 text-xs" style={{ color: 'var(--op-text-dim)' }}>
            Auto-created when a deposit is paid. Scheduling runs in home.works.
          </div>
        </StageCard>

        <StageCard title="Invoices" accent="#378ADD">
          <div className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
            Coming in Phase 3 — the 50% balance is collected via Valor after install.
          </div>
        </StageCard>
      </div>
    </section>
  );
}
