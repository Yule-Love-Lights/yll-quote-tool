-- #81 auth hardening / ledger #90 — defense in depth: enable Row Level Security
-- on EVERY public table.
--
-- WHY THIS IS SAFE (verified before writing):
--   The app reaches every table through the Supabase SERVICE-ROLE key, whose
--   `service_role` Postgres role has BYPASSRLS — so enabling RLS with NO policies
--   denies the anon + authenticated roles while leaving every server data path
--   working unchanged. Net effect: a leaked anon key (or an accidentally-added
--   NEXT_PUBLIC_ Supabase var) can now read/write NOTHING, instead of every
--   customer PII row. See docs/audit/AUDIT-2026-06-26.md ("All PII tables have
--   RLS disabled").
--
-- CODE PRECONDITION (shipped in the same PR as this migration):
--   Three data-layer files still used the pure ANON client and would have broken
--   under RLS. They were switched to `getSupabaseServiceClient() ?? getSupabaseClient()`
--   (the idiom the rest of the data layer already uses):
--     • src/lib/quotes.ts        — saveQuote / updateQuote
--     • src/lib/training.ts      — all training_houses reads/writes (PII)
--     • src/lib/referenceAssets.ts — all reference_assets reads/writes
--   After that change, NO production path depends on the anon role, so there are
--   intentionally ZERO policies here.
--
-- NOTE: training_houses and reference_assets already had RLS enabled in prod;
--   re-enabling is a harmless no-op and keeps this list exhaustive so a fresh
--   rebuild is secure-by-default.
--
-- Roll-forward only. Idempotent — safe to re-run.
BEGIN;

ALTER TABLE public.quotes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_view_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.designs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_houses    ENABLE ROW LEVEL SECURITY;  -- already on
ALTER TABLE public.reference_assets   ENABLE ROW LEVEL SECURITY;  -- already on
ALTER TABLE public.training_examples  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_uploads     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_catalog  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_on_hand  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices           ENABLE ROW LEVEL SECURITY;

COMMIT;
