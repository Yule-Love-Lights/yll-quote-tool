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
-- ⚠️ REBUILD-ORDERING NOTE (audit #110 wave 2, finding W2-006): several of the
--   OLDER create-table migrations for the 14 tables listed below (customers-
--   properties.sql, invoices.sql, jobs.sql, inventory-catalog.sql,
--   inventory-on-hand.sql, app-settings.sql, custom-uploads.sql) END with
--   their own `DISABLE ROW LEVEL SECURITY` statement and are individually
--   labeled "idempotent; safe to re-run." A FRESH, full in-order rebuild of
--   migrations/*.sql is SAFE — this migration is committed after all of them
--   (2026-06-28, 19:28:18 -0400; every older create-table file predates it,
--   and this file's own comment above documents training_houses/
--   reference_assets already being on), so a straight top-to-bottom replay
--   ends with every table here RLS-ENABLED. Prefer migrations/FULL-SCHEMA.sql
--   for a fresh rebuild — it's the reconciled end-state and isn't exposed to
--   file-ordering mistakes at all.
--   The REAL footgun this migration doesn't protect against: re-running any
--   ONE of those older create-table files BY ITSELF after this one (e.g.
--   re-pasting inventory-catalog.sql to re-import the Thunder CSV, exactly as
--   its own header instructs) silently flips that single table back to
--   RLS-DISABLED, because each file was written to be individually
--   re-runnable and its own DISABLE line runs unconditionally. If you must
--   re-run one of those files standalone, re-run this ENABLE migration
--   immediately after, or (better) drop the trailing DISABLE line from that
--   file the next time it's touched.
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
