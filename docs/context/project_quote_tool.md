---
name: project-quote-tool
description: "AI Quote Tool — current state, confirmed decisions, run commands, gotchas, and what's next. Read first each session."
metadata: 
  node_type: memory
  type: project
  originSessionId: 834b8d13-f89f-476d-bae1-0a9ab5613799
---

# AI Quote Tool — project state (READ FIRST)

> Session-continuity layer — the quick "where are we / what's decided" so a cold session resumes without re-litigating. Deep detail lives in the repo: `docs/ONBOARDING.md` (setup), `docs/CURRENT_STATE.md` (done / half-done / bugs), `docs/CONVENTIONS.md` (how to add code). Pair this with `session_log.md`.

## Current state at a glance
- **Pre-launch.** This tool is NOT customer-facing or used internally yet. The live customer flow today is **home.works** (separate system). So changes here are lower-risk — we're building *toward* launch.
- Deployed on **Vercel** (`yll-quote-tool`, Production tracks `master` → quote.yulelovelights.com), but not yet shown to customers.
- Runs locally on **Next 16.2.6** (Turbopack), connected to the **real Supabase** (~55 real/test quotes). `.env.local` is filled on Jason's machine (values: see `project_secrets_access.md`).
- Gates all green: `npx tsc --noEmit`, `npm run lint`, `npm test` (Vitest).

## Scope / out of scope (now)
- **IN:** QA-driven bug fixes + feature work on the quote builder, pricing engine, and customer portal (the punch-list below).
- **OUT / deferred:** wiring prod CRM + home.works (on hold — likely intentional during testing; home.works may be dropped for a different route); the portal package tiers (Classic/Festive/Yule) are Claude-generated placeholders to configure later; the planned-features backlog (c9Lines, SSIM, auto-send, Replicate pin).

## Decisions confirmed — DON'T re-ask
- **Roofline model (task #17 — Phase 1+1b+2 DONE; Phase 4 remains):** 🔴 red = **front roofline = Santa's**; 🔵 blue = **ridge + sides**. A quote **PRESENTS BOTH** a Santa's option (front) AND a Gingerbread option (**front + ridge + sides**) — both shown; **mutually exclusive at SELECTION** (the customer picks one, never both). Operator quotes everything; staff **recommend** one (the portal default); when staff doesn't pick, the engine **auto-selects the option that lands the quote total closest to the $1,000 minimum WITHOUT going under** (else the larger). **Phase 1+1b (S2):** engine prices + exposes both on `QuoteResult.rooflineOptions`, bills only the recommended (`rooflineChoice` input + auto-default); builder breakdown has recommend radios that re-price in place. **Phase 2 (S3):** the customer portal now shows BOTH options as **ordinary "What's Included" line items** (no dedicated selector, no footage on the portal) — only the staff pick is selected by default; clicking the other deselects it (mutually exclusive — never both); clicking the selected one removes it (like any item, no Remove button). Adapter splits the billed roofline into `roofline-santas`/`roofline-gingerbread`; `PortalRoofline = { itemIds, recommendedItemId }` drives the either/or in `SelectionContext.toggleItem`; only the recommended option is bundled into tiers + the $1,000 gate (tierLineItems filter ⇒ no double-count). **Still TODO — Phase 4:** AI must trace front=red/Santa's, sides+ridge=blue/Gingerbread (today it lumps sides into red) + the remaining "Gingerbread Ridge" renames in non-line-item places. C9 / Winter Wonderland left untouched throughout.
- **$1000 minimum (CHANGED in S2, task #18):** NO LONGER an engine floor — `pricingEngine` returns the real total so staff can intentionally send sub-$1000 quotes (the "Minimum quote applied" note is gone). It's now a **customer-portal approval gate**: Approve is disabled until the selected pre-tax subtotal reaches $1000 (with an "Add $X more" nudge). **Waived** (gate off) when the whole quote's items total < $1000 — staff override, else it'd be un-approvable. Portal shows real prices + a Subtotal/Tax/Total/Deposit tie-out (tax now visible). *(Supersedes the old "minimum applies everywhere / floor" rule.)*
- **Multi-image quoting:** extra images are **manual-only** (no AI auto-quote) to avoid double-counting; no cross-image AI dedup. Image 1 covers the roof.
- **Light color/pattern:** operator sets a default (warm white by default) in the builder; the customer sees it **pre-selected** on the portal and can change it; saved to the quote; no extra cost. (Option list in task #26.)
- **4.5ft garland:** labor $135, fullDecor $210; **bow tier still $0 — pending Naldo.**
- **Workflow:** never commit without Jason's explicit "yes"; PR-not-master; run gates (tsc + lint + test) before commit. Jason + Naldo are on different machines → `docs/context/` is the canonical shared memory.
- **Pushing:** **Claude runs `git push`** (Jason approved in Session 1). Pushing to the `Yule-Love-Lights` org is NOT blocked here, unlike the design tool's exfil guard. Commits still require Jason's explicit "yes" first.
- **Portal consolidation (next up, task #27):** `/portal/[quoteId]` becomes THE canonical customer URL serving the **Snowglobe** design; the other 3 portal routes (`portal-snowglobe`, `portal-dark`, `portal-concierge`) get retired. ⚠️ KEEP the `components/portal/dark/*` + `snowglobe/*` COMPONENT folders — Snowglobe reuses them; delete only the route folders, and grep-verify before deleting any component.

## How to run locally
- Dev server (repo root). Via Claude Code's **Bash** tool, prefix to dodge the empty-`ANTHROPIC_API_KEY` shell quirk:
  `unset ANTHROPIC_API_KEY; unset ANTHROPIC_BASE_URL; export PATH="/c/Program Files/nodejs:$PATH"; npm.cmd run dev`
  (Normal terminal: just `npm run dev`.) → http://localhost:3000
- Gates: `npx tsc --noEmit` · `npm run lint` · `npm test`
- Key pages: `/quote/new` (operator) · `/admin/quotes` · `/admin/renders` · `/portal/<quoteId>` (Snowglobe — the one portal) · `/training/*`.

## Known gotchas
- Empty `ANTHROPIC_API_KEY` in the Claude-Code shell overrides `.env.local` → Claude routes 503. Unset it before `npm run dev`.
- `react-hooks/set-state-in-effect` is at **error**; the fix pattern for legit effects is a `queueMicrotask`/rAF defer.
- Vercel env vars are all **"Sensitive"** (unreadable) — pull secret values from source accounts (`project_secrets_access.md`).
- Vercel prod lacks the `HIGHLEVEL_*` vars + uses mismatched home.works var names → prod CRM/home.works are off (likely intentional; task #5 on hold).

## QA punch-list (the active backlog — mirrored from the Claude task list so it survives a cold session)
- **#17** Roofline redesign — **Phase 1+1b DONE (S2)** (engine mutually-exclusive model + builder recommend radios) + **Phase 2 DONE (S3)** (portal switch — both options as mutually-exclusive "What's Included" line items); **Phase 4** (AI red/blue + non-line-item renames) remains · ~~**#18** $1000 minimum everywhere~~ **DONE (S2)** — reworked into a portal approval gate (not an engine floor) · **#19** [low] operator "recommend items" checkboxes
- **#20** corner-house default → front-door view (feasibility TBD) · **#21** move Street View camera along the road (feasibility TBD) · **#22** multi-image quoting (*big*) · **#23** re-analyze button for uploaded images · ~~**#24** [bug] C9 line delete doesn't reset footage~~ **DONE (S2)** · ~~**#25** [UX] discount input accept `20` not `0.20`~~ **DONE (S2)** · **#26** portal color/pattern picker
- ~~**#27** Portal consolidation~~ **DONE (S2)** — `/portal` IS Snowglobe; old skins/routes retired.
- Pending / needs Naldo: #4 verify renders RLS · #6 dormant portals decision · #7 dev Supabase · #8 bow price · #9 HL stage mapping · #10 reviews · #11 phone/video · #14 migration apply + image cleanup.

## Next up
**Done in Session 2 (all merged to `master`):** #27 portal consolidation + dead-`dark/StickyBottomBar` cleanup + #25 (discount `20`) + #24 (C9 delete resets footage) + #18 ($1000 min → portal gate) + #4 (rush/premium portal toggles) + **#17 Phase 1+1b** (roofline Santa's/Gingerbread mutually-exclusive engine model + builder recommend radios).
**Done in Session 3 (PR `jason/roofline-phase2`, opening into `master`):** **#17 Phase 2** — customer-portal roofline switch. Both options render as **ordinary "What's Included" line items** (no dedicated selector, no footage on the portal); staff pick selected by default; mutual-exclusivity + remove handled by `SelectionContext.toggleItem` via `PortalRoofline.itemIds`; only the recommended option is bundled into tiers + the $1,000 gate. Backward-compatible for pre-Phase-1 quotes. Repo docs sync (#4 + #17 Phase 1+1b + Phase 2) folded into the same PR.

**Immediate next: #17 Phase 4** (the last roofline phase): teach the AI (`src/lib/photoAnalysis.ts`) to trace **front gutter = red/Santa's** and **side gutters + ridge = blue/Gingerbread** — today it lumps side gutters into red (Santa's), which Jason flagged with a real example. + the remaining "Gingerbread Ridge" → "Gingerbread" renames (AI prompt, training UI, render-variant labels: `variants.ts`, `variantPhoto.ts`, `PackageVariantGallery.tsx`, `training/corrections/page.tsx`). The customer-facing line item was already renamed (#18); these were left because they describe what Gingerbread *measures*/*renders*, which Phase 4 changes.

After #17: QA leftovers **#19** (operator recommend-items checkboxes), **#23** (re-analyze button), **#26** (portal color/pattern picker) + the Naldo-pending items.
