-- =====================================================================
-- The bulk-upload dedupe index must ignore VOIDED rows (S81 close
-- integration lens, HIGH).
--
-- Two features shipped a day apart and never met. The dedupe index
-- (2026-08-29-bulk-upload-dedupe-index.sql) refuses a second ACCEPTED row
-- for the same worker, campaign and photo hash. Void
-- (2026-08-29-placement-void.sql) is an OVERLAY: it stamps voided_at and
-- leaves status = 'accepted' forever, precisely so the history survives.
--
-- Together they trap the office. Void a wrongly-accepted photo, then try
-- to do the work again and the voided row still satisfies the index:
--   * the worker path fails with a 409 saying the photo is already
--     accepted, which is false, it is voided and pays nothing;
--   * the bulk path is worse, reporting a calm "already uploaded,
--     skipped" 200 and creating nothing, so staff believe a paying row
--     covers work that pays zero.
-- The void migration's own remedy for a wrongly voided sign is to
-- resubmit it, which is exactly what this index was preventing.
--
-- The narrowed predicate keeps the guard for LIVE accepted rows and lets
-- a voided one be redone.
--
-- HOW TO APPLY: safe/additive per AGENTS.md. The new predicate is a
-- strict SUBSET of the old one, so it cannot collide with any data the
-- old index already permitted. Verified before applying: zero
-- (worker_id, campaign_id, photo_hash) groups hold more than one live
-- accepted row.
-- =====================================================================

drop index if exists advertising_placements_accepted_photo_unique;

create unique index if not exists advertising_placements_accepted_photo_unique
  on public.advertising_placements (worker_id, campaign_id, photo_hash)
  where status = 'accepted' and voided_at is null and photo_hash is not null;
