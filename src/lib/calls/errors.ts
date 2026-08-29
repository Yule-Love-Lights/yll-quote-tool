// Small shared helper for the calls routes (calls_merge_plan_2026-08.md
// slice S2): this PR does NOT apply its migration to any database (see
// migrations/2026-08-29-call-ingest.sql's header), so every route that
// touches call_recordings/call_transcripts/recording_sync_state must
// degrade gracefully -- a friendly "not migrated yet" response, never a
// bare 500 -- until Naldo applies it. Postgres' relation-does-not-exist
// code is stable across Supabase/PostgREST error shapes; no repo-wide
// helper for this existed to reuse (checked src/lib/supabase.ts).
export function isMissingTableError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P01';
}
