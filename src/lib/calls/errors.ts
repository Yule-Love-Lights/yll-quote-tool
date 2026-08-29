// Small shared helper for the calls routes (calls_merge_plan_2026-08.md
// slice S2): this PR does NOT apply its migration to any database (see
// migrations/2026-08-29-call-ingest.sql's header), so every route that
// touches call_recordings/call_transcripts/recording_sync_state must
// degrade gracefully -- a friendly "not migrated yet" response, never a
// bare 500 -- until Naldo applies it.
//
// WIDENED (fix round, admin-lens finding): this originally checked ONLY
// Postgres' raw 42P01 (relation does not exist), narrower than the two
// sibling helpers this same branch shipped for S6
// (src/lib/officeTasks.ts's isOfficeTasksSchemaUnavailable,
// src/lib/commitments/errors.ts's isCommitmentsSchemaUnavailable), which
// both also check PGRST205 (PostgREST's own schema-cache-miss code -- what
// a plain `.select()` against a genuinely missing table actually returns
// in practice, per those two files' own comments) and 42883/PGRST202
// (missing function -- relevant here too, since the calls-sync cron also
// calls advance_recording_sync_cursor via RPC). Without this, hitting
// /admin/calls before the migration is applied showed a raw "Could not
// load calls." 500 instead of the intended amber "Run migrations/
// 2026-08-29-call-ingest.sql first." banner.
export function isMissingTableError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205' || code === '42883' || code === 'PGRST202';
}
