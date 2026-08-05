-- =====================================================================
-- archive_photos — the P1 bulk-archive ingestion staging / review queue
-- (#167 training-data flywheel, P1 slice 1).
--
-- One row per historical install photo from Naldo's Drive archive, carrying
-- the human-resolved ground truth (address + optional linked customer) from
-- the photo-naming pass. This is the STAGING table, not the corpus: rows land
-- here 'pending', get fresh Google satellite/Street-View imagery attached
-- (slice 2), then a human traces the roofline/lights on the satellite via the
-- existing /training/new tracer (slice 3), which PROMOTES the house into
-- public.training_houses (source 'archive') — the table few-shot retrieval
-- already consumes. Keeping staging separate keeps the corpus clean and gives
-- a clear pending→approved review pipeline.
--
-- Grain is PER PHOTO (one row per Drive file); a house's multiple angles share
-- the same resolved_address_key and group at query time. drive_file_id is
-- UNIQUE, so the loader (companion -seed.sql) is idempotent and re-runnable.
--
-- resolved_customer_id FK → customers(id) ON DELETE SET NULL: an address-only
-- photo has no customer; deleting a customer (e.g. a test sweep) must not drop
-- the archive photo, only unlink it. promoted_training_house_id FK →
-- training_houses(id) ON DELETE SET NULL for the same reason (re-tracing a
-- deleted example just clears the link).
--
-- status values (plain text, documented not enum-constrained to match the
-- repo's existing style): 'pending' (loaded, no imagery yet) → 'imagery_fetched'
-- → 'ready_to_trace' → 'approved' (promoted to training_houses) | 'excluded'
-- (a non-install: shop/test/blurry — the 'skip' rows from naming land here).
-- classification: 'install_night' (default) | 'tree_bush_markup' | 'design_doc'
-- | 'other' (vision auto-classify is P2). P1 loads real installs as
-- 'install_night' and the 'excluded' non-installs explicitly as 'other', so
-- "classified as an install" never silently covers a shop/test/blurry photo.
--
-- RLS ENABLED, ZERO POLICIES — matches website_leads / self_serve_estimates /
-- the #90 all-tables hardening: only the service-role key (BYPASSRLS) touches
-- this table (the ingestion job + the operator-only /training/archive routes run
-- server-side), so RLS with no policies denies anon/authenticated entirely while
-- every real path is unchanged.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent; safe to
-- re-run. Apply THIS file before the companion 2026-07-23-archive-photos-seed.sql.
-- =====================================================================

create table if not exists public.archive_photos (
  id                          uuid primary key default gen_random_uuid(),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- Provenance (from the Drive archive + the naming manifest).
  drive_file_id               text not null unique,
  source_folder               text,
  original_title              text,
  content_hash                text,               -- reserved for future pixel-dedup; drive_file_id is today's idempotency key

  classification              text not null default 'install_night',

  -- Human-resolved ground truth (from the photo-naming pass).
  resolved_address            text,
  -- Normalized twin of resolved_address, mirroring public.properties.address_key
  -- and src/lib/customers.ts normalizeAddress() (lowercase, [.,#] -> space,
  -- collapse whitespace). The review queue groups a property's many photos by
  -- THIS column, never the raw text: without it "6 BIRCH ROAD ..." and
  -- "6 birch road ..." split one 4-photo house into two queue cards, and a
  -- double-traced house gets double weight in few-shot retrieval.
  resolved_address_key        text generated always as (
                                nullif(btrim(regexp_replace(
                                  regexp_replace(lower(resolved_address), '[.,#]', ' ', 'g'),
                                  '\s+', ' ', 'g')), '')
                              ) stored,
  resolved_customer_id        uuid references public.customers(id) on delete set null,
  -- The 8-char customers.id prefix the naming pass recorded. Kept alongside the
  -- resolved uuid so a link that fails to resolve at load time is DETECTABLE
  -- (resolved_customer_ref not null and resolved_customer_id is null) and
  -- re-linkable later, instead of silently landing as an unflagged null.
  resolved_customer_ref       text,
  -- The name the human actually typed for this photo ("deborah sande",
  -- "Two Marriott Plaza"). It is the only independent cross-check that a
  -- customer link points at the RIGHT customer, so it lives on the row rather
  -- than only in the CSV manifest.
  resolved_name               text,
  resolved_ghl_id             text,
  not_in_crm                  boolean not null default false,

  -- Fetched daytime imagery (slice 2; null until then).
  satellite_ref               text,
  street_view_ref             text,
  satellite_feet_per_pixel    numeric,

  extracted_counts            jsonb,               -- OCR'd tree/bush markup counts — P2, null in P1

  status                      text not null default 'pending',
  reviewer_notes              text,
  promoted_training_house_id  uuid references public.training_houses(id) on delete set null
);

-- Grouping (group-by-property review) + queue reads + customer join. The
-- grouping index is on the NORMALIZED key, since that is what the queue
-- groups by; the raw address is only ever displayed, never grouped on.
create index if not exists archive_photos_status_idx
  on public.archive_photos (status);
create index if not exists archive_photos_resolved_address_key_idx
  on public.archive_photos (resolved_address_key);
create index if not exists archive_photos_customer_id_idx
  on public.archive_photos (resolved_customer_id);

-- Keep updated_at fresh on every write. Slices 2 and 3 UPDATE these rows
-- repeatedly (imagery attach, status transitions, reviewer notes), so without
-- this trigger updated_at would freeze at load time and any "stalled in the
-- queue" check would silently read the original insert timestamp. Matches the
-- every-table convention (customers, properties, permanent_training_examples...).
create or replace function public.archive_photos_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists archive_photos_updated_at_trigger on public.archive_photos;
create trigger archive_photos_updated_at_trigger
  before update on public.archive_photos
  for each row execute function public.archive_photos_set_updated_at();

-- Defense in depth (mirrors self_serve_estimates + website_leads): the
-- service-role key is the only path that ever reaches this table, so RLS with
-- ZERO policies denies anon/authenticated entirely while every server path
-- keeps working unchanged.
alter table public.archive_photos enable row level security;
