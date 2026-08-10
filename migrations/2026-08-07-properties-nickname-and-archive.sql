-- ─────────────────────────────────────────────────────────────────────────
-- Migration: nickname + archive for properties (#205)
-- ─────────────────────────────────────────────────────────────────────────
-- Customer profile "Properties" tab, full manage (ledger #205): staff can
-- label a property and hide ones that no longer matter, without losing the
-- history quotes/jobs/invoices reference.
--
-- properties.nickname: a staff-only display label ("Talonda's House",
-- "Bellmore store") — purely cosmetic, never used for matching/dedup (that
-- stays on address_key, untouched by this migration). NULL/empty for every
-- existing row and for every row still auto-created from quote activity
-- (findOrCreateProperty/attachQuoteToCustomer, #83 Phase 5) — staff opt in
-- by typing one on the profile.
--
-- properties.archived_at: set = this property is hidden from the customer
-- profile's default property list WITHOUT deleting the row. Quotes/jobs/
-- invoices reference properties by id (a hard delete would orphan those
-- money records), so "remove" here only ever means archive — no UI in this
-- codebase issues a DELETE on this table. NULL = visible (every existing
-- row starts visible). A property auto-resurrects (archived_at cleared) the
-- moment real quote activity lands on it again — see findOrCreateProperty's
-- #205 comment in src/lib/customers.ts.
--
-- Both nullable, no DEFAULT beyond NULL: every existing/new row starts
-- unlabeled + unarchived. Idempotent: ADD COLUMN IF NOT EXISTS, per
-- CONVENTIONS.md §6 (model: migrations/2026-08-05-nce-customer-tags.sql).
--
-- Migration-first (column-add class, AGENTS.md Pitfalls): apply this to prod
-- BEFORE the #205 code merges — the code reads/writes these columns from
-- the moment it ships. src/lib/customers.ts's PropertyRow.nickname/
-- archived_at are typed optional specifically so the code still typechecks
-- and the test suite still passes pre-migration; see that file.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS nickname text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
