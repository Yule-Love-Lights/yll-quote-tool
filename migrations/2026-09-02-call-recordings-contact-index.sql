-- The inbox call follow-up sweep (sweepCallFollowUps, src/lib/dashboard/inbox/store.ts)
-- filters call_recordings by ghl_contact_id on every reconcile tick, roughly every
-- five minutes, forever. That column had no index, and the table is fed continuously
-- by the calls-sync cron, so the scan gets steadily more expensive as it grows.
-- Raised by the pre-merge admin lens.
--
-- Additive and non-destructive: creates an index, touches no data.
create index if not exists call_recordings_ghl_contact_id_idx
  on public.call_recordings (ghl_contact_id);
