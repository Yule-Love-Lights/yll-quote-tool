-- =====================================================================
-- Hand-outs cover DOOR HANGERS too (Naldo, 2026-09-04).
--
-- The issuance ledger only ever counted yard signs, because that is what
-- the warehouse held when it was built. The crew places far more door
-- hangers than signs (47 against 7 in the real data), and the office has
-- had no way to record giving someone a box of them or to see how many
-- they have left.
--
-- One ledger for both, separated by `kind`, matching how placements are
-- already modelled. A worker's remaining count is still DERIVED, now per
-- kind: hangers issued minus door-hanger photos taken, signs issued minus
-- yard-sign photos taken. Neither number gates a submission; it is how the
-- office KNOWS, exactly as before.
--
-- DEFAULT 'yard_sign' is the load-bearing part: every row written before
-- today was a sign hand-out, so the default makes the existing ledger true
-- rather than ambiguous. It is not a guess about future rows, which always
-- carry an explicit kind from the screen.
--
-- The warehouse draw-down stays SIGNS ONLY. inventory_on_hand tracks the
-- yard-sign SKU; there is no door-hanger SKU, so a hanger hand-out records
-- the hand-out without touching stock. When hangers get their own SKU this
-- is the line to revisit.
--
-- HOW TO APPLY: safe/additive per AGENTS.md - a NOT NULL column add with a
-- default, which backfills every existing row with the value that was
-- already true of it, plus an index that cannot collide.
-- =====================================================================

alter table public.advertising_sign_issuances
  add column if not exists kind text not null default 'yard_sign';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'advertising_sign_issuances_kind_check'
  ) then
    alter table public.advertising_sign_issuances
      add constraint advertising_sign_issuances_kind_check
      check (kind in ('yard_sign', 'door_hanger'));
  end if;
end $$;

create index if not exists advertising_sign_issuances_worker_kind_idx
  on public.advertising_sign_issuances (worker_id, kind, created_at desc);
