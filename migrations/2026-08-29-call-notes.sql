-- =====================================================================
-- Post-call HighLevel notes (Naldo's ask, 2026-08-29): after a call is
-- transcribed and its commitments are extracted, an internal note lands on
-- that customer's HighLevel contact carrying a summary of the call and the
-- tasks that came out of it, so reps stop hand-writing call notes.
--
-- Everything here is ADDITIVE and nullable-or-defaulted on the existing
-- call_transcripts table, which is exactly the shape AGENTS.md's migration
-- allowlist names as safe to apply directly.
--
-- DELIBERATELY NO CHECK CONSTRAINTS. The sibling commitment-extraction
-- columns in migrations/2026-08-29-call-ingest.sql carry marker-consistency
-- checks, and the same checks would be welcome here -- but adding a CHECK
-- constraint to an already-populated table is NOT on that allowlist, so it
-- would need Naldo's explicit go. The same invariants are enforced in code
-- (src/lib/calls/postNotes.ts) and pinned by its tests instead. If the
-- constraints are wanted later they are a one-line follow-up migration.
--
-- THE IDEMPOTENCY GUARANTEE lives in the claim: ghl_note_attempts doubles
-- as the compare-and-swap token (see claimNoteRow in postNotes.ts), so two
-- concurrent workers can never both post a note for the same call, and a
-- crashed worker's claim is only retried after CALL_NOTE_CLAIM_STALE_MS.
-- =====================================================================

-- The generated call summary. Stored on the row so it is produced once per
-- call and a note retry never re-bills an LLM call.
alter table public.call_transcripts
  add column if not exists summary               text,
  add column if not exists summary_model         text,
  add column if not exists summary_generated_at  timestamptz;

-- Note-posting state.
--   ghl_note_posted_at    set ONLY after HighLevel returns success.
--   ghl_note_id           the note id HighLevel returned, for tracing.
--   ghl_note_claimed_at   in-flight marker; a claim older than the stale
--                         window is reclaimable, which is how a crashed
--                         worker's call gets retried.
--   ghl_note_attempts     claim counter AND compare-and-swap token.
--   ghl_note_skip_reason  permanent, non-failure exclusion ('is_test',
--                         'no_contact_id'). Takes the row out of the queue.
--   ghl_note_quarantined_at  set after CALL_NOTE_MAX_ATTEMPTS failures, so
--                         one poisoned call cannot block the batch forever.
alter table public.call_transcripts
  add column if not exists ghl_note_posted_at         timestamptz,
  add column if not exists ghl_note_id                text,
  add column if not exists ghl_note_claimed_at        timestamptz,
  add column if not exists ghl_note_attempts          integer not null default 0,
  add column if not exists ghl_note_last_attempt_at   timestamptz,
  add column if not exists ghl_note_last_failure_code text,
  add column if not exists ghl_note_skip_reason       text,
  add column if not exists ghl_note_quarantined_at    timestamptz;

-- The candidate query's index: rows still owed a note. Partial, so it stays
-- small as posted rows accumulate. Mirrors the partial pending-extraction
-- index in migrations/2026-08-29-call-ingest.sql.
create index if not exists call_transcripts_note_pending_idx
  on public.call_transcripts (called_at)
  where ghl_note_posted_at is null
    and ghl_note_skip_reason is null
    and ghl_note_quarantined_at is null;
