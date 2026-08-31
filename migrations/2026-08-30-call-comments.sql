-- Post-call HighLevel internal comment (Naldo's ask, 2026-08-30): on top of
-- the note migrations/2026-08-29-call-notes.sql already posts to a
-- contact's Notes tab, this adds one column tracking whether the SAME call
-- also got an InternalComment posted into that contact's conversation
-- thread. Two different HighLevel surfaces, one shared source call.
--
-- Additive, nullable, on the safe-apply allowlist (AGENTS.md "Migration
-- application default"): no backfill needed, every existing row simply
-- reads as "no comment posted yet", which is true.
--
-- Deliberately NO ghl_comment_id / ghl_comment_attempts / quarantine
-- machinery like the note has. The comment is best-effort and fires only
-- once, in the same code path that just succeeded at posting the note (see
-- src/lib/calls/postNotes.ts) -- it never gets its own retry loop, so it
-- needs no CAS token of its own. A failed comment is logged and left
-- failed; the note is still the durable record.

alter table public.call_transcripts
  add column if not exists ghl_comment_posted_at timestamptz;
