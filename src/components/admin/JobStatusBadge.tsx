import type { JobStatus } from '@/lib/jobStatus';

// Display labels + badge styles for the BILLING job status (ledger #83). Shared by
// the /admin/jobs list + detail so the two never drift. (The /inventory Kanban
// shows the separate fulfillment_stage, not this axis.)
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  to_schedule: 'To schedule',
  scheduled: 'Scheduled',
  installed: 'Installed',
  requires_invoicing: 'Requires invoicing',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STYLES: Record<JobStatus, string> = {
  to_schedule: 'bg-amber-100 text-amber-700',
  scheduled: 'bg-blue-100 text-blue-700',
  installed: 'bg-purple-100 text-purple-700',
  requires_invoicing: 'bg-orange-100 text-orange-700',
  done: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${STYLES[status]}`}
    >
      {JOB_STATUS_LABELS[status]}
    </span>
  );
}
