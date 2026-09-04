-- What backed a follow-up stamp (ledger row 502, Naldo 2026-09-03).
--
-- A "Followed" stamp with nothing recorded behind it cannot be told apart from
-- a mis-click. Found on a forwarded lead that escalated twice and was then
-- stamped by hand on 2026-08-26 with no outbound call or message anywhere in
-- the system for that person. Both readings are plausible (the staffer rang
-- from a personal phone, which the tool never sees; or the row was stamped
-- without contact) and today nothing distinguishes them.
--
-- The activity log already tells a call-driven stamp apart from a manual one,
-- because PR #1170's automatic sweep passes `via: 'call'`. That signal lives in
-- dashboard_activity, so it is invisible to the inbox LIST, which reads
-- inbox_items. This column puts it where the row can render it.
--
-- Deliberately NOT backfilled. An existing row is null, meaning "we do not
-- know", and the UI shows nothing for null rather than claiming a stamp was
-- unbacked when the column simply did not exist when it was written. Guessing
-- historical values from call_recordings would mean matching at contact level,
-- which is exactly the substitution ledger row 501 records as unsound.
--
-- Nullable add-column on a populated table: safe/additive per AGENTS.md.

alter table inbox_items
  add column if not exists followed_via text;

comment on column inbox_items.followed_via is
  'What backed the follow-up stamp in followed_up_at: call (an outbound call the phone system recorded), reply (a message this tool sent), or manual (a person asserted it, nothing recorded backs it). Null means the stamp predates this column. Written by markItemFollowed; see followBacking.ts for how it becomes words.';
