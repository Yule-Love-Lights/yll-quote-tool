-- #68 — customer-viewed-quote read receipt.
-- Records when a customer opens their portal link so staff see a "Viewed" badge
-- in /admin/quotes and (via the new /api/quotes/[id]/view route) get a GHL email
-- on each open. All additive + nullable/defaulted; idempotent — safe to re-run.

alter table quotes
  add column if not exists viewed_at timestamptz,                 -- first portal open
  add column if not exists last_viewed_at timestamptz,            -- most recent open
  add column if not exists view_count integer not null default 0; -- total opens

-- Sent-but-viewed lookup (staff follow-up surface).
create index if not exists quotes_viewed_idx
  on quotes (viewed_at desc) where viewed_at is not null;
