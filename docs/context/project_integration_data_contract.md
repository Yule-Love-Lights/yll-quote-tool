---
name: project-integration-data-contract
description: "Data-contract spec for the design-tool ↔ quote-tool integration: scene storage + line-item ⇄ scene-item linkage. The keystone artifact Phase 1 builds from. v0.2 = build-ready after the design-tool review."
metadata: 
  node_type: memory
  type: project
  originSessionId: e4aa4be2-5f3b-45ef-ba10-c5884f1b5b20
---

# Integration Data Contract — line-item ⇄ scene-item linkage (v0.2, BUILD-READY)

> **Status: LOCKED / build-ready** (Session 3, 2026-06-05). Both pending confirmations resolved by Jason: **(1) Winter Wonderland** = just a name (Naldo's, from building the design tool) for **extra/custom C9 lights that don't fall under the Santa's or Gingerbread roof packages** — the green "C9" lines; footage-priced; model as `c9` strand + `surface:"winter-wonderland"` (Jason/Naldo may revisit the *name* later — not important now). **(2) Standalone bow IS a sellable product** (rare; sold on its own or on garland) — but the quote tool has **no bow line-item category today**, so for MVP it renders + produces no line item, with a **follow-up to add a `bow` line-item category** (ledger task). **NO implementation until Jason says go.** Prices owned by the QUOTE side (`BUSINESS_RULES`); the design never computes price. See [[project_integration]] for the broader plan.

## 1. The model, in one breath
The **scene is the canonical list of everything on the house.** Quote **line items are a derived projection** — of the scene (per-unit items) or of the **measurement** (roofline). Portal "What's Included" = **`included` flags on scene items + a roofline tier enum.**

## 2. Scope — the design tool is BROADER than the quote currently prices
The quote tool is **Christmas-only today** (no permanent lights, bistro, or poles — future, *not soon*). So design item types split:
- **Mapped (the Christmas set → project to line items):** C9 roofline (Santa's/Gingerbread), C9 Winter Wonderland, mini-light wraps (bush/tree/column), wreath, garland, spritzer.
- **Unmapped — RENDER but produce NO line item:**
  - *Intrinsically visual-only:* `text`, `custom`.
  - *Out-of-current-scope products (future, not soon):* `permanent`, `bistro`, `pole`. These get `surface` bindings + pricing **only when the quote tool adds those categories later** — no rework (forward-compatible).
  - *Sellable Christmas product the quote doesn't price YET:* **standalone `bow`** (rare; sold on its own or placed on garland). Renders + no line item for MVP; **follow-up = add a `bow` line-item category** to the pricing engine. (Bows inside wreaths / on garland are already priced via those items' `tier`/`withBow` — only a *standalone* bow needs the new category.)
- **Robustness requirement:** "scene item with no mapped surface" is a **first-class graceful case** — it renders, just produces no line item. The projection MUST NOT assume every strand maps to a category. (Later UX call: whether the Christmas-quote editor hides the perm/bistro/pole tools — default = available but unmapped.)

## 3. Storage (Supabase) — AMENDED 2026-06-05 (S4): design is INDEPENDENT
`designs(id, quote_id NULL → quotes ON DELETE SET NULL, photo_path, photo_w, photo_h, scene jsonb, created_at, updated_at)`
- **A design is its OWN record** (own `id`) with an **OPTIONAL** quote link (`quote_id` nullable). It's created when the Street View photo is pulled — BEFORE a quote is saved — and the link is set when the operator clicks **"Calculate Quote"**. *(Supersedes the original "keyed to a quote" model; enables design-before-save AND the future standalone no-quote site — Jason's call, S4. Design-tool AI agreed.)*
- **At most ONE design per LINKED quote** (partial unique index on `quote_id` WHERE NOT NULL); unlimited unlinked designs. Versioning later.
- **No `px_per_foot` column** — scale already lives in `scene.yardsticks`.
- `scene` jsonb = the design's existing `Scene` shape; core geometry read/written as-is.
- `photo_path` + `CustomItem.imagePath` become **Supabase Storage** references — private `designs` bucket, served via service-role **signed URLs** (not local `/photos`).
- Customer = the quote's HighLevel contact; the design tool's clients/projects hierarchy is dropped (Path B).
- **✅ BUILT (S4):** table + bucket live; `src/lib/designs.ts` + routes `POST /api/designs`, `GET|PUT /api/designs/[id]`, `POST /api/designs/[id]/photo`. These map 1:1 to the design-tool's proposed `EditorStorage` adapter (loadDesign=GET, saveScene=PUT, uploadPhoto=POST photo). Smoke-tested green end-to-end.

## 4. The binding — ADDITIVE optional fields on SceneItem
The scene jsonb is **not literally unchanged**: `SceneItem` gains additive *optional* fields (geometry untouched; the ported editor reads/writes core fields as-is):
- **`surface`** — the binding tag (the design's already-planned tag; **separate from `bulbType`**). Values = the surface taxonomy:
  `santas-roofline` (front edges) · `gingerbread` (the sides+ridge increment Gingerbread adds) · `winter-wonderland` · `bush` · `tree` · `column` · (future: perm/bistro surfaces) · absent/`null` = unmapped.
  e.g. Winter Wonderland = `surface:"winter-wonderland"` + `bulbType:"c9"`.
- **`included: boolean`** (default true) — portal selection state.
- **mini strands** (`surface` bush/tree/column): **`stringCount`** (default 1) + **`wrapStyle`** (canopy/trunk) — staff/AI-set, independent of the polyline.
- **garland**: **`lengthFt`** (seeded from drawn length × px_per_foot, but **editable** — keeps scale visual-only) + **`withBow?`** + **`tier`**.
- **wreath**: **`tier`** (`labor|bow|fullDecor`). (`withLights`/`withBow` seed the visual; `tier` drives price — see §6.)

## 5. The mapping table — (surface/kind) → category → priced quantity
| Scene item (surface · kind) | Line-item category | Priced quantity & SOURCE | Pricing rule |
|---|---|---|---|
| `santas-roofline` · strand(c9) | Roofline — **Santa's** (tier) | footage — **MEASUREMENT** (`santasFootage`) | footage × difficulty rate ($8/10/12) |
| `gingerbread` · strand(c9) | Roofline — **Gingerbread** superset (tier) | footage — **MEASUREMENT** (`gingerbreadFootage`) | (santas+ginger) × rate |
| `winter-wonderland` · strand(c9) | Winter Wonderland (C9) | footage — **MEASUREMENT** (`winterWonderlandFootage`) | footage × rate |
| `bush`/`tree`/`column` · strand(mini) | Mini-lights (per instance) | **stringCount + wrapStyle** (scene attrs) | stringCount × rate[wrapStyle] |
| spritzer | Spritzer (per instance) | **count** grouped by sizeIn | qty × rate[size] |
| wreath | Wreath (per instance) | **count** grouped by (sizeIn, tier) | price[size][tier] × qty |
| garland | Garland (per instance) | **count + lengthFt** → `ceil(lengthFt/9)` sections | price[length][tier] × qty |
| permanent / bistro / pole / text / custom / standalone bow | — (unmapped today) | — | no line item (see §2) |

## 6. Tier (wreath + garland) — explicit field, not derived
Quote tiers: `labor` (Labor Only) · `bow` (With Bow) · `fullDecor` (heavy ornament / ribbon / berries). Because **`fullDecor` means MORE than "lit + bow,"** tier can't be derived purely from `withLights`/`withBow` — so carry an **explicit `tier` field** on wreath + garland. The booleans seed the visual; `tier` drives the price. (A `fullDecor` item may look like `bow` visually until a fullDecor asset exists; pricing still reflects the tier.)

## 7. The two projection rules
- **Per-unit items → project from SCENE.** Group the **included** scene items of a category → compute priced quantity (instance count, an attribute like `stringCount`, or `lengthFt` for garland) → price via the book. Add/remove a mapped scene item ⇒ add/remove the line item.
- **Roofline → project from MEASUREMENT.** Price = `santasFootage`/`gingerbreadFootage`/`winterWonderlandFootage` (vision/manual), NOT scene pixels. The roofline strands are visual + toggle binding only. Scene + measurement co-derived from the same vision pass → born consistent; a visual tweak does NOT reprice (edit the measurement to reprice).

## 8. Roofline tier enum
`none | santas | gingerbread` — **already exists** as `QuoteResult.rooflineChoice`. Controls which roofline strands are `included`: `santas` → `santas-roofline`; `gingerbread` → `santas-roofline` + `gingerbread` (superset); `none` → none. Portal renders two mutually-exclusive rows bound to the enum (true since Phase 2). (Winter Wonderland is independent of this enum — its own `included` toggle.)

## 9. Portal selection state
= the set of **`included` scene items** + the **roofline tier enum**. Toggle a line item off ⇒ `included=false` on its scene item(s) ⇒ they vanish from the live render AND drop from price. The approval snapshot freezes it.

## 10. Reverse direction (builder edits)
Add a **mapped** scene item ⇒ line item appears (priced from the book); delete ⇒ removed. Add an **unmapped** item (text/custom/perm/bistro/pole/standalone-bow) ⇒ picture only, no quote change.

## 11. Non-pricing concerns
- **Scale:** `px_per_foot` (in `scene.yardsticks`) is VISUAL fidelity only, NOT pricing. Auto-set from the measurement (roofline ft ÷ pixel span); manual yardstick override.
- **Color:** per-item `colorId` (design already stores it) → future portal color selection; no price impact.

## 12. Resolved (Jason, 2026-06-05)
- **Winter Wonderland** = a name for **extra/custom C9 lights beyond the Santa's/Gingerbread roof packages** (the green "C9" lines), footage-priced. Model = `c9` strand + `surface:"winter-wonderland"`. (The *name* may be revisited with Naldo later — irrelevant to the contract.)
- **Standalone bow** = a **sellable product** (rare; on its own or on garland), but the quote tool has **no bow line-item category today** → unmapped for MVP (renders, no line item). **Follow-up:** add a `bow` line-item category to the pricing engine (ledger task). Bows in wreaths / on garland are already priced via those items' `tier`/`withBow`.

## Build status (was "NOT doing yet")
**Phase 1 SHIPPED (Session 4, merged PR #18):** the Supabase `designs` table + bucket, `src/lib/designs.ts`, the API routes (POST `/api/designs`, GET|PUT `/api/designs/[id]`, POST `/api/designs/[id]/photo` — map 1:1 to the `EditorStorage` adapter), and the embedded Konva editor (Option B). §3 amended (design = independent record + optional quote link). **Phase 2 IN PROGRESS** = portal live-design (Step 1 render → Step 2 toggle-filter → Step 3 projection). The **projection code** (scene→line-items) is still NOT built — that's Step 3, after the items model lands (Option-1+2 hybrid + the mini-light tool; see [[project_integration]]).
