-- =====================================================================
-- follow_ups.re_chase_since - marks a re-armed nag so the strip can tell it
-- apart from a first-time one (row 390, S49 #932 staff lens MED).
--
-- WHY. Row 385 lets a HANDLED item's "quote sent, no reply" follow-up re-arm
-- after RECHASE_QUIET_DAYS of silence (followups.ts's mayReChaseHandled).
-- ensureFollowUp (store.ts) already computes this as a local `isReChase`
-- boolean at write time, but the upsert never persisted it — every row in
-- this table looks identical whether it's the FIRST nudge after a quote went
-- out or the SECOND, after staff already replied once and the customer went
-- quiet again. FollowUpStrip.tsx (the "due today" strip) rendered both
-- identically, so staff had no way to tell "we never chased this" from "we
-- chased and they went quiet again" - which changes what you'd actually say
-- to the customer on the call.
--
-- No EXISTING column distinguishes the two cases reliably. due_at comes
-- close (a re-chase stamps due_at = now, per row 385's own "due NOW, not on
-- the original quote's long-past due date" fix) but reconstructing
-- "isReChase" by comparing due_at to updated_at at STRIP-RENDER time would
-- silently drift out of sync with ensureFollowUp's own decision the moment
-- either function's rounding/timing changes - and mayReChaseHandled already
-- has a documented edge case (an item that has been 'handled' for >=7 days
-- with NO prior follow_ups row at all still counts as a re-chase, anchored on
-- handled_at) that a timestamp-comparison heuristic could not safely
-- reverse-engineer. A genuinely new persisted field is the honest fix.
--
-- This column stores the SILENCE-START anchor (the same `lastNudgeAt ??
-- handledAt` mayReChaseHandled/followups.ts's reChaseAnchor already computes
-- to decide eligibility) rather than a plain boolean, so the strip can also
-- show "how long they've been silent" (row 390's own "ideally") for free -
-- non-null means "this is a re-chase, and the silence started here"; null
-- means an ordinary first-time nudge. Reset to null on every upsert that
-- ISN'T a re-chase, so a row's flag can't go stale across a future
-- non-re-chase cycle for the same (item, reason) pair.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default -
-- a nullable column add with no default backfills every existing row to NULL
-- (= "not a re-chase", the correct historical read: nothing before this
-- migration ever recorded a re-chase). No existing row can violate it.
-- =====================================================================

alter table public.follow_ups
  add column if not exists re_chase_since timestamptz null;

comment on column public.follow_ups.re_chase_since is
  'Row 390 (2026-08-25): non-null only when this pending nudge is a RE-CHASE (row 385 re-arm after 7 quiet days on a handled item) - holds the silence-start anchor (followups.ts''s reChaseAnchor: the prior nag''s updated_at, falling back to inbox_items.handled_at) so the strip can label it and show how long the customer has been quiet. Null for an ordinary first-time "quote sent, no reply" nudge.';
