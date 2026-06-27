# Inventory System (#82) — Design Spec

> **Status:** DRAFT for Naldo's review — 2026-06-27.
> **Source:** brainstorm with Naldo (2026-06-27) answering the 6 open questions in `docs/context/project_inventory_system.md` §10, + a 6-agent code-map workflow (`wf_2792dda2-c9c`) that grounded every integration point in real file anchors.
> **Relationship:** this is the decision-locked, code-grounded design that supersedes the open questions in `project_inventory_system.md`. The ledger row is **#82**. Shares a `jobs` entity with the **jobber-flow #83** initiative (`docs/jobber-flow/SPEC.md`).
> **Build branch:** `naldo/inventory` (isolated worktree outside OneDrive). PR-not-master; gates green; a human approves every merge.

---

## 1. Goal & scope

Turn the `/inventory` stub into the system that (a) **knows what materials every booked job needs** (auto-derived from the customer's design), (b) **tracks what YLL has on hand**, and (c) **moves each job through a fulfillment pipeline**. The keystone realization from this brainstorm: the inventory is built on top of **YLL's real supplier catalog (Thunder Lighting)**, with a **binding layer** that connects the design/quote tool's vocabulary to actual supplier SKUs.

In scope (this spec): the data model, the catalog-import + binding architecture, the clip-rules engine, the materials projection, the job entity + Stages Kanban, and PDF/email order export — decomposed into 3 build slices + 2 later phases.

Out of scope (parking lot, later phases): the WhatsApp bot, AI auto-ordering, Amazon/secondary-supplier items (timers etc.).

## 2. Architecture — three layers + the connection

```
Supplier Catalog (full Thunder import, by category)
        │
        ▼   bindings = "what YLL actually uses"  ← the bridge to the design/quote tool
   Bindings (design concept → real SKU)
        │
        ▼
   On-Hand stock (qty + reorder point + storage location, per bound SKU)
```

**The binding layer IS the connection** between inventory and the design/quote tool. The design/quote tool speaks in concepts ("warm white bulb", "gutter run", "24″ decorated wreath"); the catalog speaks in SKUs (`20009-SPK`, `14147`, …). The binding maps concept → SKU, so when a job is created the design translates into exact SKUs + quantities + bags/cases to order, and stock can be decremented.

This is why **Slice 1 builds first**: it establishes the shared dictionary (catalog + bindings) everything else references. It is *not* disconnected from the design tool — it's the foundation the design tool reads.

## 3. Locked decisions (all 6 open questions answered)

| # | Topic | Decision |
|---|---|---|
| Q1 | Clip rules | Locked — see §4 table. |
| Q2 | Stock model | 3 layers (catalog → bindings → on-hand). Per-item fields: SKU, name, category, color, size/spacing, needs-adapter, wholesale cost, **Bag CT**, **Case CT**, reorder point, storage location, qty-on-hand. |
| Q3 | Phasing | Build the **Inventory Section first** (Slice 1), then materials engine (Slice 2), then jobs+board (Slice 3). See §8. |
| Q4 | Stock decrement | Only at **prep** (never reserved at booking). |
| Q5 | Feature detection | **AI fully auto-detects** the roof feature; staff **verify + correct**; corrections feed the existing **#8 training** loop. |
| Q6.1 | Supplier | **Thunder Lighting only.** Amazon misc (timers etc.) deferred → `supplier` field future-proofed but Thunder-only now. |
| Q6.2 | Reuse | **Consume-only.** No automatic return-to-stock. Exception: if a customer doesn't return, staff **break old material down to bulbs/clips/wire** → **manual salvage add-back** (a manual on-hand adjustment, not an automated cycle). |
| Q6.3 | Catalog + settings | Import **everything** from Thunder, organized by the catalog's **Category**. Settings: **category show/hide toggles** + an **item "lock" flag** (sold-out/unobtainable → engine won't order/use it; binding UI warns if a bound item is locked). |
| — | Materials list | **Staff/AI-only**, never customer-facing. **PDF/email export.** |
| — | Job ID | **Job ID ≠ Quote ID** — own entity, linked to the quote, created on the **deposit-paid (#38 Valor) webhook**. Shared with #83. |

## 4. The clip-rules table (Q1 — locked)

Each design run gets tagged with a physical **roof feature**; the engine maps feature → clip → Thunder SKU. **Hard rules:** no window lighting, ever; no C7 clips, ever.

| Roof feature | Clip / material | Thunder SKU | Pack (bag/case) | Detection cue |
|---|---|---|---|---|
| **Gutterline** | C9 Flex Clip *(Naldo's "tuff clip")* | `14147` W / `14347` B | 100 / 800 | white line at the roof edge (satellite-visible) |
| **Peak** (front shingle gable, no gutter) | Shingle Tab | `14145` W / `14345` B | 100 / 1000 | shingles to the front, no gutter |
| **Side** (shingles) | Shingle Tab | `14145` / `14345` | 100 / 1000 | — |
| **Ridge** (horizontal apex, Gingerbread) | C9 Peak Clip (Ridge Clip) | `14159` W / `14859` Brown | 100 / 1000 | horizontal line at the very top-middle |
| **Pathway** / stake-lighting | Pathway Ground Stake | `14343` B / `14443` Grn | 100 / 1000 | ground run |
| **Flat / commercial** | Parapet Clip **+** Shingle Tab (both) | `14144`/`14744` + `14145` | 100 / 500 | — |
| **Metal** | Magnetic socket wire (no clip — **flag for staff review**) | — | — | metal roof surface |

**Terminology trap (the binding protects against this):** the catalog has a *separate* product literally named **"C9 Tuff Tab" (`14148`)** that is **NOT** what Naldo means by "tuff clip" — Naldo's "tuff clip" = the **Flex Clip (`14147`)**. Same trap on bulbs: bind warm-white → `20009-SPK`, ignore the HBL/MIN/"DO NOT SELL" variants. **Spritzers** are excluded from the clip engine — they bundle their own Stake Metal (`14344`/`14355`/`14366`) as part of the spritzer's materials.

**Clip count** = run footage ÷ clip spacing. The spacing constants (clips per ft, per feature) are **config** Naldo sets in the clip-rules settings (`app_settings` key `clipRules`), not hardcoded.

## 5. Stock model — schemas

### 5.1 Catalog (`inventory_catalog` table) — full Thunder import
Columns mirror the CSV: `sku` (PK), `name`, `category` (bulb | clip/hardware | wire | stake | spritzer | greenery[wreath/garland] | tree-string | …), `color` (nullable; store the palette-id-compatible value where applicable), `size`, `wholesale_cost`, `needs_adapter` (bool), `bag_ct`, `case_ct`, `locked` (bool — Q6.3 sold-out flag), `created_at`/`updated_at`. Raw vendor catalog, imported from CSV, rarely hand-edited. Retail/wattage/voltage kept on import for free.

### 5.2 Bindings (`app_settings` JSON keys, **not** a table — config, low-cardinality)
- Key **`bindings`** maps each billed design-concept enum member → a catalog SKU. **Key off the palette ID, never the label** (the `cool-white`=label "Pure White" / `cool-white-faceted`=label "Cool White" trap). Shape:
  - `bulbColor`: `{ "<paletteId>:<bulbType>": sku }` — e.g. `"warm-white:c9" → "20009-SPK"`. `black` (off bulb) → the unlit socket SKU.
  - `wreath`: `{ "<QuoteWreathSize>:<Tier>": sku }`
  - `garland`: `{ "<QuoteGarlandLength>:<Tier>": sku }`
  - `spritzer`: `{ "<QuoteSpritzerSize>": { spritzerSku, stakeMetalSku } }` (bundle)
  - `tree/mini`: `{ "<surface>:<wrapStyle>": stringSku }`
- Key **`clipRules`** holds the roof-feature → clip-SKU map + clip-spacing constants.
- A validator (alongside `src/lib/appSettings.ts:14-24`) checks each bound SKU exists in `inventory_catalog`.

### 5.3 On-Hand (`inventory_on_hand` table)
`id` (uuid PK), `sku` (refs `inventory_catalog.sku`), `on_hand_qty` (int), `reorder_point` (int), `storage_location` (text), `updated_at`. Manual salvage add-backs (Q6.2) are ordinary qty adjustments. (`cost`/`supplier`/`last_counted` deferred — Thunder-only for now.)

## 6. Integration map (code-grounded, with anchors)

Per material category: the design concept, where it's defined, what data it already carries, the binding needed, where it plugs in, and relay implications. *(All anchors verified by the code-map workflow against `naldo/inventory` @ `3ab51df`.)*

| Category | Design concept (defined at) | Data already carried | Binding needed | Net-new / relay |
|---|---|---|---|---|
| **Bulbs + colors** | `colorPattern` (palette ids) on strand/spritzer/miniArea; `bulbType`. Palette `DEFAULT_COLORS` `editor-core/colors.ts:5-22`; `colorPattern` `sceneTypes.ts:85/144/194`; approved color = frozen `colorSchemeId`/`customPattern` `colorSchemes.ts:44-109`. | color ids + bulbType + spacing + points. **No bulb count computed anywhere.** | `paletteId:bulbType → SKU`. **Bulb count = NET-NEW** (`strandLengthPx/pxPerFoot ÷ (spacingIn/12)`, cross-mult colorPattern, read against the *frozen approved* scheme). | Binding map lives **OUTSIDE** vendored `editor-core/colors.ts` (in `src/lib/inventory/` or YLL-only `colorSchemes.ts`). No relay unless a new color is added. |
| **Socket wire / footage** | Roofline = `strand`+`c9`+billing-Surface; **footage staff-entered on QuoteInputs**, not measured from geometry. `pricingEngine.ts:24-28,162-175`; excluded from `projectScene.ts:16-21,110-122`. | `santasFootage`/`gingerbreadFootage`/`winterWonderlandFootage`/`stakeLightingFootage` + difficulty. | ft → wire SKU + bulb count by spacing. **Per-ft→materials conversion = NET-NEW.** | None (footage is YLL QuoteInputs). |
| **Clips** | **NET-NEW. No physical roof-feature attribute exists today** (confirmed `sceneTypes.ts:80-100`). Surface tag is billing-only. | nothing physical | Add per-run roof-feature attr; clip-rules engine (§4). | ⚠️ **Attribute on `StrandItem` (`sceneTypes.ts`) + setter in `editor-core/editor.ts:2294-2317` = SHARED + EDITOR-CORE → byte-identical RELAY** to the standalone design tool. Engine/config are YLL-only. |
| **Wreaths** | `WreathItem.quoteSize` (24/30/36/48/60/72 noble) + `tier` (bow/fullDecor). `sceneTypes.ts:102-115`, `pricingEngine.ts:53-60`, projects qty 1 `projectScene.ts:144-193`. | quoteSize, tier, qty 1, sceneItemIds | `quoteSize:tier → greenery SKU`. | No relay (binding outside the enum). |
| **Garland** | `GarlandItem.quoteLength` (4.5/9ft) + `quoteSections` + tier. `sceneTypes.ts:125-137`; projects **qty = quoteSections**. | quoteLength, quoteSections (the only count >1), tier | `quoteLength:tier → SKU` × quoteSections. | No relay. |
| **Spritzers** | `SpritzerItem.quoteSize` (16/24/32) + colorPattern. `sceneTypes.ts:139-147`, `pricingEngine.ts:43-47`. | quoteSize, colorPattern, qty 1 | `quoteSize → { spritzerSku, stakeMetalSku }` (bundle: `14344/55/66`). | No relay. |
| **Ground stakes** | stake-lighting = `c9` strand `surface='stake-lighting'`, footage-priced. `sceneTypes.ts:44`, `pricingEngine.ts:32-36`. | `stakeLightingFootage`+difficulty | pathway/stake → `14343` + ft→stake-count (NET-NEW). | Surface member already byte-shared; no new relay. |
| **Trees/bushes/columns/railings** | mini-light strand tagged `surface=tree/bush/column/railing`, billed `MiniBilling.stringCount`×wrapStyle. `sceneTypes.ts:45-59`, `pricingEngine.ts:38-41`. | surface, wrapStyle, **stringCount (abstract)** | `surface:wrapStyle → mini-strand SKU`. **Define what 1 "string" = in stock** (NET-NEW). | No relay (binding outside the enum). |

## 7. Data model summary

- **Tables (new):** `inventory_catalog`, `inventory_on_hand`, `jobs` (Slice 3). Idempotent migrations, RLS-disabled to match `designs`/`quotes`, `updated_at` trigger (template `migrations/2026-06-16-app-settings.sql`); applied via the Supabase browser SQL editor (service-role can't DDL).
- **Config (new `app_settings` keys):** `bindings`, `clipRules`.
- **New code dirs:** `src/lib/inventory/` (`catalog.ts`, `onHand.ts`, `clipRules.ts`, `materialsProjection.ts`, `jobs.ts`) mirroring `src/lib/dashboard/`; `src/app/api/inventory/` routes (template `src/app/api/settings/route.ts`); `src/components/inventory/`; the `/inventory` page replaces the stub (`src/app/inventory/page.tsx`; nav slot exists at `OperatorNav.tsx:17`).
- **Joins:** `inventory_on_hand.sku = inventory_catalog.sku`; binding values (sku) = `inventory_catalog.sku`; the materials projection emits `{sku, qty}` rows that join to on-hand for stock comparison; `jobs.quote_id = quotes.id` → `getDesign(designId).scene`.

## 8. Build plan (slices)

### Slice 1 — The Inventory Section *(build first; entirely Naldo's area, ZERO relay)*
Catalog import (`inventory_catalog` + Thunder CSV importer + `catalog.ts`) · binding-settings page (new Settings sub-page editing `app_settings` `bindings` + `clipRules`; incl. **category show/hide toggles** + **item lock**; template `src/app/settings/customer-portal/page.tsx`) · on-hand table (`inventory_on_hand` + `onHand.ts` + `/inventory` page replacing the stub; best-effort read so it renders pre-migration). **No scene/editor-core changes** — it only *reads* enum members that already exist.

### Slice 2 — Materials engine *(Jason-area + SHARED + EDITOR-CORE RELAY)*
NET-NEW per-run roof-feature attribute on `StrandItem` (additive+optional, `sceneTypes.ts:80-100`) + "Roof feature" dropdown in `editor-core/editor.ts` — **heads-up to Jason + byte-identical mirror to the standalone design tool** · AI auto-detect of the feature (extends the #8 photo analysis) + staff verify/correct · clip-rules engine (`clipRules.ts`) · materials projector (`materialsProjection.ts`, a pure parallel of `projectScene.ts`) emitting `{sku, qty}` for bulbs/wire/clips/stakes/spritzer bundles/mini strings/greenery, consumed alongside `applyProjectionToInputs` at `src/app/api/quote/route.ts:83-96`.

### Slice 3 — Jobs + board *(SHARED job entity with #83)*
`jobs` table + `jobs.ts` (Job ID ≠ Quote ID) · auto-create on the #38 deposit-paid webhook · Stages Kanban on `/inventory` (cards = jobs, 4 fulfillment stages — a **different** board from the dashboard's Quotes WorkflowBoard) · PDF/email order export (materials projection joined to on-hand).

### Phase 2 — Stock loop
Job-needs vs on-hand comparison → order-vs-prepare; **decrement on prep** (Q4); low-stock/reorder alerts.

### Phase 3 — Automation
WhatsApp bot (card moves + stock updates) + AI auto-ordering. Heaviest/most external — deferred.

## 9. Coordination, relay & gates

- **#81 auth perimeter** gates every operator/money surface (same prerequisite as #83). Slice 1 (internal stock data, no PII, no money) is the lowest-risk surface but still rides behind operator auth.
- **Area ownership:** Slice 1 = **Naldo** (inventory/dashboard-adjacent, no relay). Slice 2 = **Jason-led / co-owned** (SHARED `sceneTypes.ts` + editor-core + the standalone-tool mirror) — explicit heads-up + cross-owner review before edit; relay in the same change (discipline of #63/#71/#73). Slice 3 = SHARED `jobs` entity → **align with #83 first**.
- **Gates:** `npx tsc --noEmit` · `npm run lint` · `npm test` green before every commit; PR-not-master; a human approves each merge.

## 10. Open / deferred items

These do **not** block Slice 1 (most are config Naldo enters in the binding UI, or later-slice details):
- **Clip spacing constants** (clips/ft per feature) — config in `clipRules` (Slice 2 data).
- **Mini-string SKU** — define what one billed "string" = in stock (which mini-strand SKU, length, bulb count) for tree/bush/column/railing (Slice 2 binding).
- **Wreath/garland decor tier** — does Decorated (fullDecor) vs Non-Decorated (bow) bind to a different greenery SKU, or base SKU + a separate decor-component? (binding schema supports both; Naldo configures.)
- **Footage source for materials** — staff-entered QuoteInputs footage (authoritative for billing) vs design geometry. Clips *need* the design's per-run feature attr regardless; billing stays on QuoteInputs (Slice 2 decision).
- **Job entity reconciliation with #83** — one shared `jobs` schema (dedicated table vs fields-on-quotes) must be agreed by Naldo + Jason before Slice 3.
- **On-hand extra fields** (supplier/last-counted) — deferred; Thunder-only now.
- **Amazon/secondary supplier items** (timers etc.) — later.

## 11. Key source anchors

Scene/types `src/lib/design/sceneTypes.ts` · palette `src/components/design/editor-core/colors.ts` · schemes `src/lib/design/colorSchemes.ts` · projection `src/lib/design/projectScene.ts` · pricing `src/lib/pricing/pricingEngine.ts` · editor authoring `src/components/design/editor-core/editor.ts:2294-2317` · settings `src/lib/appSettings.ts` + `src/app/api/settings/route.ts` + `src/components/dashboard/SettingsSubNav.tsx` · inventory stub `src/app/inventory/page.tsx` · deposit webhook `src/app/api/integrations/valor/webhook/route.ts` · data-layer convention `src/lib/quotes.ts` + `src/lib/dashboard/` · migration template `migrations/2026-06-16-app-settings.sql` · supplier CSV `Downloads/2026 Thunder Lighting Spply Wholesale Price list.xlsx - Sheet1.csv`.
