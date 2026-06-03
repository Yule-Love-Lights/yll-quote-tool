# Current State — "where Naldo left off"

**As of:** 2026-05-29. Latest commit before this handoff: `8e82790` "Per-package render variants + portal gallery + press assets" (2026-05-28), plus a large **uncommitted working tree** (the Snowglobe-as-final + asset-wiring work described below, committed as part of this handoff).

This doc is deliberately blunt. Every claim is tied to a file, commit, or migration. Where something is genuinely unknown it says **UNKNOWN — flag for Naldo**. Ground truth is the code, not memory.

> **Post-handoff updates (2026-05-29, Jason — branch `jason/onboarding-followups`):** fixed the silent $0 garland pricing (§5); added a `reference_assets` migration (§5 / §6 #5); introduced **Vitest** + a pricing-engine test suite (`npm test`); converted the gallery photos to **WebP** (~86% smaller); and completed the `react-hooks/set-state-in-effect` lint refactor (all 18 sites fixed via `queueMicrotask`/`rAF` deferral; rule restored to `error` — see `CONVENTIONS.md` §4). Two discoveries: the project **is already deployed on Vercel** (Production tracks `master` → `quote.yulelovelights.com`), and **every Vercel env var is marked "Sensitive"** so the values can't be read back — secrets must come from the source accounts (Supabase/Anthropic/Google), not Vercel.

---

## 1. What this tool is (orientation)

An internal **AI-assisted quoting + proposal tool** for Yule Love Lights (premium holiday/permanent lighting on Long Island). End-to-end flow:

**Lead → photo/address → AI measurement → pricing/quote → AI render → customer portal → approval → CRM + estimating hand-off.**

1. Operator opens `/quote/new`, optionally pulls a HighLevel CRM contact, and provides a **house photo or just an address** (Google Street View + satellite are fetched automatically).
2. **Claude Sonnet 4.5 vision** (`src/lib/photoAnalysis.ts`) traces rooflines as polylines and detects bushes/trees/wreaths/spritzers/garland, returning structured measurements. The operator can correct anything; corrections feed back as few-shot examples.
3. The **pure pricing engine** (`src/lib/pricing/pricingEngine.ts`) turns measurements into line items + packages + tax + deposit.
4. The **render pipeline** (`src/lib/rendering/*`) composites bulb sprites onto the photo with `sharp`, then has **Gemini 3 Pro Image** "photograph" it into a photoreal nighttime preview (optional **Replicate FLUX** inpaint pass for bush mini-lights). Internal review/approval happens in `/admin/renders`.
5. The customer opens the **portal** (`/portal/[quoteId]`) showing their rendered home, package options, reviews, and gallery, and clicks **Approve & Pay Deposit**.
6. Approval freezes an immutable snapshot, fires the **home.works** estimate (via Zapier), and advances the **HighLevel** pipeline. A later inbound webhook records the signature.

---

## 2. Architecture map

**Routes are thin; the real logic lives in `src/lib/`.** (Full module-by-module detail is in `docs/CONVENTIONS.md` §naming and in the lib files themselves.)

### `src/lib/`
- **`pricing/pricingEngine.ts`** — pure, dependency-free money math. `BUSINESS_RULES` is the single source of adjustable numbers (rates, tax 0.08625, $1000 order minimum [now enforced as a customer-portal approval gate, NOT an engine floor — #18], 50% deposit, rush/takedown). `calculateQuote(inputs) → QuoteResult`.
- **`photoAnalysis.ts`** — the Claude vision brain. `analyzePhoto()` → polylines + detections + confidence; defends against messy JSON and 0–1000 vs 0–1 coordinate scaling. Pulls corrections + training + reference assets as few-shot context.
- **`rendering/`** — `orchestrator.ts` (conductor: hash → cache → budget → composite → Gemini → optional inpaint → store), `gemini.ts` (REST client, 3 model tiers, retry loop), `inpaint.ts` (Replicate FLUX, optional), `compositor.ts` (`sharp` bulb-sprite compositing + mask), `storage.ts` (Supabase service-role data layer + cache key + `RENDER_PROMPT_VERSION`), `variants.ts` (per-package vision filtering), `adapter.ts` (coord clamping), `types.ts`.
- **`portal/`** — `loader.ts` (fetch quote → `PortalQuote`), `adapter.ts` (DB row → UI shape), `photos.ts` (resolve before/after + per-variant signed URLs from `renders`), `derivePackages.ts` (one `QuoteResult` → 4 tiers), `lineItemKind.ts` + `variantPhoto.ts` (label/kind parsing).
- **`integrations/`** — `highlevel.ts` (CRM: contact + opportunity + stage), `homeworks.ts` (Zapier hook + single-line-item rollup), `types.ts`.
- **`supabase.ts`** (anon vs service-role client factories), **`quotes.ts`**, **`corrections.ts`**, **`training.ts`**, **`referenceAssets.ts`**, **`claude.ts`**, **`googleMaps.ts`**, **`rateLimit.ts`** (in-memory per-IP).

### `src/app/`
- **API routes** (`api/`): `quote`, `quotes/[id]/{approve,send,renders,render-variants,video}`, `analyze-photo`, `analyze-address`, `streetview`, `renders/[id]`, `corrections`, `training`, `references`, `integrations/highlevel/{contacts,attach}`, `integrations/homeworks/{send,signed}`.
- **Pages**: `quote/new` (operator UI), `admin/quotes` + `admin/quotes/[id]/{renders,video}`, `admin/renders` + `admin/renders/new`, `training/*`, and **four portal skins** (see §4.1).

### `src/components/`
Almost entirely portal UI: a base set in `portal/`, plus per-skin overrides in `portal/dark/`, `portal/concierge/`, `portal/snowglobe/`. Skin-agnostic infra: `SelectionContext.tsx` (package/line-item selection state), `types.ts`, `format.ts`, `mockQuote.ts`. One admin component: `admin/HighLevelContactAutocomplete.tsx`.

### Data model (Supabase Postgres) — 5 tables
- **`quotes`** — one per quote. **No `status` enum; state is a chain of nullable timestamps:** `created_at → quote_sent_at → customer_approved_at → homeworks_sent_at → homeworks_signed_at`. Plus `approval_snapshot` (jsonb, frozen at approval), `highlevel_contact_id/opportunity_id`, `video_*` (walkthrough), `inputs`/`result` (jsonb). **RLS disabled** — anon client.
- **`renders`** — one per generated image. `status`: `pending → rendering → ready → approved` (or `rejected`/`failed`). `variant` (`full`/`santas`/`ridge`/`minis`/`wreaths`/`spritzers`/`garland`), `model` (`pro`/`flash2`/`flash`), `cache_key`, artifact paths, `gemini_cost_usd`. **RLS ENABLED**: anon can SELECT only `status='approved'`; the whole pipeline therefore runs via the **service-role** client. Unique index on `(quote_id, variant, style)` for non-rejected rows.
- **`photo_corrections`** — human-corrected analyzer outputs (few-shot source). RLS disabled.
- **`training_houses`** — confirmed real-install measurements (highest-trust few-shot). RLS disabled.
- **`reference_assets`** — product close-ups injected into Claude calls. Schema was inferred from `referenceAssets.ts` and is **now captured in `migrations/2026-05-29-reference-assets-create.sql` + `FULL-SCHEMA.sql`** (RLS disabled, matching the sibling internal tables). It previously existed only as a hand-made table in the live Supabase.
- **Storage:** one private bucket **`renders`**, layout `{renderId}/{source|composite|mask|final|gemini}.{jpg|png}`, served via 1-hour signed URLs. Other tables store images inline as base64.

### Render pipeline (precise order)
Claude Sonnet 4.5 vision → `coerceVision` clamp → hash/cache lookup → monthly-budget guard → insert `pending` row → upload source → `sharp` composite + mask → Gemini 3 Pro Image (REST, source+composite+mask) → **optional** Replicate FLUX inpaint (bush regions only, non-fatal) → upload final → `ready`. Model tiers: `pro` ≈ $0.134, `flash2` ≈ $0.067, `flash` ≈ $0.04 per call. Cache key includes `RENDER_PROMPT_VERSION` (currently **9**) so prompt changes bust cache.

---

## 3. DONE — works end-to-end today

All verified against current files (the 2026-04-22 code review's CRITICAL/HIGH items were fixed the same day in `0ef2592` + RLS migrations; I checked the code, not the review).

- **Pricing engine** — solid, pure, the most reliable module. `calculateQuote` covers roofline/mini-lights/spritzers/wreaths/garland → discount → rush/takedown → tax → deposit. (The $1000 minimum is **no longer** an engine floor — task #18 moved it to a customer-portal approval gate so staff can intentionally send sub-$1000 quotes.) (One placeholder price; see Known Bugs.)
  - **Santa's vs Gingerbread rooflines are mutually exclusive (#17 Phase 1):** Santa's = front; Gingerbread = front + ridge + sides. The engine prices BOTH and exposes them on `QuoteResult.rooflineOptions` (`{ santas, gingerbread }`) + `rooflineChoice`, but **bills only the recommended one** (front footage never double-counted). `rooflineChoice` is an optional input (staff recommendation); when absent the engine auto-picks the option that lands the total closest to the $1,000 minimum without going under (else the larger). C9/Winter Wonderland is independent and billed alongside either.
- **AI photo/address analysis** — `analyzePhoto` works from a photo or just an address (Street View + satellite). Robust JSON salvage + coordinate normalization. Few-shot from corrections + training + reference assets.
- **Render engine core** — `runRender()` fully wired (`caa435c`): composite → Gemini, caching, budget guardrail, variant filtering, Supabase storage. Phase 1 was rated by Naldo "literally looks amazing" (see `docs/context/project_yll_render_engine.md`). **Works reliably** for warm-white; bush inpaint is the rough edge.
- **Per-package render variants** — `variants.ts` + `render-variants` route + `PackageVariantGallery` (`8e82790`, latest commit).
- **3-tier Gemini model toggle** — `pro`/`flash2`/`flash` (`b6d0d20`).
- **Security hardening** — `x-admin-secret` on all admin/destructive routes, `UUID_RE` validation, coord clamping, budget guard with NaN protection, hardened `renders` RLS (anon reads only approved). (`0ef2592` + `renders-harden-rls.sql`.)
- **Live customer approval** — `approve` route writes a versioned `approval_snapshot`; approved portal page reads the real snapshot (`d873e9c`). UUID-as-capability-token auth (intentional, documented in the route).
- **CRM + home.works pipeline** — HighLevel lookup-first opportunity handling + stage moves; home.works outbound via Zapier with single-line-item rollup; inbound signature webhook (`b55d61a`, `ac389a4`).
- **One customer portal on real data** — **`/portal/[quoteId]`** (the Snowglobe design) loads real quotes via `lib/portal/loader.ts` (mock only as a dev fallback when Supabase is unconfigured) and runs the real approve flow. The old `portal-snowglobe`/`portal-dark`/`portal-concierge` routes were retired in task #27.
- **Portal selection model (real prices + customer choice)** — the portal prices every selection from the actual selected line items via `priceSelection` (no $1,000 floor; the minimum is an **approval gate** — Approve disabled until the pre-tax subtotal ≥ $1,000, waived for intentionally sub-$1,000 quotes — #18), with a Subtotal/Tax/Total/Deposit tie-out. The customer can toggle **rush install + premium takedown** add-ons (#4; default = the staff's builder choice, never auto-selected by a package) and pick their **roofline**: Santa's vs Gingerbread render as two **mutually-exclusive "What's Included" line items** (#17 Phase 2) — only the staff pick is selected by default, picking one deselects the other, and either can be removed like any item (no footage shown on the portal). `lib/portal/adapter.ts` (`buildPortalLineItems`) splits the billed roofline into `roofline-santas`/`roofline-gingerbread` from `rooflineOptions`; `SelectionContext.toggleItem` enforces the either/or via `PortalRoofline.itemIds`; only the recommended option is bundled into the A/B/C tiers + counted toward the gate (a `tierLineItems` filter ⇒ no double-count). Pre-Phase-1 quotes (no `rooflineOptions`) keep a single plain roofline toggle.

---

## 4. IN PROGRESS / half-done (read this carefully)

### 4.1 Portal consolidated on **Snowglobe** — `/portal` is the one and only portal (task #27, DONE)
There is now a **single portal route**: **`/portal/[quoteId]`**, which *is* the Snowglobe design. The old multi-skin layout (`portal/` v1, `portal-dark/` v2, `portal-concierge/` v4, `portal-snowglobe/` v6) was retired — the three extra route folders were deleted and the v1-only + concierge components removed.
- **`/portal/[quoteId]`** serves the Snowglobe compositions on real data via `loader.ts` (mock only as a dev fallback when Supabase is unconfigured), with the real approve flow + the approved-page approval guard. The admin "Portal ↗" link, the "Send to customer" copied URL (`src/app/admin/quotes/page.tsx`), and the admin video-page portal link all point to `/portal/[id]`.
- **Implementation note:** the Snowglobe page reuses the dark-theme below-the-fold sections, so `components/portal/dark/*` and `snowglobe/*` are kept (alongside shared infra `SelectionContext`/`types`/`format`/`mockQuote` + `lib/portal/*`). The route CSS lives at `src/app/portal/portal-dark.css` + `portal-snowglobe.css`, applied via the `portal-dark-root portal-snowglobe-root` wrapper in `layout.tsx`. (The unused `dark/StickyBottomBar.tsx` was removed in the follow-up cleanup — the live portal uses `snowglobe/StickyBottomBar`.)

### 4.2 Reviews are still placeholder content
- `MOCK_REVIEWS` (3 fabricated testimonials) and a **hardcoded `rating={4.9} totalReviews={187}`** are passed to `<GoogleReviews>` on every portal. This session wired the real **GMB "read all reviews" link**, but the **rating, count, and the 3 quotes are still fake.**
- **Next step:** replace with 3–5 real Google reviews + the real current rating/count (Naldo to supply; reliable scraping of GMB isn't feasible from the link alone).

### 4.3 `c9Lines` (Winter Wonderland) plumbed but fed empty
The adapter and the quote/training UIs capture `c9Lines` as drawable polylines, but the render-from-analysis path hardcodes empty: `admin/renders/new/page.tsx` `c9: allTrue(0), // analyzer doesn't yet produce c9Lines`. Deferred to a later phase.
- **Next step:** when the analyzer emits `c9Lines`, drop the hardcoded zero and pass captured lines through.

### 4.4 home.works `notes` not wired
`api/integrations/homeworks/send/route.ts`: `notes: undefined, // TODO wire up when notes field is added to quotes`. The `quotes` table has no `notes` column.
- **Next step:** add a `notes` column (migration) + form field, then populate.

### 4.5 Quote delivery is manual
`/send` only stamps `quote_sent_at` + moves the HL stage; the operator hands the URL to the customer themselves (`quote/new/page.tsx`: "we don't auto-send yet. Phase 2 could add that"). Optional SMS/email auto-send is unbuilt.

### 4.6 SSIM scoring is scaffolding only
`ssim_score` column + type + admin display exist, but the orchestrator never computes it — always `null`.
- **Next step:** compute SSIM post-Gemini, or remove the dead column/UI.

### 4.7 This session's uncommitted work (now part of the handoff commit)
Snowglobe promotion + asset wiring across ~18 files (`mockQuote.ts`, portal + dark components, `lib/portal/adapter.ts`, `next.config.ts`, admin page) plus new real install photos and press logos under `public/references/`. Committed as part of this handoff.

---

## 5. KNOWN BUGS / LIMITATIONS / FRAGILE SPOTS

- **🟡 Pricing placeholder — mostly fixed.** `pricingEngine.ts` 4.5ft Noble garland was a `{ labor: 0, bow: 0, fullDecor: 0 }` placeholder that silently priced at **$0**. Now set: **labor $135, fullDecor $210** (Naldo confirmed 4.5ft is a real size). The **`bow` tier is still `0`** pending Naldo's price — selecting "4.5ft / With Bow" still prices at $0. A regression test guards the two fixed values (`pricingEngine.test.ts`).
- **🔴 Customer-facing FAKE phone number on dormant portals.** `MOCK_TEAM.phone: '(555) 123-4567'` renders in CTAs + `tel:` links on **dark + concierge** approved pages. v1/snowglobe override via `NEXT_PUBLIC_PORTAL_PHONE` (real). If dark/concierge stay reachable, the fake number is live to customers.
- **🟠 RLS migration ordering is unverified in prod.** Both `renders-fix-rls.sql` (insecure, `anon full access`) and `renders-harden-rls.sql` (secure) share the `2026-04-22` date prefix. `FULL-SCHEMA.sql` reflects the hardened end state. **UNKNOWN whether the live Supabase project has the hardened policies applied** — Naldo/Jason should run `\d renders` (or check the dashboard policies) and confirm anon SELECT is `status = 'approved'`, not `true`.
- **🟠 Gemini retry inflates cost estimate.** On a retried success, `estimatedCostUsd = costUsd * (attempt+1)` — MTD spend (and the budget guard) climb faster than nominal when Pro-preview is flaky.
- **🟠 Cost figures inconsistent.** Code charges ~$0.134/Pro call; `.env.local.example` comment says "~$0.20"; the in-code budget fallback is **200** but the example ships **`RENDER_BUDGET_MONTHLY_USD=10`** (the env value wins). Decide the real ceiling.
- **🟡 Gemini model IDs are all `-preview`/β** — `gemini-3-pro-image-preview` etc. can change without notice. Exact model ID matters (`gemini-3-pro-image` 404s — see context snapshot).
- **🟡 Replicate inpaint model ref is unpinned** (`zsxkib/flux-dev-inpainting`, no `:version`) — output quality can drift; pin once validated. Large photos can exceed the 120s poll window.
- **🟡 Compositor geometry is approximate** — trunk wrap = 3 stripes not a helix, garland = straight line, wreath ring overshoots non-square boxes, `multi` style returns one amber (rotation is "Phase 2"). Cosmetic; affects mask guidance, not pricing.
- **🟡 Rate limiter trusts first `x-forwarded-for`** — spoofable on non-Vercel hosts (memory says Naldo deploys to Render). Budget protection, not DoS-grade.
- **🟡 `renders.quote_id` is not a real FK** (no `REFERENCES quotes(id)`); orphan integrity is app-logic only.
- **⚪ "Works on Naldo's machine only" risks (resolved):** `reference_assets` now has a migration, and **`FULL-SCHEMA.sql` was refreshed (2026-05-29) into a complete standalone rebuild** — pasting that one file into the Supabase SQL Editor recreates the entire schema (all 5 tables + columns + `renders.variant` + RLS + storage bucket) from scratch. The DB is now fully reproducible from the repo.
- **🟡 npm-audit: 3 accepted moderate vulns.** After the 2026-05-29 cleanup (bumped `next`→16.2.6 to clear the high-severity advisories; `npm audit fix` cleared `ws` + `brace-expansion`), `npm audit` still reports 3 moderate — **deliberately accepted**, not overlooked: (1) **`@anthropic-ai/sdk`** — the flaw is in the SDK's *Local Filesystem Memory Tool*, which this app doesn't use → not exploitable here; the fix is a breaking `0.90`→`0.100` bump, deferred to a tested upgrade. (2)+(3) **`postcss` / `next`-via-postcss** — a *build-time* CSS-stringify XSS, only reachable with attacker-controlled CSS → not exploitable here; no non-breaking fix until Next bundles postcss ≥8.5.10. Re-check these on future `next` / SDK upgrades.
- **🟢 Deploy (corrected):** the site **is** deployed on **Vercel** — project `yll-quote-tool`, Production env tracks `master` (→ `quote.yulelovelights.com` + `yll-quote-tool.vercel.app`), so merges to `master` auto-deploy. (Supersedes the earlier "not deployed anywhere public yet" note.) All Vercel env vars are marked **Sensitive**, so their values can't be read from the dashboard/CLI — pull secrets from the source services instead.

---

## 6. NEXT STEPS / ROADMAP

**Must-do to be stable (do these first):**
1. **Set real `.env.local`** incl. the newly-documented `HIGHLEVEL_STAGE_QUOTE_INTERESTED`, and confirm `RENDER_BUDGET_MONTHLY_USD`.
2. **Verify live Supabase RLS** on `renders` is the hardened policy (§5). One SQL check.
3. ~~**Fix the `$0` pricing placeholder**~~ — **DONE** for labor ($135) + fullDecor ($210); the `bow` tier is still `$0` pending Naldo's price.
4. ~~**Resolve the dormant portals**~~ — **DONE** (task #27): consolidated on Snowglobe at `/portal`; retired the dark + concierge + snowglobe routes and their orphaned components (§4.1).
5. ~~**Capture `reference_assets` DDL** in a migration~~ — **DONE** (`migrations/2026-05-29-reference-assets-create.sql`); still needs applying to any fresh DB.

**Planned / higher-leverage:**
6. Real Google reviews + rating/count on the portal (§4.2).
7. Decide whether to deploy (Vercel is the natural fit for Next 16; memory mentions Render). Set env vars in the host; the customer URL becomes `https://<domain>/portal/[id]`.
8. Pin the Replicate model version; reconcile Gemini cost accounting.
9. `c9Lines` end-to-end (§4.3), home.works `notes` (§4.4), optional auto-send (§4.5), SSIM or remove it (§4.6).

**Good first tasks for Jason** (low-risk, high-orientation-value): ~~fix the `$0` pricing placeholder~~ (done); swap real review content; ~~add the `reference_assets` migration~~ (done); ~~retire/wire the dormant portals~~ (done, task #27). Each touches one well-bounded area.

---

## 7. Open questions / undecided decisions (don't relitigate without checking with Naldo)

- **Are dark + concierge portals being kept or retired?** (Drives a delete vs. wire decision.)
- ~~Is the repo staying on the personal account or moving to the org?~~ **RESOLVED:** the repo has moved to `Yule-Love-Lights/yll-quote-tool` (confirmed via push redirect during handoff). The machine's local `origin` still points at the old `naldoven/...` URL via redirect — Naldo should `git remote set-url origin` to the org URL.
- **What is the real monthly Gemini budget ceiling?** (Code says 200, example says 10.)
- ~~**Is 4.5ft garland a real selectable size?**~~ **RESOLVED:** yes (Naldo confirmed). labor/fullDecor now priced; the `bow`-tier price is still outstanding from Naldo.
- ~~**Deploy target — Vercel or Render?**~~ **RESOLVED:** the project is on **Vercel** (`yll-quote-tool`, Production tracks `master` → `quote.yulelovelights.com`).
- **Auth model for portals** is intentionally "UUID = capability token" (no login). Confirm that's acceptable long-term before building login on top of it.
