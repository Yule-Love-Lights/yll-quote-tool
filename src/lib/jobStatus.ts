// Canonical job lifecycle status model (ledger #83, Phase 2).
//
// The BILLING axis of a job (SPEC §3): a job is auto-created at `to_schedule`
// when a quote is booked, moves through install, and ends `done`. (`cancelled`
// is a terminal off-ramp.) This is a DIFFERENT axis from #82's
// `fulfillment_stage` materials Kanban — that one is owned by the Inventory epic
// and lives in its own column. Keep the two independent.
//
// Pure module (no Supabase) so both the data layer and any UI can import it.

export type JobStatus =
  | 'to_schedule'
  | 'scheduled'
  | 'installed'
  | 'requires_invoicing'
  | 'done'
  | 'cancelled';

/** The canonical set, in lifecycle order (cancelled last as the off-ramp). */
export const JOB_STATUSES: readonly JobStatus[] = [
  'to_schedule',
  'scheduled',
  'installed',
  'requires_invoicing',
  'done',
  'cancelled',
] as const;

// Legal forward transitions. A job advances through the billing lifecycle and
// can be cancelled from any non-terminal state. `done` and `cancelled` are
// terminal. Kept deliberately small — the engine guards writes against this so
// a typo or out-of-order UI action can't put a job in an impossible state.
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  to_schedule: ['scheduled', 'installed', 'cancelled'],
  scheduled: ['installed', 'cancelled'],
  installed: ['requires_invoicing', 'cancelled'],
  requires_invoicing: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

/** Whether `to` is a legal next status from `from`. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Narrow an unknown value to a JobStatus, or null if it isn't one. */
export function asJobStatus(v: unknown): JobStatus | null {
  return typeof v === 'string' && (JOB_STATUSES as readonly string[]).includes(v)
    ? (v as JobStatus)
    : null;
}
