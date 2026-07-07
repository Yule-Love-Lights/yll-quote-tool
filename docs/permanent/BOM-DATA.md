# Permanent Lighting — BOM data (Wave 0, Naldo 2026-07-03)

Authoritative supplier catalog + golden jobs for the P2 BOM engine (`buildPermanentBom`).
Source: **2026 ASCEND by Dauer All Products Price List** (bought via Thunder Lighting
Supply, (631) 803-9627). The example estimator sheets use the OMNI `88xxx` tool; our
real cost basis is the ASCEND `APL` list below (it reproduces the estimator totals to
~0.3% — see golden cases).

## Locked supplier answers (Naldo 2026-07-03)
- **Transformer sizing binds on PUCKS, not feet.** 350W = 300 pucks, 600W = 510 pucks.
- The puck limit applies to **both** transformer sizes.
- **One WiFi hub per SYSTEM** (not per transformer) unless specifically requested.
- Suggest ≤85% load headroom (from the estimator); size the transformer set by total pucks.
- **No labor-cost data yet.** The `$720` row in the sheets is a labor placeholder — treat
  labor as informational only, NEVER a customer line. BOM = materials + wholesale cost only.

## ASCEND `APL` catalog (SKU · description · wholesale $)
> **Seeding the live catalog (P8):** this list is encoded as `ASCEND_CATALOG` in
> `src/lib/inventory/ascendCatalog.ts`. To load it into `inventory_catalog` (needed
> so operator BOM/order screens show part names + live costs), run
> `npm run seed-ascend-catalog` with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
> in the env (or `.env.local`). Idempotent — keyed on `sku`, writes only vendor
> columns, never clobbers operator `yll_category`/`locked`. Re-run after any
> `ASCEND_CATALOG` edit. A lock-in test (`ascendCatalog.test.ts`) pins every
> BOM-engine-emitted SKU's cost against this list.

| SKU | Description | Wholesale |
|---|---|---|
| APL11000 | ASCEND DEMO KIT WITH CASE | 485.10 |
| **Transformers** | | |
| APL11075-R | 75W MEANWELL REMOTE POWER SUPPLY 12V DC | 88.50 |
| APL11110-350 | 12V 350W POWER SUPPLY (waterproof box) | 251.94 |
| APL11110-600 | 12V 600W POWER SUPPLY (waterproof box) | 342.85 |
| APL11111-350-KIT | 350W CONTROL BOX + POWER SUPPLY + WIFI HUB + SIGNAL BOOSTER + FEMALE ADAPTER | 345.44 |
| APL11111-600-KIT | 600W CONTROL BOX + POWER SUPPLY + WIFI HUB + SIGNAL BOOSTER + FEMALE ADAPTER | 433.75 |
| **Light sets** (8" OC → `ceil(ft*1.5)` pucks) | | |
| APL11012-1 | RGBW 3000K 12V LED (SINGLE) | 3.8472 |
| APL11012-5 | RGBW 3000K 12V LED (SET OF 5) | 15.5156 |
| APL11012-1-BLK | RGBW single, BLACK housing | 3.8472 |
| APL11012-5-BLK | RGBW set of 5, BLACK housing | 15.5156 |
| **Accessories** | | |
| APL11120 | WIFI BRIDGE (HUB) CONTROLLER | 83.11 |
| APL11121 | SIGNAL BOOSTER | 12.6644 |
| APL11122 | SPLITTER 12V | 6.6496 |
| APL11123 | POWER T-INJECTOR 12V | 5.8489 |
| APL11126 | FEMALE ADAPTER (wire into hub) | 2.9196 |
| APL11130 | 50' EXTENSION WITH SIGNAL BOOSTER | 33.7653 |
| APL11200 | POWDER COAT COLOR BOOK | 31.92 |
| APL11330 | WIRE END CAP (BAG OF 25) | 3.1539 |
| **Tracks** (40" sections → `ceil(ft/(40/12))` +6% waste) | | |
| APL11210-9003 / -9004 / -9012 / -8019 | 40" SINGLE TRACK white/black/cream/dark-brown | 7.3331 |
| APL11220-9003/-9004/-9012/-8019/-8022/-7045 | 40" DOUBLE (2PC) white/black/cream/brown/bronze/lt-grey | 7.9482 (bronze/grey 7.95) |
| APL11230-90-9003 / -9004 | 40" PARAPET TRACK 90° white / black | 8.3779 |
| **Extensions** | | |
| APL11312-3 | 3' EXTENSION 12V M-F | 2.9440 |
| APL11312-5 | 5' EXTENSION | 3.4566 |
| APL11312-10 | 10' EXTENSION | 4.6088 |
| APL11312-25 | 25' EXTENSION | 10.7115 |
| APL11312-50 | 50' EXTENSION | 21.1009 |

Notes: only WHITE (9003) and BLACK (9004) parapet-90 exist → a parapet job in cream/brown
must flag "no stock parapet in this color". Custom powder-coat = 50-track (165') min, 6-wk lead.
Screws/loom/WAGO not in this list → provisional keys, flag on the sheet.

## Golden jobs (validate `buildPermanentBom` quantities; cost ±2-3%)
All single-track white, 8" OC. `$720` = labor placeholder (ignore).

**Greg M — 125 ft** (runs 60+25+40), 0 corners, 1 splitter, 2×10'+2×25' ext, controller n/a.
- Pucks `ceil(125*1.5)=188` → 37 sets + 3 singles. Track `ceil(125/3.333)=38` → +6% ≈ 41.
- Transformer: 188 ≤ 300 → **1×350 KIT**. Power-T: `ceil(188/75)=3`.
- Sheet: **Total $1,228.67 · w/waste $1,290.81 · $9.83–$10.33/ft**. ASCEND recompute ≈ $1,287 (~0.3%). ✔

**Melissa North — 100 ft**, 0 corners, 1 splitter, 2×10'+2×25', 1 female adapter, controller→first 35 ft, 1 gap >50'.
- Pucks `ceil(100*1.5)=150` → 30 sets + 0 singles. Transformer 150 ≤ 300 → 1×350 KIT.
- Booster: controller 35 ft > 10 → +1 (KIT includes one); gap >50' → +1.
- Sheet: **Total $1,084.65 · w/waste $1,125.78 · $10.85–$11.26/ft**.

**Andrew W — parapet-angle, 600W, 350 in the "ends/corners/transitions" field, TOTAL FEET 0**, female adapter 1, controller→first 35 ft.
- ⚠ Ambiguous extraction (0 ft + 350 corners). Likely a "total-job" entry mode; DO NOT use as a
  footage golden case. Use only as a parapet + 600W-transformer + high-corner shape check.
- Sheet: **Total $4,043.08 · w/waste $4,262.24**. Track notes: Single 6 / Parapet-Angle 8 (2 extra waste each).

## Formula reconciliation (from estimator)
- Corners/ends/transitions: **+3 singles each** (peak = 3).
- Waste: **6%** on tracks + lights.
- Booster: controller→first-light > 10 ft → +1; each gap > 50 ft → +1. (Estimator asks both.)
- Power injection: Power-T every ~75 pucks; never > 35 lights (~25 ft) un-injected tail.
- Extensions sized per gap (3/5/10/25/50'); splitter where the line branches.
- KIT (first transformer) bundles hub + booster + female adapter; additional transformers are bare power supplies (1 hub/system).
