-- #81 auth hardening / ledger #90 — actor audit trail.
--
-- Now that the operator perimeter gives each request a real per-user identity
-- (getOperator() → {id, email, role}), stamp WHO created a quote / design. The
-- audit (AUDIT-2026-06-26.md) flagged that attribution was never modeled — there
-- was no actor to record even in the DB.
--
-- created_by = the operator's Supabase Auth user id. FK to auth.users with
-- ON DELETE SET NULL so deleting an operator account doesn't delete their quotes,
-- it just unlinks the attribution.
--
-- Fully additive + nullable: existing rows get NULL, and any create made while the
-- auth gate is still dormant (no session → getOperator() returns null) also gets
-- NULL. Roll-forward only. Idempotent.
BEGIN;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.designs
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMIT;
