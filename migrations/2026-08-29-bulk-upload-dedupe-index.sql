-- =====================================================================
-- One accepted photo per (worker, campaign, photo hash) — the DB-level
-- backstop for admin bulk upload (PR #1093, delta-verify HIGH).
--
-- The application checks for an existing accepted row before inserting,
-- but a check-then-insert can lose a race (two admin tabs uploading the
-- same camera roll), and every sibling mutator in that file uses a CAS
-- while this path could not. This index is the authority that cannot be
-- raced: a second accepted row for the same photo is refused by Postgres
-- with 23505, which the data layer reports as a duplicate skip rather
-- than a failure.
--
-- Partial on purpose:
--   * status = 'accepted' only — pending/rejected/resubmitted rows pay
--     nothing, and a worker legitimately resubmitting the same photo
--     after a rejection must stay possible.
--   * photo_hash is not null — a photo whose perceptual hash could not be
--     computed carries no identity to dedupe on, and must still upload.
--
-- HOW TO APPLY: safe/additive per AGENTS.md (a partial unique index that
-- cannot collide with existing data). Verified before applying: zero
-- (worker_id, campaign_id, photo_hash) groups with more than one accepted
-- row exist in production.
-- =====================================================================

create unique index if not exists advertising_placements_accepted_photo_unique
  on public.advertising_placements (worker_id, campaign_id, photo_hash)
  where status = 'accepted' and photo_hash is not null;
