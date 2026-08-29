-- =====================================================================
-- Sign issuances + photo hashes (Naldo's 2026-08-29 rulings).
--
-- advertising_sign_issuances: the append-only ledger of signs HANDED to a
-- worker ("I'll give a team member 50 per week, and that's how we know how
-- many they have"). A worker's remaining count is DERIVED in the data layer
-- (signs issued minus yard-sign photos taken, any status), so nothing here
-- stores a balance that could drift. Issuing also draws the warehouse
-- inventory_on_hand pile down in the data layer, floored at zero, with an
-- audited prior/new.
--
-- advertising_placements.photo_hash: a 16-hex-char perceptual dHash of the
-- proof photo (photoHash.ts), stamped at capture. Feeds the review queue's
-- duplicate flags with a "very similar photo" reason — assistance only, the
-- human decides. Nullable: rows captured before hashing simply carry no
-- signal, and the flag logic treats a missing hash as never-similar.
--
-- RLS ENABLED, ZERO POLICIES on the new table (service-role only, the
-- advertising default). HOW TO APPLY: safe/additive per AGENTS.md (new
-- table, nullable column-add, indexes that cannot collide, RLS-enable on a
-- brand-new table).
-- =====================================================================

create table if not exists public.advertising_sign_issuances (
  id          uuid primary key default gen_random_uuid(),
  worker_id   uuid not null references public.advertising_workers(id),
  qty         integer not null check (qty > 0),
  issued_by   uuid references auth.users(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists advertising_sign_issuances_worker_idx
  on public.advertising_sign_issuances (worker_id, created_at desc);

alter table public.advertising_sign_issuances enable row level security;

alter table public.advertising_placements
  add column if not exists photo_hash text
  check (photo_hash is null or photo_hash ~ '^[0-9a-f]{16}$');
