# Stake Lighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new independent "Stake Lighting" lighting category that behaves exactly like Winter Wonderland / "C9s — Custom Runs" — manual footage × difficulty + satellite line-drawing, billed independently at its own $6/$7/$8 rates, with its own portal kind + icon, taggable in the design editor, and present on the training pages.

**Architecture:** Clone the existing `winter-wonderland` surface plumbing under a new `stake-lighting` surface tag and `stakeLighting*` identifiers. It is a measurement-driven category (footage × difficulty, NOT per-unit projected). The work is a sequence of type-widening waves: each shared-type widen (`Surface`, `QuoteInputs`, `QuoteFormData`, `PortalLineItemKind`) must land together with all its dependents + updated test fixtures so the tree typechecks at each commit.

**Tech Stack:** Next.js 16 + TypeScript, Vitest, a vendored Konva "editor-core", Supabase (Postgres). Reference implementation to mirror throughout: every `winterWonderland` / `'winter-wonderland'` / `c9` (satellite channel) touchpoint. Full layer map + decisions: `docs/superpowers/specs/2026-06-26-stake-lighting-design.md`.

**Mirror convention (used in every task):** for each Winter Wonderland touchpoint, add a parallel Stake Lighting one with these substitutions — surface `'winter-wonderland'`→`'stake-lighting'`; field `winterWonderlandFootage/Difficulty`→`stakeLightingFootage/Difficulty`; seed channel `winterWonderland`→`stakeLighting`; id prefix `ww`→`stake`; satellite channel `c9`→`stake`; label `Winter Wonderland – …`→`Stake Lighting – …`. **Differences from a pure mirror** (the parts that are NOT identical): own rate table `{easy:6,medium:7,hard:8}`; own portal kind `'stake-lighting'` + `Lightbulb` icon (WW reuses `'ridge'`); satellite color `#a855f7` (WW=`#10b981`).

**Before editing any file, grep for the real current code** — the spec's line numbers are a 2026-06-26 snapshot and may have drifted.

**Gates after each task:** `npx tsc --noEmit` · `npm run lint` · `npm test`. If `node_modules` is OneDrive-evicted and local gates can't run, the Vercel `next build` on the pushed branch is the gate (covers tsc+lint); note that in the commit.

---

## Task 1: Scene surface tag + seeding plumbing

**Files:**
- Modify: `src/lib/design/sceneTypes.ts` (the `Surface` union)
- Modify: `src/lib/design/seedRoofline.ts` (`RooflineSeedLines`, `ROOFLINE_SURFACES`, sanitize allowlist, `seedLinesHaveContent`, `seedRooflineStrands`)
- Modify: `src/lib/design/sceneToFewShot.ts` (skip branch)
- Test: `src/lib/design/seedRoofline.test.ts`

- [ ] **Step 1: Write the failing test.** In `seedRoofline.test.ts`, add a test mirroring the existing `winterWonderland` seeding test: seed `{ stakeLighting: [<one normalized polyline>] }` and assert `seedRooflineStrands` produces strand(s) with `surface: 'stake-lighting'`, `bulbType: 'c9'`, and an id starting with `stake`.

- [ ] **Step 2: Run it, verify it fails.** `npm test -- seedRoofline` → FAIL (`stakeLighting` not a known channel / no `'stake-lighting'` strands).

- [ ] **Step 3: Implement.**
  - `sceneTypes.ts`: add `| 'stake-lighting'` to the `Surface` union (next to `'winter-wonderland'`), with a comment `// independent stake-lighting runs`.
  - `seedRoofline.ts`: add `stakeLighting?: NormalizedPolyline[]` to `RooflineSeedLines`; add `'stake-lighting'` to the `ROOFLINE_SURFACES` Set; add `'stakeLighting'` to the sanitize-allowlist `as const` tuple; add `|| lines.stakeLighting?.length` to `seedLinesHaveContent`; in `seedRooflineStrands` add `...strandsFor(lines.stakeLighting, 'stake-lighting', 'stake', photoW, photoH)` next to the winterWonderland `strandsFor` call (reuses the same C9 bulb defaults).
  - `sceneToFewShot.ts`: in the c9-strand surface branch, add `'stake-lighting'` to the explicit SKIP path (same as `'winter-wonderland'` — no example slot).

- [ ] **Step 4: Run, verify pass.** `npm test -- seedRoofline` → PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(stake): add stake-lighting surface tag + seeding plumbing"`

---

## Task 2: Pricing engine — rates, inputs, billing

**Files:**
- Modify: `src/lib/pricing/pricingEngine.ts` (`BUSINESS_RULES.stakeLightingRates`, `QuoteInputs`, `calculateStakeLighting`, `restItems`)
- Modify (fixtures): `src/lib/pricing/pricingEngine.test.ts`, `src/lib/pricing/test.ts`, and EVERY other test/file that builds a `QuoteInputs` literal (grep `winterWonderlandFootage:` to find them all — widening `QuoteInputs` breaks each until updated)
- Modify: `src/components/quote/DesignSummary.tsx` (placeholder `QuoteInputs`)
- Test: `src/lib/pricing/pricingEngine.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `pricingEngine.test.ts`, mirroring "Winter Wonderland (C9) bills independently":
```ts
it('Stake Lighting bills independently at its own $6/$7/$8 rates', () => {
  const inputs = { ...baseInputs, stakeLightingFootage: 100, stakeLightingDifficulty: 'medium' as const };
  const result = calculateQuote(inputs);
  const line = result.lineItems.find(li => li.label.startsWith('Stake Lighting –'));
  expect(line).toBeTruthy();
  expect(line!.amount).toBe(700); // 100ft × $7 medium
});
```
(Use whatever the file's existing base-inputs helper is named; ensure it includes `stakeLightingFootage: 0, stakeLightingDifficulty: 'medium'`.)

- [ ] **Step 2: Run, verify fail.** `npm test -- pricingEngine` → FAIL (TS: `stakeLightingFootage` not on `QuoteInputs`).

- [ ] **Step 3: Implement.**
  - `BUSINESS_RULES`: add `stakeLightingRates: { easy: 6, medium: 7, hard: 8 },`.
  - `QuoteInputs`: add `stakeLightingFootage: number;` and `stakeLightingDifficulty: RooflineDifficulty;` after the winterWonderland pair.
  - Add the function (mirror `calculateWinterWonderland`, read the stake rate table):
```ts
function calculateStakeLighting(inputs: QuoteInputs): LineItem[] {
  if (inputs.stakeLightingFootage <= 0) return [];
  const rate = BUSINESS_RULES.stakeLightingRates[inputs.stakeLightingDifficulty];
  return [{
    label: `Stake Lighting – ${inputs.stakeLightingFootage}ft (${inputs.stakeLightingDifficulty})`,
    amount: Math.round(inputs.stakeLightingFootage * rate),
  }];
}
```
  - In `calculateQuote`, add `...calculateStakeLighting(inputs),` to the `restItems` spread next to `...calculateWinterWonderland(inputs)`.
  - Update EVERY `QuoteInputs` fixture (grep `winterWonderlandFootage:`) to also include `stakeLightingFootage: 0, stakeLightingDifficulty: 'medium'`. Same for the `DesignSummary.tsx` placeholder object.

- [ ] **Step 4: Run, verify pass.** `npm test -- pricingEngine` → PASS, and `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit.** `git commit -am "feat(stake): price Stake Lighting at $6/$7/$8 per ft, billed independently"`

---

## Task 3: Form bridge

**Files:**
- Modify: `src/lib/quoteForm.ts` (`QuoteFormData`, `initialFormData`, `buildQuoteInputs`, `inputsToFormData`)
- Modify (fixtures): `src/lib/quoteForm.test.ts` and any other `QuoteFormData` literal (grep)
- Test: `src/lib/quoteForm.test.ts`

- [ ] **Step 1: Write the failing test.** Add a round-trip assertion: a `QuoteFormData` with `stakeLightingFootage: 80, stakeLightingDifficulty: 'hard'` → `buildQuoteInputs` carries both → `inputsToFormData` restores both.

- [ ] **Step 2: Run, verify fail.** `npm test -- quoteForm` → FAIL.

- [ ] **Step 3: Implement.** Add `stakeLightingFootage: number;` + `stakeLightingDifficulty: RooflineDifficulty;` to `QuoteFormData`; default `0` / `'medium'` in `initialFormData`; pass through in `buildQuoteInputs`; hydrate `i.stakeLightingFootage ?? 0` / `i.stakeLightingDifficulty ?? 'medium'` in `inputsToFormData`.

- [ ] **Step 4: Run, verify pass.** `npm test -- quoteForm` → PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(stake): thread Stake Lighting through the quote form bridge"`

---

## Task 4: API validation

**Files:**
- Modify: `src/app/api/quote/route.ts` (`footageFields`, `difficultyFields`)

- [ ] **Step 1: Implement.** Add `'stakeLightingFootage'` to the `footageFields` `as const` tuple and `'stakeLightingDifficulty'` to `difficultyFields`. (`VALID_DIFFICULTIES` unchanged.)

- [ ] **Step 2: Typecheck.** `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit.** `git commit -am "feat(stake): validate Stake Lighting fields on the quote API"`

---

## Task 5: Portal kind + icon + linking

**Files:**
- Modify: `src/components/portal/types.ts` (`PortalLineItemKind`)
- Modify: `src/lib/portal/lineItemKind.ts` (`STAKE_RE` + cascade)
- Modify: `src/components/portal/dark/WhatsIncluded.tsx` (`ICONS` Record + `Lightbulb` import)
- Modify: `src/lib/portal/sceneLinks.ts` (`stakeIds` + branch)
- Modify: `src/lib/portal/adapter.ts` (comment only)
- Modify: `src/components/quote/QuoteBuilder.tsx` (`RECOMMENDABLE_KINDS`)
- Test: `src/lib/portal/lineItemKind.test.ts`, `src/lib/portal/sceneLinks.test.ts`

- [ ] **Step 1: Write failing tests.**
  - lineItemKind: `parseLineItem('Stake Lighting – 50ft (medium)')` → `{ kind: 'stake-lighting', … }`.
  - sceneLinks: a portal line with `kind: 'stake-lighting'` gets `sceneItemIds` = the ids of scene strands tagged `'stake-lighting'`.

- [ ] **Step 2: Run, verify fail.** `npm test -- lineItemKind sceneLinks` → FAIL.

- [ ] **Step 3: Implement.**
  - `types.ts`: add `| 'stake-lighting'` to `PortalLineItemKind`.
  - `lineItemKind.ts`: add `const STAKE_RE = /Stake Lighting/i;` and, in the order-sensitive `parseLineItem` cascade, a branch BEFORE the roofline fallback: `if (STAKE_RE.test(label)) return { kind: 'stake-lighting', detail: extractFootage(label) };`. Add a `"Stake Lighting – 50ft (medium)"` line to the doc comment.
  - `WhatsIncluded.tsx`: import `Lightbulb` from `lucide-react`; add `'stake-lighting': Lightbulb,` to the exhaustive `ICONS` Record (compiler will demand it).
  - `sceneLinks.ts`: add `const stakeIds = idsForSurface('stake-lighting');` + a `stakeRecommended` scan (mirror the WW `recommended` scan), and a branch `if (li.kind === 'stake-lighting') return { ...li, sceneItemIds: stakeIds, recommended: stakeRecommended };` parallel to the WW handling. Leave the "remaining ridge = WW" logic untouched (Stake has its own kind, so no collision). Update the doc comment.
  - `adapter.ts`: no logic change to `isBilledRoofline` (a "Stake Lighting" label matches neither `/Roofline/i` nor `/Gingerbread/i`); update its comment to note Stake survives as an independent line item like WW.
  - `QuoteBuilder.tsx`: add `'stake-lighting'` to the `RECOMMENDABLE_KINDS` Set.

- [ ] **Step 4: Run, verify pass.** `npm test -- lineItemKind sceneLinks` → PASS; `npx tsc --noEmit` clean (the `ICONS` Record now exhaustive).

- [ ] **Step 5: Commit.** `git commit -am "feat(stake): own portal kind + Lightbulb icon + scene linking"`

---

## Task 6: Satellite line-drawing (design + portal)

**Files:**
- Modify: `src/lib/designs.ts` (`DesignSatelliteLines.stake`)
- Modify: `src/app/api/designs/[id]/route.ts` (`isSatelliteLinesShape` — accept optional `stake[]`)
- Modify: `src/components/portal/types.ts` (`PortalSatelliteLines.stake`)
- Modify: `src/lib/portal/satelliteLines.ts` (`SatelliteLineGroup.key` + group entry, color `#a855f7`)
- Modify: `src/components/portal/dark/SatelliteRoofView.tsx` (comment only; maps over groups)
- Modify: `src/components/quote/QuoteBuilder.tsx` (`satelliteStakeLines` state, `LineType`/addMode `'stake'`, footage-derivation effect, render, "+ Add Stake Run" button, PUT body channel)
- Test: `src/lib/portal/satelliteLines.test.ts`

- [ ] **Step 1: Write the failing test.** In `satelliteLines.test.ts`, assert the groups output includes `{ key: 'stake', color: '#a855f7', label: 'Stake Lighting', lines: [...] }` when given `{ stake: [<one line>] }`.

- [ ] **Step 2: Run, verify fail.** `npm test -- satelliteLines` → FAIL.

- [ ] **Step 3: Implement (data layer first).**
  - `designs.ts`: add `stake: { points: …; label?: … }[]` to `DesignSatelliteLines` (mirror the `c9` channel shape).
  - `designs/[id]/route.ts` `isSatelliteLinesShape`: accept `stake` but make it OPTIONAL — e.g. `(o.stake === undefined || Array.isArray(o.stake))` — so existing designs' PUTs don't 400. Update the error message.
  - `portal/types.ts`: add `stake: PortalSatelliteLine[];` to `PortalSatelliteLines`.
  - `satelliteLines.ts`: add `'stake'` to `SatelliteLineGroup.key` and push the group `{ key: 'stake', color: '#a855f7', label: 'Stake Lighting', lines: lines.stake ?? [] }`.

- [ ] **Step 4: Implement (builder UI).** In `QuoteBuilder.tsx`, mirror the existing C9 satellite-line plumbing: `satelliteStakeLines` state + setter; add `'stake'` to the `LineType`/`addMode` union (and the getSetter/dragging branches); a footage-derivation effect that writes the summed polyline length to `form.stakeLightingFootage`; reset-on-new-photo; the polyline render + draggable point handles using stroke `#a855f7`; a **"+ Add Stake Run"** button + addMode help copy; add a `stake` array to the Calculate PUT `satelliteLines` body.

- [ ] **Step 5: Run, verify pass.** `npm test -- satelliteLines` → PASS; `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit.** `git commit -am "feat(stake): satellite 'Add Stake Run' draw tool + portal overlay (purple)"`

---

## Task 7: Builder manual "Stake Lighting" section

**Files:**
- Modify: `src/components/quote/QuoteBuilder.tsx` (new `<Section title="Stake Lighting">` + `stakeLighting: []` analysis seed)

- [ ] **Step 1: Implement.** Clone the `<Section title="C9s — Custom Runs">` block into a new `<Section title="Stake Lighting">` bound to `form.stakeLightingFootage` / `form.stakeLightingDifficulty`, with the same opacity-dim-when-0 wrapper and "Footage is 0 — not included" note. Difficulty `<select>` options: `Easy — $6/ft` / `Medium — $7/ft` / `Hard — $8/ft`. Helper text: `Enter manually — staked ground runs.` Also add `stakeLighting: []` to the `AnalysisSeed` seed-lines object near the existing `winterWonderland: []`.

- [ ] **Step 2: Typecheck + manual sanity.** `npx tsc --noEmit` clean. Section renders, footage flows to the quote total.

- [ ] **Step 3: Commit.** `git commit -am "feat(stake): manual Stake Lighting footage+difficulty section in the builder"`

---

## Task 8: Training pages + migration

**Files:**
- Create: `migrations/2026-06-26-add-stake-lighting-training.sql`
- Modify: `src/lib/training.ts` (`TrainingHousePayload`, `StoredTrainingHouse`, insert mapping)
- Modify: `src/app/training/new/page.tsx` (state, derivation, payload, "Stake ft"/"Stake Difficulty" inputs, "+ Add Stake Run" draw)
- Modify: `src/lib/trainingExamples.ts` (`TrainingExampleInputs` + spread)
- Modify: `src/app/training/examples/page.tsx` (`· Stake {ft} ft` render)

- [ ] **Step 1: Write the migration file.**
```sql
-- Stake Lighting on training_houses: parallel of the winter_wonderland_* columns.
ALTER TABLE training_houses
  ADD COLUMN IF NOT EXISTS stake_lighting_footage    numeric(10,2),
  ADD COLUMN IF NOT EXISTS stake_lighting_difficulty text,
  ADD COLUMN IF NOT EXISTS stake_lines               jsonb;
```
(Confirm `winter_wonderland_*` column types in the live schema and match them.)

- [ ] **Step 2: Implement code.**
  - `training.ts`: add `stakeLightingFootage?`/`stakeLightingDifficulty?`/`stakeLines?` to `TrainingHousePayload`; `stake_lighting_footage`/`stake_lighting_difficulty`/`stake_lines` to `StoredTrainingHouse`; map them in the `.insert({…})` (mirror the winter_wonderland / c9_lines mapping).
  - `training/new/page.tsx`: add `stakeFootage`/`stakeDifficulty`/`stakeLines` state, derivation effect, payload fields, manual "Stake ft" + "Stake Difficulty" inputs, and the "+ Add Stake Run" draw (mirror the C9 path on that page; reuse `#a855f7`).
  - `trainingExamples.ts`: add `stakeLightingFootage?` to `TrainingExampleInputs` + the conditional spread.
  - `training/examples/page.tsx`: add `· Stake {ft} ft` conditional render.

- [ ] **Step 3: Typecheck.** `npx tsc --noEmit` clean.

- [ ] **Step 4: Commit.** `git commit -am "feat(stake): Stake Lighting on training pages + migration"`

> ⚠️ **Migration is a deploy-order hazard.** If `listTrainingHouses`/the training read selects the new columns, prod auto-deploys `master` and a missing column errors the query → apply the SQL in Supabase BEFORE merging. Surface this in the PR + to Naldo.

---

## Task 9: Editor-core tag option + relay note

**Files:**
- Modify: `src/components/design/editor-core/editor.ts` (`surfaceOpts` c9-branch)
- Modify: `docs/context/task_ledger.md` (relay callout)

- [ ] **Step 1: Implement.** In the c9-branch `surfaceOpts` tuple array add `['stake-lighting', 'Stake Lighting']` so staff can tag a drawn C9 strand to Stake Lighting. Do NOT add a bulb type.

- [ ] **Step 2: Relay callout.** Add a ⚠️ note to `task_ledger.md` (mirroring the Cool White relay note): the standalone design tool must mirror the `Surface` union `'stake-lighting'` member + the `['stake-lighting','Stake Lighting']` surfaceOpts entry (and the `#a855f7` satellite channel if it touches the shared scene shape). Add a one-line `// RELAY: mirror into the standalone design tool` comment at the editor.ts edit site.

- [ ] **Step 3: Typecheck.** `npx tsc --noEmit` clean.

- [ ] **Step 4: Commit.** `git commit -am "feat(stake): editor tag option for Stake Lighting + design-tool relay note"`

---

## Task 10: Full gate, docs, PR

- [ ] **Step 1: Full gates.** `npx tsc --noEmit` · `npm run lint` · `npm test` all green (or, if `node_modules` evicted, rely on the Vercel build — note it).
- [ ] **Step 2: Update `docs/context/session_log_naldo.md`** with the Stake Lighting entry (Naldo's log only).
- [ ] **Step 3: Push + open PR** flagged **Jason-review** (his area + SHARED `sceneTypes.ts`). Include in the PR body: the migration SQL + the "apply before merge" warning, and the design-tool relay note.
- [ ] **Step 4: Verify-before-merge.** Confirm the Vercel preview build is green; give Naldo the preview URL + test steps (build a quote with a Stake Lighting footage + draw a stake run on satellite → see the line item + price on the portal with the Lightbulb icon + the purple satellite overlay). Wait for Naldo's "merge."

---

## Self-review notes

- **Spec coverage:** every §3 layer maps to a task — scene types/seeding (T1), pricing (T2), form (T3), API (T4), portal kind/icon/links (T5), satellite (T6), builder manual (T7), training+migration (T8), editor+relay (T9), gates/PR (T10). Settings = intentionally no task (inherits c9 bulb type).
- **Type-cascade ordering:** `Surface` (T1) → `QuoteInputs` (T2) → `QuoteFormData` (T3) → `PortalLineItemKind` (T5) each widen with their dependents + fixtures in the same task, so the tree typechecks per commit.
- **Identifier consistency:** `stakeLightingFootage`/`stakeLightingDifficulty` (inputs/form), `'stake-lighting'` (surface + portal kind), `stakeLighting` (seed channel), `stake` (satellite channel + id prefix), `stake_lighting_*`/`stake_lines` (DB) — used consistently across all tasks.
- **Non-mirror deltas verified present:** rate table $6/$7/$8 (T2), own portal kind + `Lightbulb` (T5), satellite color `#a855f7` (T6).
