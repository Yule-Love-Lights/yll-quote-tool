-- The crew door, delta-verify round on PR #1094.
--
-- The first fix bound a crew session to the crew member's telegram_user_id and
-- the PR claimed that unlinking and relinking was a per-person "sign out
-- everywhere". That claim was FALSE for the realistic case: the office's
-- remediation for a leaked link is to unlink and relink the SAME Telegram
-- account, which restores the same id, so the leaked session's binding matched
-- again and the stolen cookie came back to life for the rest of its 30 days.
--
-- `session_epoch` is a value whose only job is to CHANGE. Sessions are bound to
-- it, and it is rotated whenever the office does anything that should end a
-- crew member's sessions: linking or unlinking Telegram, deactivating them, or
-- pressing Sign out everywhere. Rotating it invalidates every session issued
-- before, for that one person, and touches nobody else.

alter table public.crew_members
  add column if not exists session_epoch text;
