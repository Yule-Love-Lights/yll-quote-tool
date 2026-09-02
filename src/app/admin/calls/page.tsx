// /admin/calls — visibility into the calls-ingest pipeline
// (calls_merge_plan_2026-08.md slice S2): sync state, counts by status, and
// the last 50 recordings, plus a "Process next batch" button. A debug/admin
// surface, not a coaching UI (that's S3+). Operator-gated the same way as
// every other /admin page (the proxy perimeter denies it by default; this
// route is intentionally NOT in operatorGate.ts's public allowlist).

import { OperatorShell } from '@/components/OperatorShell';
import { CallsView } from '@/components/admin/CallsView';

export const dynamic = 'force-dynamic';

export default function AdminCallsPage() {
  return (
    <OperatorShell active="calls">
      <main className="max-w-3xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Call recordings</h1>
          <p className="text-sm text-gray-500 mt-1">
            HighLevel call transcripts feeding the calls pipeline (calls_merge_plan_2026-08.md, slice S2).
          </p>
        </div>
        <CallsView />
      </main>
    </OperatorShell>
  );
}
