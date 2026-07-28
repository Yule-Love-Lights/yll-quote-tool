-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `view_only` to quotes (#176)
-- ─────────────────────────────────────────────────────────────────────────
-- Flags a quote staff created purely so a customer can browse a designed
-- scene (colour picker, prices) WITHOUT being able to approve or pay a real
-- deposit — the common case is a second quote spun up just to let a customer
-- play with colours. The portal still renders fully (scene, colour picker,
-- package prices); every approve/pay/decline/request-changes surface (both
-- the portal UI and the API routes) must gate on this column as a POSITIVE
-- match (view_only = true), never a negative one, so a normal quote is
-- unaffected (AGENTS.md seam-gate rule).
--
-- boolean NOT NULL DEFAULT false: every existing/new row is a normal,
-- fully-approvable quote unless explicitly marked. Idempotent: ADD COLUMN
-- IF NOT EXISTS, per CONVENTIONS.md §6 (model: migrations/2026-07-16-legacy-
-- rebook.sql). Applied out-of-band directly on prod; this file documents it.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS view_only boolean NOT NULL DEFAULT false;
