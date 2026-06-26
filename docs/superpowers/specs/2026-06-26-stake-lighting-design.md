# Stake Lighting — design spec

**Date:** 2026-06-26 · **Author:** Naldo (owner-directed) · **Area:** Jason's (pricing, quote builder, portal, editor-core, training) + one SHARED file (`sceneTypes.ts`) · **Branch:** `naldo/stake-lighting` · **Review:** Jason-review, merge on Naldo's go.

> **Goal:** add a brand-new **independent** lighting category called **"Stake Lighting"** that behaves **exactly** like the existing "Winter Wonderland" / "C9s — Custom Runs" category — but as a parallel sibling, not part of it. It must appear everywhere C9s — Custom Runs appears: the quote builder (manual entry **and** satellite line-drawing), the customer portal, the design editor (+ a relay to the standalone design tool), and the training pages.

> **Staleness caveat:** the file/line references below come from a point-in-time code map (2026-06-26). Treat them as a guide — **verify each against the live code before editing** (grep for the identifier), since the codebase moves.

---

## 1. Locked decisions (from Naldo)

| Decision | Choice |
|---|---|
| **Pricing** | Its **own** rates: **Easy $6 / Medium $7 / Hard $8** per linear foot (not the $8/$10/$12 roofline table). |
| **Scope** | Manual footage+difficulty entry **AND** on-photo satellite line-drawing (auto-derives footage). |
| **Portal** | Its **own** line-item kind + dedicated icon — fully independent from Winter Wonderland. |
| **Training** | **Included** on `/training/new` (footage + difficulty + draw lines) → requires a small DB migration. |
| **AI auto-detect** | **No** — manual-only, exactly like Winter Wonderland (excluded from the few-shot). |
| **Settings page** | **No change** — Stake reuses the existing `c9` bulb type, so it inherits all bulb settings. |

**New identifiers (parallel to Winter Wonderland):**
- Surface tag literal: `'stake-lighting'`
- Quote input fields: `stakeLightingFootage`, `stakeLightingDifficulty`
- Engine / portal line-item label: `` `Stake Lighting – ${ft}ft (${difficulty})` `` — **must not contain** the words Wonderland / Roofline / Gingerbread / Ridge (those mis-parse).
- Seed-line channel (camelCase): `stakeLighting`
- Scene-strand id prefix: `stake`
- Satellite channel key: `stake`
- Portal kind: `'stake-lighting'`
- Portal icon: **`Lightbulb`** (lucide; tunable)
- Satellite overlay color: **`#a855f7`** (purple — distinct from santas `#ef4444`, gingerbread `#3b82f6`, c9 `#10b981`; tunable)
- Training DB columns (snake_case): `stake_lighting_footage`, `stake_lighting_difficulty`, `stake_lines`

---

## 2. How Winter Wonderland works today (the thing we're cloning)

- **One surface literal** `'winter-wonderland'` in the `Surface` union (`src/lib/design/sceneTypes.ts`). Strands tagged with it are **C9 bulbs** (`bulbType: 'c9'`) — the bulb type is orthogonal to the surface/category.
- **Billed independently:** `calculateWinterWonderland(inputs)` emits one line item priced `footage × rate`, spread into `restItems`, so it never collides with the mutually-exclusive Santa's/Gingerbread roofline choice. `isBilledRoofline()` explicitly excludes it.
- **Measurement-driven, NOT projected:** it is footage × difficulty, not per-unit. `projectScene` deliberately skips it; it is **not** a `ProjectedCategory`.
- **Portal kind today = `'ridge'` (reused):** the label matches `RIDGE_RE = /(Gingerbread|Ridge|Wonderland)/i`. **Stake Lighting will get its own kind instead** (Naldo's choice), so it does NOT reuse `'ridge'`.
- **Manual-only:** the analysis seed hardcodes `winterWonderland: []`; the few-shot exporter skips `'winter-wonderland'` strands. Stake Lighting matches (skip path).
- **Storage split:** a quote stores `winterWonderland*` inside the `inputs` JSON blob → **no quote migration**. The training table uses **real columns** → training needs an `ALTER TABLE`.

---

## 3. Change-list by layer

> **The can't-miss list of type-lists/unions/regexes that must gain the new value** (TS will error or behavior silently breaks if any is skipped): `Surface` union · `QuoteInputs` · `QuoteFormData` · `initialFormData` · `buildQuoteInputs` · `inputsToFormData` · `restItems` spread · `footageFields` · `difficultyFields` · `RooflineSeedLines` · `ROOFLINE_SURFACES` Set · the `['santas','gingerbread','winterWonderland']` sanitize allowlist · `seedLinesHaveContent` OR-chain · `strandsFor` calls · `STAKE_RE` (new) + `parseLineItem` cascade · `PortalLineItemKind` union · `ICONS: Record<PortalLineItemKind,…>` (compiler-enforced) · `RECOMMENDABLE_KINDS` Set · `sceneLinks` branch · editor-core `surfaceOpts` c9-branch · satellite: `LineType`, `DesignSatelliteLines`, `PortalSatelliteLines`, `SatelliteLineGroup.key`, `isSatelliteLinesShape` guard · training: `TrainingHousePayload`, `StoredTrainingHouse`, `TrainingExampleInputs` · every test fixture building `QuoteInputs`/`QuoteFormData`.

### 3.1 Scene types — SHARED FILE (heads-up to Jason)
- `src/lib/design/sceneTypes.ts` — add `| 'stake-lighting'` to the `Surface` union. Root of everything below.

### 3.2 Pricing engine (`src/lib/pricing/pricingEngine.ts`)
- `BUSINESS_RULES`: add `stakeLightingRates: { easy: 6, medium: 7, hard: 8 }`.
- `QuoteInputs`: add `stakeLightingFootage: number;` + `stakeLightingDifficulty: RooflineDifficulty;` (after the WW pair). `RooflineDifficulty` (easy/medium/hard) is reused.
- Add `calculateStakeLighting(inputs)`: returns `[]` when `stakeLightingFootage <= 0`, else one `LineItem` `{ label: `Stake Lighting – ${ft}ft (${difficulty})`, amount: Math.round(ft * BUSINESS_RULES.stakeLightingRates[difficulty]) }`. (Mirror `calculateWinterWonderland`, but read the **stake** rate table.)
- `calculateQuote`: add `...calculateStakeLighting(inputs)` to the `restItems` spread (the only sum site).

### 3.3 Form bridge (`src/lib/quoteForm.ts` + `DesignSummary.tsx`)
- `QuoteFormData`: add the two fields. `initialFormData`: `stakeLightingFootage: 0`, `stakeLightingDifficulty: 'medium'`.
- `buildQuoteInputs`: pass them through. `inputsToFormData`: hydrate with `?? 0` / `?? 'medium'` legacy defaults.
- `src/components/quote/DesignSummary.tsx`: add the two fields to its placeholder `QuoteInputs` object (else TS errors once the interface widens).

### 3.4 API validation (`src/app/api/quote/route.ts`)
- Add `'stakeLightingFootage'` to `footageFields`; `'stakeLightingDifficulty'` to `difficultyFields`. `VALID_DIFFICULTIES` unchanged.

### 3.5 Portal kind, icon, projection, linking
- `src/components/portal/types.ts`: add `| 'stake-lighting'` to `PortalLineItemKind`.
- `src/lib/portal/lineItemKind.ts`: add `const STAKE_RE = /Stake Lighting/i;` and a branch in the order-sensitive `parseLineItem` cascade **before** the roofline fallback → `{ kind: 'stake-lighting', detail: extractFootage(label) }`. Add a `"Stake Lighting – 50ft (medium)"` example to the doc comment. **Order matters** — place STAKE_RE so it can't be shadowed.
- `src/components/portal/dark/WhatsIncluded.tsx`: add `'stake-lighting': Lightbulb` (import `Lightbulb` from lucide) to the exhaustive `ICONS: Record<PortalLineItemKind, …>` map (compiler-enforced — this WILL error until added).
- `src/lib/portal/adapter.ts`: `isBilledRoofline()` needs **no logic change** (a "Stake Lighting" label matches neither `/Roofline/i` nor `/Gingerbread/i`, so it survives as an independent line item like WW). Update its comment to mention Stake Lighting.
- `src/lib/portal/sceneLinks.ts`: add `const stakeIds = idsForSurface('stake-lighting');` + a `stakeRecommended` scan, and an `if (li.kind === 'stake-lighting') return { …sceneItemIds: stakeIds, recommended: stakeRecommended }` branch (parallel to the WW handling). Because Stake has its **own** kind, the existing "remaining `ridge` = WW" logic is untouched and stays unambiguous. `KIND_TO_CATEGORY` needs **no** entry (measurement-driven, not projected).
- `src/lib/design/projectScene.ts`: **no code change** — `'stake-lighting'` is not a `MiniSurface`, so `asMiniSurface` returns null and it's correctly skipped (not projected). Do **not** add it to `ProjectedCategory`. Update the skip comment.
- `src/components/quote/QuoteBuilder.tsx` `RECOMMENDABLE_KINDS`: add `'stake-lighting'` so its breakdown row gets a Recommended checkbox.

### 3.6 Satellite line-drawing (the "+ Add Stake Run" tool)
Mirror the existing C9 satellite-line plumbing under a new `stake` channel, color `#a855f7`:
- `src/components/quote/QuoteBuilder.tsx`: add `satelliteStakeLines` state + setter; extend the `LineType`/`addMode` union with `'stake'`; a footage-derivation effect → `form.stakeLightingFootage`; reset-on-new-photo; the new stroke color + polyline render + draggable point handles; a **"+ Add Stake Run"** button + addMode help copy; add a `stake` channel to the Calculate PUT `satelliteLines` body.
- `src/lib/designs.ts`: add a `stake: { points; label }[]` channel to `DesignSatelliteLines`.
- `src/app/api/designs/[id]/route.ts`: in `isSatelliteLinesShape()` accept `stake[]` but keep it **OPTIONAL** (don't hard-require, or existing designs' PUTs 400). Update the error string.
- `src/components/portal/types.ts`: add `stake: PortalSatelliteLine[]` to `PortalSatelliteLines`.
- `src/lib/portal/satelliteLines.ts`: extend `SatelliteLineGroup.key` and push `{ key: 'stake', color: '#a855f7', label: 'Stake Lighting', lines: lines.stake ?? [] }`.
- `src/components/portal/dark/SatelliteRoofView.tsx`: maps over groups — **no code change** (legend picks up the new group automatically); update the comment.

### 3.7 Seeding
- `src/lib/design/seedRoofline.ts`: add `stakeLighting?: NormalizedPolyline[]` to `RooflineSeedLines`; add `'stake-lighting'` to `ROOFLINE_SURFACES`; add `'stakeLighting'` to the sanitize allowlist tuple; add `|| lines.stakeLighting?.length` to `seedLinesHaveContent`; add `...strandsFor(lines.stakeLighting, 'stake-lighting', 'stake', photoW, photoH)` to `seedRooflineStrands` (reuses the C9 bulb defaults).
- `src/components/quote/QuoteBuilder.tsx` (~analysis seed): add `stakeLighting: []` to the `AnalysisSeed` seed-lines object (mirroring `winterWonderland: []`).
- `src/lib/design/seedFromAnalysis.ts`: **no edit** — `AnalysisSeed.lines` is `RooflineSeedLines`, so the new key flows through once added.
- `src/lib/design/sceneToFewShot.ts`: add `'stake-lighting'` to the **skip** path in the c9-strand surface branch (manual-only — no example slot, matching WW).
- `src/app/api/designs/[id]/seed-roofline/route.ts` + `seed-analysis/route.ts`: no code change (delegate to `sanitizeSeedLines`); update the doc comments to list `stakeLighting`.

### 3.8 Editor-core + design-tool relay
- `src/components/design/editor-core/editor.ts`: in the **c9-branch** `surfaceOpts` tuple array add `['stake-lighting', 'Stake Lighting']` so staff can tag a drawn C9 strand to Stake Lighting. **Do not** add a new bulb type — Stake reuses `c9`.
- **RELAY (Jason):** `editor.ts` is the vendored mirror of the standalone Konva design tool (`docs/design-tool-context/`; live repo `C:\Users\Jason\Desktop\YuleLoveLights\Claude`). Mirror into the standalone tool, byte-parallel: (a) the `'stake-lighting'` member of the `Surface` union, (b) the `['stake-lighting','Stake Lighting']` `surfaceOpts` entry, and (c) **if** the satellite channel/color touches the shared scene shape, the same channel key + hex. Bulb-type registry, pricing, form, API, training are quote-tool-only (not relayed). **I'll do the quote-tool side and leave a relay note/callout for Jason** (I can't edit the external app from here — same pattern as the Cool White relay).

### 3.9 Training (`/training/new`) + migration
- `src/lib/training.ts`: add `stakeLightingFootage?` / `stakeLightingDifficulty?` (and `stakeLines?`) to `TrainingHousePayload`; `stake_lighting_footage` / `stake_lighting_difficulty` (+ `stake_lines`) to `StoredTrainingHouse`; map them in the `.insert({…})`.
- `src/app/training/new/page.tsx`: add `stakeFootage` / `stakeDifficulty` (+ `stakeLines`) state, the footage-derivation effect, payload fields, and manual **"Stake ft" / "Stake Difficulty"** inputs + the "+ Add Stake Run" draw tool — mirroring the C9 capture path on that page.
- `src/lib/trainingExamples.ts`: add `stakeLightingFootage?` to `TrainingExampleInputs` + the conditional spread (kept symmetrical with WW even though it's not fed to the AI).
- `src/app/training/examples/page.tsx`: add a `· Stake {ft} ft` conditional render.

### 3.10 Settings — none
`src/lib/settings/toolDefaults.ts` + the editor bulb registry are per **bulb type**, not per surface. Stake reuses `c9`, so settings are inherited unchanged. **Nothing to add.**

### 3.11 Tests (will fail to typecheck until updated)
Every fixture building `QuoteInputs`/`QuoteFormData` gets `stakeLightingFootage: 0, stakeLightingDifficulty: 'medium'`. Touch at least: `pricingEngine.test.ts`, `pricing/test.ts`, `quoteForm.test.ts`, `seedRoofline.test.ts`, `sceneToFewShot.test.ts`, `projectScene.test.ts`, `seedFromAnalysis.test.ts`, `sceneLinks.test.ts`, `adapter.test.ts`, `satelliteLines.test.ts`, `trainingExamples.test.ts`. Specifically add `'stake-lighting'` to the `it.each<Surface>([...])` in `projectScene.test.ts`. **New tests:** a pricing test (Stake bills `ft × 6/7/8` independently, lands in `restItems`); a seedRoofline test (the `stakeLighting` channel → `'stake-lighting'` strands); a sceneLinks test (a `stake-lighting` line attaches `stakeIds`); a lineItemKind test (`"Stake Lighting – 50ft (medium)"` → kind `'stake-lighting'`).

### 3.12 False positives — do NOT touch (shared infra)
The `c9` **bulb type** (`editor.ts`, `toolDefaults.ts`), marketing "C9" copy (`mockQuote.ts`, `inventory/page.tsx`), and hex colors `#86C9A0`/`#C9C0AA`. None are the WW category.

---

## 4. Migration (training side only)

Quote side: **no migration** (rides the `inputs` JSON blob).

Training side (`training_houses` uses real columns):

```sql
-- Stake Lighting on training_houses: parallel of the winter_wonderland_* columns.
ALTER TABLE training_houses
  ADD COLUMN IF NOT EXISTS stake_lighting_footage    numeric(10,2),
  ADD COLUMN IF NOT EXISTS stake_lighting_difficulty text,
  ADD COLUMN IF NOT EXISTS stake_lines               jsonb;
```

Naldo applies this via the browser SQL editor (the service-role key can't run DDL). **Apply BEFORE merge** if `listTrainingHouses`/the insert select these columns (a missing column errors the query). Confirm `winter_wonderland_*` column types before finalizing so we match. Do **not** add columns to the legacy `photo_corrections` table (being dropped).

---

## 5. Process / ownership / gates

- **Branch:** `naldo/stake-lighting` off fresh `origin/master`. **PR flagged Jason-review** (his area + the SHARED `sceneTypes.ts` file → heads-up to Jason first). **Merge on Naldo's go.**
- **Gates:** `npx tsc --noEmit` · `npm run lint` · `npm test` green before commit. If local `node_modules` is OneDrive-evicted, the **Vercel `next build`** preview is the gate (covers tsc + lint); restore `node_modules` (`npm install`) if vitest must run locally.
- **Relay:** leave a `task_ledger` callout + an inline `editor.ts` comment for Jason to mirror the surfaceOpts/Surface change into the standalone design tool (I can't edit it from here).
- **Verify-before-merge:** push → Vercel preview → give Naldo clickable portal/builder URLs + test steps → he verifies → he says merge.

---

## 6. Non-goals (v1)

- No AI auto-detection of stake runs (manual-only; few-shot skip — same as WW).
- No Settings-page changes (inherits the `c9` bulb type).
- No new bulb type (reuses `c9`).
- No change to the Santa's/Gingerbread mutually-exclusive roofline logic (Stake is independent, like WW).
