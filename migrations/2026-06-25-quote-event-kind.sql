-- Generalize quote_view_events into a portal-interaction log: add a `kind` so it
-- can hold both 'viewed' (the read receipt) and 'interested' (the customer
-- hovered/tapped Approve without approving — a hot-lead signal on the activity
-- feed). Additive + idempotent; existing rows default to 'viewed'. The customer
-- page reads this column best-effort (select *), so the view feed keeps working
-- before this migration is applied.

alter table quote_view_events
  add column if not exists kind text not null default 'viewed';

alter table quote_view_events drop constraint if exists quote_view_events_kind_check;
alter table quote_view_events add constraint quote_view_events_kind_check
  check (kind in ('viewed', 'interested'));
