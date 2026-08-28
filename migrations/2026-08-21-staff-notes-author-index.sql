-- Index the nullable auth.users foreign key so ON DELETE SET NULL does not
-- scan the full notes table when an operator account is removed.

create index if not exists staff_notes_created_by_idx
  on public.staff_notes (created_by)
  where created_by is not null;
