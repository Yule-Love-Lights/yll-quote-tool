// Small shared helper for the commitments module (calls_merge_plan_2026-08.md
// slice S6): this PR does NOT apply its migration to any database (see
// migrations/2026-08-29-call-commitments.sql's header), so every caller that
// touches call_commitments or the two extraction RPCs must degrade
// gracefully -- a friendly "not migrated yet" response, never a bare 500 --
// until Naldo applies it. Mirrors src/lib/officeTasks.ts's
// isOfficeTasksSchemaUnavailable (same four codes: 42P01/PGRST205 for a
// missing table/column, 42883/PGRST202 for a missing function) rather than
// src/lib/calls/errors.ts's narrower isMissingTableError, because this
// module's failure mode includes missing FUNCTIONS, not just missing tables.

export function commitmentsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isCommitmentsSchemaUnavailable(error: unknown): boolean {
  const code = commitmentsErrorCode(error);
  return code === '42P01' || code === 'PGRST205' || code === '42883' || code === 'PGRST202';
}
