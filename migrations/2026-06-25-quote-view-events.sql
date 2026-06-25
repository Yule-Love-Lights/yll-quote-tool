-- Customer view history (activity feed). Logs each individual customer open of a
-- quote portal so /customers/[id] can show a timeline of EVERY view — not just the
-- #68 aggregate (first/last/count). Lifecycle events (created/sent/approved) are
-- derived from the quotes row, so only the per-view log needs its own table.
-- Additive + idempotent. The customer page reads this best-effort, so the page
-- still works (showing lifecycle events) before this migration is applied.

create table if not exists quote_view_events (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  viewed_at timestamptz not null default now()
);

alter table quote_view_events disable row level security;

create index if not exists quote_view_events_quote_idx
  on quote_view_events (quote_id, viewed_at desc);
