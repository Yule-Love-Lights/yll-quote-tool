-- Inbox triage v1 (#58) — two additive, nullable columns on inbox_items.
--   lead_kind   : 'lead' | 'automated'  (NULL = unclassified, treated as 'lead')
--   quote_value : the quote $ total for quotetool items (NULL elsewhere)
-- Additive + nullable → no backfill, no default-state churn. RLS already covers
-- the table. Apply out-of-band (Supabase SQL editor) when a human approves.

begin;

alter table public.inbox_items
  add column if not exists lead_kind   text,
  add column if not exists quote_value numeric;

-- Open-list filter is (status='unresponded' AND lead_kind …); this index serves it.
create index if not exists inbox_items_status_lead_kind_idx
  on public.inbox_items (status, lead_kind, last_message_at desc);

commit;
