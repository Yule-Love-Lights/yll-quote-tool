# Inventory #82 — Slice 1c: On-Hand stock table — Design Spec

> **Status:** APPROVED (Naldo, 2026-06-27). Completes the "Inventory Section" (Slice 1) after the catalog (1a) + bindings (1b). Fully Naldo's area — zero relay, no design-tool changes.

## Goal
Replace the `/inventory` "Stock" stub with the warehouse on-hand stock table: a **curated list** of the SKUs YLL actually stocks, each with an on-hand count, reorder point, and storage location, edited **inline with instant-save**. This is the live stock source of truth (the warehouse does an initial count, then keeps it current). Stock comparison + auto-decrement-on-prep come later (Slice 2 / Phase 2).

## Locked decisions
- **Curated list** — staff explicitly ADD a SKU (from the searchable picker); only added SKUs appear. One row per stocked SKU.
- **Inline instant-save** — qty / reorder point / location edit in the row and save on blur (optimistic; reload on error).
- **Per-item fields** — `on_hand_qty`, `reorder_point`, `storage_location` (spec §5.3). Cost lives on the catalog; supplier/last-counted deferred.
- **Low-stock flag** — a row is "Low" when `reorder_point > 0` AND `on_hand_qty <= reorder_point` (a brand-new item with no reorder point set is not "Low").
- **Salvage add-backs** (Q6.2) = ordinary qty edits — no separate ledger.

## Data model — `inventory_on_hand` (new table)
| col | type | notes |
|---|---|---|
| `sku` | text PK | logically refs `inventory_catalog.sku` (app picks from the catalog) |
| `on_hand_qty` | integer not null default 0 | |
| `reorder_point` | integer not null default 0 | |
| `storage_location` | text | nullable |
| `updated_at` | timestamptz not null default now() | reuses `inventory_set_updated_at()` trigger |

Idempotent migration, RLS-disabled (matches `inventory_catalog`). Applied via the Supabase SQL editor (service-role can't DDL).

## Backend
- `src/lib/inventory/onHand.ts` — `listOnHand()`, `upsertOnHand(row)` (upsert by sku; non-negative-int clamp via a pure `toQty`), `deleteOnHand(sku)`. Mirrors `catalog.ts` (reads swallow to `[]`; writes throw).
- `src/app/api/inventory/on-hand/route.ts` — `GET` (list) · `PUT` (add/edit one row, upsert) · `DELETE` (remove from the list). Service-role only; 503 when unconfigured; 400 on a missing `sku`.

## UI — `/inventory` Stock page
- `src/app/inventory/page.tsx` becomes a thin server wrapper (keeps `metadata`) rendering a new client `src/components/inventory/OnHandStock.tsx`.
- **Add stocked item** — the existing `SkuPicker` (value always empty; on pick → `PUT` a new row at qty 0, then it appears in the table). Already-stocked picks are a no-op.
- **Stock table** — one row per stocked item: `SKU · name · category · [On hand] [Reorder pt] [Location] · Remove`. Number/text inputs save on blur (optimistic; reload list on error). Low rows show an amber "Low" badge.
- **Filters** — a search box (sku/name/category) + a "Low stock only" toggle. Empty state when nothing is stocked.
- Reuses `SkuPicker` + the overrides instant-save/optimistic pattern. No pagination (curated list is small).

## Out of scope (later)
Auto-decrement on prep (Slice 2 / Phase 2), job-needs-vs-stock comparison, low-stock alerts/notifications, supplier/last-counted fields.
