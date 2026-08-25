-- =====================================================================
-- staff_notes redaction — a correction path for append-only notes about
-- named customers (row 372, #874 admin lens MED).
--
-- WHY. staff_notes is permanent, append-only, attributable free text about
-- named customers, enforced right down to the grants (`grant select, insert`
-- only — no update, no delete). That is the right default for an audit
-- timeline, and it left exactly one way to remove a note written in error, or
-- one naming a person who should not be named: delete the entire quote.
--
-- WHAT THIS IS NOT. It is not deletion and it is not a retention policy.
-- Retention is deliberately left unset (Jason's call, 2026-08-25) — notes are
-- kept until someone decides otherwise, and nothing here expires anything.
--
-- WHAT IT IS. A tombstone. The row survives, so the timeline still shows that
-- something was written and later withdrawn — losing that would be its own
-- kind of dishonesty — while the TEXT is replaced and the withdrawal is
-- attributed and timestamped like the note itself was.
--
-- The grant is COLUMN-SCOPED on purpose. Only the body and the four redaction
-- columns become writable; quote_id, created_by, created_by_label, created_at
-- and client_request_id stay as immutable as they are today, so a redaction
-- can never quietly re-attribute or re-date a note, and the idempotency key
-- cannot be reused. Postgres enforces that, not the application.
--
-- HOW TO APPLY. The four column adds are safe/additive per AGENTS.md's
-- migration-application default (nullable, no default, every existing row
-- backfills to NULL = "never redacted", which is the correct historical read).
-- The GRANT is NOT on that allowlist — it widens what the service role may do
-- to a table holding customer data — so this migration waits for the dev's
-- explicit go before it is applied, and is not applied by the assistant on
-- its own authority.
-- =====================================================================

alter table public.staff_notes
  add column if not exists redacted_at timestamptz null,
  add column if not exists redacted_by uuid null references auth.users(id) on delete set null,
  add column if not exists redacted_by_label text null,
  add column if not exists redacted_reason text null;

-- Column-scoped: everything NOT listed here stays unwritable.
grant update (body, redacted_at, redacted_by, redacted_by_label, redacted_reason)
  on public.staff_notes to service_role;

comment on column public.staff_notes.redacted_at is
  'Row 372 (2026-08-25): when this note was withdrawn. Non-null means `body` holds a tombstone, not the original text — the original is gone, by design. Null means an ordinary note.';
comment on column public.staff_notes.redacted_reason is
  'Row 372: why it was withdrawn, in the redactor''s own words. Optional — a redaction is never blocked on explaining itself, since the reason may itself be the sensitive part.';
