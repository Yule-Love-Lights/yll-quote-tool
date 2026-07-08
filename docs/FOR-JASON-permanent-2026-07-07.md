# For Jason: finish the Permanent Lighting bug-batch (PR #436)

Naldo ran the permanent #88 punch-list this session (S28) and asked me to hand it to you to finish, because the remaining pieces live in your areas (the quote builder, the design editor-core, the analyze routes) and you know their internals better.

**Branch:** `naldo/permanent-fixes` · **PR:** #436 · **base:** master `04cd147` · **9 commits, NOT merged.**
**Gates at close:** tsc 0 · eslint 0 errors · vitest 2335 · `/quote/new` compiles.

## What shipped on the branch (all gated, none merged)

1. **All 4 sides from the design.** `applyPermanentProjection` in `src/lib/permanent/projectPermanent.ts` (pure, tested). "Refresh from design" in `PermanentSection.tsx` now fills front/left/right/back footage + corners, not front-only.
   - **The subtle bit:** a new per-side `sideSource` on `PermanentQuoteFields` ('auto' vs 'manual'). Refresh overwrites 'auto' sides (INCLUDING clearing a side whose design run was deleted, so no stale over-bill) but preserves 'manual' (operator/satellite-typed) sides. A hand-typed side field marks that side 'manual'. This was a real HIGH the review caught in v1 (my first cut used `footage>0` as the signal, which left stale footage billing after a run was deleted).
2. **8-inch spacing lock** (`editor.ts` SPACINGS + `toolDefaults.ts`), plus a clamp in `applyDefaultsForCurrentType` so a stale saved settings default (e.g. legacy 6") can't override the locked 8". **Beam-length slider max 12→20 ft.** **Beam toggle** — new `showBeam` on the strand (per-strand + Settings default), mirroring `showCoverage`; off = puck dots only, `createPermanentLight` skips the cone.
3. **Permanent design walled off from holiday.** `renderEditor` gained `permanentOnly` (threaded from `DesignEditor`): the palette shows only the Permanent bulb type and hides c9/mini/bistro + the Decor/Text/Custom/Poles categories. Permanent skips the holiday analyzer + seed. All ridge/holiday copy is service-type-gated. The satellite tab's holiday roofline measurement (Add Ridge/Side buttons, Front Gutterline / Ridge + Sides panels, the "Verify the roof outline" banner, the "ridge+sides" footage chip) and the "From your design" billable-items summary (`DesignSummary`) are hidden for permanent. **Event keeps all of it** (event prices the roofline) — the gates are `!== 'permanent'`, not `=== 'holiday'`.
4. **Permanent AI analyzer.** `src/lib/permanent/photoAnalysis.ts` (`analyzePermanentPhoto`, +29 unit tests). Wired into `analyze-address` + `analyze-photo` routes for `serviceType==='permanent'`, and `applyPermanentAnalysis` in `QuoteBuilder.tsx` fills the Permanent section: **front from Street View, left/right/back from the satellite**, gaps (with a derivable length) → extension rows, all marked `sideSource:'manual'` so a later Refresh can't wipe them. Fail-safe: analyzer down → imagery-only load, measure manually.

## What's LEFT for you (Naldo's ask)

1. **Device-check the permanent AI accuracy on 2-3 real houses.** Neither Naldo nor I could run the AI (no ANTHROPIC/Google creds in the worktree). The auto-filled footage is editable (same trust model as the holiday analyzer), but nobody has seen its numbers on a real house yet. **This is the #1 thing before relying on it.** Tune the prompt in `photoAnalysis.ts` if it's off.
2. **Draw the traced runs on the design canvas.** Naldo confirmed he wants the runs drawn (not just the numbers). I did numbers-first (safe money order) and left drawing for you because it needs the deeper change: extend `seedSceneFromAnalysis` (`src/lib/design/seedFromAnalysis.ts`) to draw **permanent** strands (bulbType 'permanent', `sideOfHouse` tag, spacingIn 8, seed- prefix, normalized→pixel conversion) from the analyzer's `rooflineRuns`. Note it's **front-only** on the design canvas (the canvas is the street photo; sides/back live in satellite coords, so they stay as filled numbers). You know this seed pipeline far better than I do.
3. **Event / highlighting analyzer** (now specced — see the memory note / taxonomy below). Detects **wreaths, garland, roofline, spritzers**. Not started.
4. **Merge #436** once you're satisfied (device-check + your review). It's your-area code, so it's your merge-go per AGENTS.md.

## Review status

- **Review #1** (first batch, customer-facing/money) ran and I fixed all 4 confirmed findings: 2 HIGH (the stale-side-footage over-bill above; a blocker where permanent "Load photo" read a `blob:` object URL so base64 was always null and the design never created — now reads the File via FileReader) + 2 MED (spacing clamp; a stale banner header). Commit `57bf7ba`.
- **Review #2** (the analyzer wiring, commit `b39f886`) was **still running at session close** (workflow `w7jt77tuf`). Please check its result (or re-run a review of the analyzer-wiring diff) and address anything it confirms before merge. The wiring's gates are green regardless.

## Taxonomy (locked with Naldo 2026-07-07)

Three analyzers, one per service type: **Holiday** (existing, unchanged) · **Event/highlighting** (NEW = wreaths/garland/roofline/spritzers) · **Permanent** (roofline gutter line front/left/right/back + gaps, no ridges/peaks). Each gets its own training data, sharing only geometry. ("Reef/Scarlet" from an earlier transcript was a mis-hearing — ignore.)

## Confirmed decisions (don't re-litigate)

Permanent roofline = full perimeter all 4 sides (NOT front-section like holiday) · peaks skipped · front from street, sides/back from satellite · gaps = physical roofline breaks · AI auto-counts corners (each = 3 lights) · auto-fill is a starting estimate the operator edits · beam default ON · 8-inch is the only spacing.

## Rollback

Nothing is merged, so the rollback lever is the PR itself — don't merge, or revert the specific commit. The permanent analyzer wiring is isolated to `serviceType==='permanent'`; holiday/event paths are untouched.
