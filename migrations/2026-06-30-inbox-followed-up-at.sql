-- #58 v2 snooze/"Followed": a nullable flag marking an item as followed-up (replied
-- in-tool, or a manual "I followed up"). Followed items hide from the open list and
-- reappear only on a genuinely-newer message (mirrors the handled reopen rule).
-- Orthogonal to status — no status-enum churn.
alter table public.inbox_items add column if not exists followed_up_at timestamptz;

create index if not exists inbox_items_followed_up_at_idx
  on public.inbox_items (followed_up_at)
  where followed_up_at is not null;
