-- ─────────────────────────────────────────────────────────────────────────
-- Migration: NCE + YLL Neighbor tag system (#198)
-- ─────────────────────────────────────────────────────────────────────────
-- NCE = the barter/trade network YLL belongs to (NCE customers pay a 40% USD
-- deposit + the post-install 60% in NCE trade currency — the MONEY behaviors
-- that read this tag are ledger #199, not this migration).
--
-- quotes.is_nce: quote-level "Mark as NCE" tag, the NCE sibling of the
-- existing quotes.legacy_rebook ("YLL Neighbor") flag — see
-- migrations/2026-07-16-legacy-rebook.sql. Every consumer must gate on this
-- column as a POSITIVE match (is_nce = true), never a negative one, so a
-- normal quote is unaffected (AGENTS.md seam-gate rule). Unlike legacy_rebook,
-- NCE carries NO inbox/stats exclusions and NO portal-variant behavior — #198
-- is storage + UI + propagation only.
--
-- customers.is_nce / customers.is_yll_neighbor: the customer-level mirrors of
-- the two quote-level tags (#198 propagation: a tagged quote auto-tags its
-- linked customer when it becomes sent; a tagged customer's next NEW quote
-- inherits the tag). The customers table previously had no tag columns at
-- all. Forward-only by convention (enforced in application code, not a DB
-- constraint): propagation only ever sets these true, never clears them.
--
-- boolean NOT NULL DEFAULT false on all three: every existing/new row is
-- untagged unless explicitly marked. Idempotent: ADD COLUMN IF NOT EXISTS,
-- per CONVENTIONS.md §6 (model: migrations/2026-07-16-legacy-rebook.sql).
--
-- Migration-first (column-add class, AGENTS.md Pitfalls): this file applies
-- to prod BEFORE the #198 code merges — the code reads/writes these columns
-- from the moment it ships.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS is_nce boolean NOT NULL DEFAULT false;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_nce boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_yll_neighbor boolean NOT NULL DEFAULT false;
