-- #58 v3: a terminal "completed" state (fully done, no more contact expected) —
-- distinct from "handled" (still in the works). Additive: widen the status CHECK.
alter table public.inbox_items drop constraint if exists inbox_items_status_check;
alter table public.inbox_items add constraint inbox_items_status_check
  check (status in ('unresponded','handled','dismissed','completed'));
