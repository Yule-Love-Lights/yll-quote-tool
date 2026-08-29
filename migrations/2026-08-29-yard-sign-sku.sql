-- =====================================================================
-- Yard-sign SKU (advertising phase 2, Naldo's 2026-08-29 go on the audit
-- doc's ruling 8: "catalog SKU plus manual reconciliation first; per-unit
-- tracking only after placements prove the workflow").
--
-- Two idempotent seed rows, nothing else:
--   * inventory_catalog: YLL-YARD-SIGN under a 'Marketing' category. This is
--     a NON-VENDOR row — the Thunder CSV import is a pure upsert keyed by
--     the CSV's own SKUs (upsertCatalogItems), so re-imports never touch or
--     delete it. wholesale_cost stays NULL: signs are not purchased through
--     the Thunder PO flow, and a NULL cost keeps them out of any cost math.
--   * inventory_on_hand: the stock row at qty 0. The office counts the real
--     pile and sets the number on /admin/advertising/people (or the
--     existing /inventory/stock page, where this SKU now also appears).
--
-- NO auto-decrement on placement acceptance — deliberately. Phase 2 is
-- MANUAL reconciliation: the admin page shows accepted-sign counts beside
-- this stock number and a human reconciles them. Per-unit tracking is a
-- later phase gated on the workflow proving itself.
--
-- The WHERE NOT EXISTS guards make re-running SAFE, not corrective: if a
-- seeded value is ever wrong, fix it with an UPDATE (or the stock page),
-- never by editing this file and re-applying (the crew_members lesson).
--
-- HOW TO APPLY: safe/additive per AGENTS.md (idempotent seed inserts
-- guarded by where not exists).
-- =====================================================================

insert into inventory_catalog (sku, name, category, yll_category)
select 'YLL-YARD-SIGN', 'Yard sign (advertising)', 'Marketing', 'Marketing'
where not exists (select 1 from inventory_catalog where sku = 'YLL-YARD-SIGN');

insert into inventory_on_hand (sku, on_hand_qty, reorder_point)
select 'YLL-YARD-SIGN', 0, 0
where not exists (select 1 from inventory_on_hand where sku = 'YLL-YARD-SIGN');
