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

/** The Jobber-style pipeline board (ledger #82). Phase-1 slice: the Quotes
 *  stage is live from real data; Jobs + Invoices arrive in #82 Phase 2/3. */
export function WorkflowBoard({ board }: { board: WorkflowBoardData }) {
  const q = board.quotes;
  return (
    <section aria-label="Workflow pipeline" className="mb-8">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        Workflow
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StageCard title="Quotes" accent="#D4537E">
          <div className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {q.approved.count}{' '}
            <span className="text-xs font-normal" style={{ color: 'var(--op-text-dim)' }}>
              approved · {fmtMoney(q.approved.totalUsd)}
            </span>
          </div>
          <div className="mt-3 pt-2 border-t" style={{ borderColor: 'var(--op-border)' }}>
            <StatusLine label="Draft" count={q.draft.count} totalUsd={q.draft.totalUsd} />
            <StatusLine label="Awaiting response" count={q.awaitingResponse.count} totalUsd={q.awaitingResponse.totalUsd} />
            <StatusLine label="Approved" count={q.approved.count} totalUsd={q.approved.totalUsd} />
          </div>
        </StageCard>

        <StageCard title="Jobs" accent="#639922">
          <div className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
            Coming in Phase 2 — a job is auto-created when a deposit is paid. Scheduling runs in home.works.
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
