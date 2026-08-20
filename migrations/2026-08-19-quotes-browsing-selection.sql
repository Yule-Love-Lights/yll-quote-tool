-- =====================================================================
-- quotes.browsing_selection / browsing_selection_updated_at — persisted
-- customer PORTAL BROWSING state (ledger row 239, Jason's 2026-08-11 ruling).
--
-- THE PROBLEM: the portal's SelectionContext (packageId, selectedItemIds,
-- rush/takedown toggles, color scheme/pattern, permanent effect, install
-- timing) lived in plain useState — zero persistence, reseeded from scratch
-- (staff recommendation / package default) on every load. A customer who
-- browses on a phone and comes back on a laptop to approve started over, and
-- staff had no visibility into what a not-yet-approved customer was leaning
-- toward (a sales signal).
--
-- WHY A NEW COLUMN, NOT approval_snapshot: approval_snapshot is the FROZEN
-- record of what the customer actually agreed to and must never be written
-- before real approval — see /api/quotes/[id]/approve. browsing_selection is
-- the OPPOSITE: a live, mutable, non-authoritative cache of the customer's
-- CURRENT in-progress pick, written on every portal visit by
-- /api/quotes/[id]/selection, and never read by anything that charges money —
-- price is always recomputed live from result/lineItems (SelectionContext /
-- priceSelection), and the real charge is always the server-side recompute in
-- approve/route.ts, which ignores this column entirely. The API route refuses
-- to write once customer_approved_at is set, so this column can never shadow
-- or get confused with the frozen snapshot.
--
-- RECONCILIATION: a saved selection can reference a package/line-item id that
-- no longer exists (staff re-ran Calculate between visits). The portal never
-- trusts this column blindly — src/lib/portal/adapter.ts's
-- resolveBrowsingSelectionSeed validates it against the quote's CURRENT
-- packages/lineItems before seeding, falling back to the staff-computed
-- default when the saved custom selection has gone entirely stale (mirrors
-- the approve route's own realIds filter / resolveApprovalSelectionSeed).
--
-- Both columns nullable — every existing quote row (and any quote the
-- customer never opens) simply has neither.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default
-- (nullable jsonb + nullable timestamptz add-column on the existing,
-- populated `quotes` table — no backfill, no constraint). NOT applied by this
-- commit — the seat reviews and applies it.
-- =====================================================================

alter table public.quotes
  add column if not exists browsing_selection jsonb;

alter table public.quotes
  add column if not exists browsing_selection_updated_at timestamptz;

comment on column public.quotes.browsing_selection is
  'Customer''s LIVE, still-editable portal selection (ledger row 239) — packageId/selectedItemIds/rushSelected/takedownSelected/installTiming/colorSchemeId/customPattern/permanentEffect. NOT the frozen agreement (see approval_snapshot); never trusted for money math; reconciled against live packages/lineItems on read (resolveBrowsingSelectionSeed). Written only pre-approval by /api/quotes/[id]/selection.';
