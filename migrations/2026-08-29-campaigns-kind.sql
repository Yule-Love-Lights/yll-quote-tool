-- =====================================================================
-- advertising_campaigns.kind — the Simple Crew replica (Naldo, 2026-08-29)
-- models campaigns AS the thing being placed ("Signs", "Door Hangers"), so
-- the camera has no kind toggle: choosing the campaign chooses the kind.
-- The placement-level kind column stays the money truth (door hangers can
-- never carry a rate, enforced by its CHECKs); this default feeds it at
-- capture time.
--
-- HOW TO APPLY: safe/additive per AGENTS.md (NOT NULL DEFAULT column add;
-- both existing rows are yard-sign campaigns, which the default matches).
-- =====================================================================

alter table public.advertising_campaigns
  add column if not exists kind text not null default 'yard_sign'
    check (kind in ('yard_sign', 'door_hanger'));
