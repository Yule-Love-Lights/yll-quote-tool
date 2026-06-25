# Conventions & Gotchas — yll-quote-tool

How to add code here without breaking the patterns Naldo set. Grounded in the actual codebase.

---

## 1. Routes thin, logic in `src/lib`

The hard rule of this repo: **`src/app` and `src/components` stay thin; all business logic lives in `src/lib`.** API routes validate input, call a `lib` function, and shape the response. Pages compose components. New logic (pricing rules, projection rules, integrations, DB access) goes in `src/lib`, never inline in a route or component.

Why it matters: the pricing engine, scene projection, and portal adapter are all pure/near-pure and individually testable precisely because they don't import Next.js route machinery. Keep it that way.

---

## 2. Server-only vs client boundaries (and the service-role key)

- **`SUPABASE_SERVICE_ROLE_KEY` is god-mode — it bypasses Row Level Security entirely. Server-only, always.** It is read in `src/lib/supabase.ts` (`getSupabaseServiceClient()`), created with `auth: { persistSession: false, autoRefreshToken: false }`, and **never returned to or imported by client code**. Server-side modules (`designs.ts`, the portal loader, admin routes) use it where reads/writes must not depend on anon policies.
- **Never expose any secret to the browser.** Only `NEXT_PUBLIC_*` vars reach the client; everything else is server-only. Do **not** add a `NEXT_PUBLIC_` prefix to anything sensitive. The 5 public vars today are all portal display copy.
- **Two Supabase clients, on purpose:** `getSupabaseClient()` = anon (RLS-bound), `getSupabaseServiceClient()` = service-role (bypasses RLS). Use the anon client for RLS-disabled tables (`quotes`, `corrections`, `training_houses`) and the service client only where server-side code genuinely needs it. Don't reach for the service client just because it's easier — it removes every safety rail.
- **Admin mutations are gated by `ADMIN_SECRET`** via an `x-admin-secret` header (checked in 4 API routes). The admin UI stores it in `sessionStorage` and replays it. Any new destructive/admin route must do the same check.
- **Portal approval auth = the quote UUID is the capability token** (no login). `approve`/`send` routes document this deliberately. If you build auth on top, don't silently break the shareable-link model.

---

## 3. External integration map (ordering + credential gotchas)

| Service | Module | Gotchas |
|---|---|---|
| **Anthropic (Claude Sonnet 4.5)** | `claude.ts`, `photoAnalysis.ts` | Vision/measurement. Empty `ANTHROPIC_API_KEY` in a Claude-Code shell silently overrides `.env.local` — `unset` it before `npm run dev`. `max_tokens: 2048` could truncate very large polyline sets. |
| **`sharp`** | `designs.ts` | Reads image dimensions on design-photo upload. See §7. |
| **HighLevel CRM** | `integrations/highlevel.ts` | Requires `Version: 2021-07-28` header (400s without it). `isHighLevelConfigured()` needs API key **and** location ID. **Stage moves are non-fatal** (logged, local state still commits); the `attach` precondition is the one fatal check. |
| **home.works via Zapier** | `integrations/homeworks.ts` | No direct API — Catch Hooks both ways. Outbound URL **must** be `hooks.zapier.com` (validated). **Single line item only**: the full quote collapses into one item; **tax/deposit/balance are deliberately NOT sent** (home.works computes tax + derives deposit). Inbound signature webhook requires the `x-homeworks-secret` header == `HOMEWORKS_SIGNED_SECRET`. |

**Cross-cutting invariant — "stamp the DB first."** Every side-effecting route writes its local timestamp/snapshot to Supabase **before** calling the external API, and is **idempotent** on its `*_at` column. Preserve this: a downstream (Zapier/HighLevel) failure must never lose the local record. In `approve`, the HL stage→Interested move fires **after** the home.works webhook succeeds, on purpose.

**Config-gating convention.** Every integration has an `isXConfigured()` guard and degrades gracefully — the app boots with any subset of services configured. New integrations should follow the same pattern (an `isXConfigured()` + graceful skip), not throw at import time.

---

## 4. TypeScript / lint / formatting

- **TypeScript 5, `strict` mode.** The de-facto green-light gate before committing is **`npx tsc --noEmit`** (there is no `typecheck` npm script; run `tsc` directly — it's been clean on every change). Keep it clean; don't merge type errors.
- **Lint:** `npm run lint` (`eslint-config-next`). The codebase uses targeted `// eslint-disable-next-line @next/next/no-img-element` only where a raw `<img>` is intentional (e.g. lazy video posters) — don't blanket-disable. **Note:** a fresh `npm install` pulls `eslint-plugin-react-hooks` v7 (via `eslint-config-next` 16), which enables `react-hooks/set-state-in-effect` at *error* level. The existing code predated it (18 sites); all have been refactored and the rule is back at **`error`** — keep it that way. The fix pattern for an effect that genuinely needs a post-mount state update: defer it via `queueMicrotask(...)` (or `requestAnimationFrame` for animations) so the `setState` isn't dispatched synchronously inside the effect body.
- **Tests:** **`npm test`** (Vitest, runs once) or `npm run test:watch` (re-runs on save). The first suite covers the pricing engine — `src/lib/pricing/pricingEngine.test.ts`. Co-locate new tests as `*.test.ts` next to the module; pure `src/lib` modules are the easiest and highest-value things to cover. (Vitest's discovery ignores the unrelated legacy `src/lib/pricing/test.ts` exercise script — different name pattern.)
- **No pre-commit hooks are configured** (no husky/lint-staged in `package.json`). That means nothing stops a bad commit automatically — **run `npx tsc --noEmit`, `npm run lint`, and `npm test` yourself before committing.** You should never need `--no-verify` (there are no hooks to skip); if you find yourself reaching for it, stop and ask why.
- **Next.js 16 caveat** (`AGENTS.md`): this is not the Next.js most training data knows — APIs/conventions differ. Check `node_modules/next/dist/docs/` before using an unfamiliar Next API.

---

## 5. Naming / structure — where new code goes

- **New pricing rule or rate:** edit `BUSINESS_RULES` in `src/lib/pricing/pricingEngine.ts` (the single source of adjustable numbers) and the matching `calculate*` helper. Keep the engine pure — no I/O, no env reads.
- **New design/editor change:** the Konva editor core (`src/components/design/editor-core/`) is **vendored byte-identical from the design tool** — coordinate changes with the design-tool AI (Jason relays) so the cores stay in sync; scene types live in `src/lib/design/sceneTypes.ts`; projection rules in `src/lib/design/projectScene.ts`.
- **New integration:** new file under `src/lib/integrations/` with an `isXConfigured()` guard + an `XError` class; shapes go in `integrations/types.ts`; the route under `src/app/api/integrations/`.
- **New portal section:** there is now **one portal** — `/portal/[quoteId]`, the **Snowglobe** design (task #27 retired the old multi-skin layout). Its page composes the interactive-hero pieces in `components/portal/snowglobe/*` plus the dark-theme below-the-fold sections in `components/portal/dark/*`; add new sections in `dark/` (or `snowglobe/` if hero-coupled) and wire them into `src/app/portal/[quoteId]/page.tsx`. Shared selection state is `SelectionContext.tsx`; portal-facing types are `components/portal/types.ts` (intentionally decoupled from `lib/pricing` types — the seam is `lib/portal/adapter.ts`). Route CSS is `src/app/portal/portal-dark.css` + `portal-snowglobe.css`, applied via the `portal-dark-root portal-snowglobe-root` wrapper in `layout.tsx` (see `CURRENT_STATE.md` §4.1).
- **New DB access:** a function in the relevant `src/lib/*.ts` (e.g. `quotes.ts`), choosing the anon vs service client deliberately (§2).

---

## 6. Supabase migration workflow

- **Migrations live in the repo-root `migrations/` directory** — **not** `supabase/migrations/`. (Any `supabase/migrations/*` your editor surfaces belongs to a *different* project in the parent folder, not this repo.)
- **Naming:** `YYYY-MM-DD-<scope>-<change>.sql` (date-prefixed, dash-separated, e.g. `2026-04-25-renders-add-variant.sql`). Not numerically sequenced.
- **Applied manually** by pasting into the **Supabase SQL Editor → New Query → Run** (confirmed by file comments). **There is no automated migration runner** and no `migrate` npm script.
- **Always write migrations idempotent + roll-forward only:** `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP POLICY/CONSTRAINT IF EXISTS` before re-create, `INSERT … ON CONFLICT DO NOTHING`. To remove something later, write a new `DROP` migration — don't edit an applied file.
- **`FULL-SCHEMA.sql`** is the consolidated, re-runnable, idempotent snapshot — **refreshed 2026-05-29 into a complete standalone rebuild** (all 5 tables incl. base + every migration column, `renders.variant`, `reference_assets`, hardened RLS, indexes, trigger, storage bucket). Pasting this one file into the Supabase SQL Editor rebuilds the whole DB from scratch **and** patches an existing one. The dated `migrations/*.sql` remain the historical record; a new schema change still goes in a new dated migration **and** should be folded into `FULL-SCHEMA.sql` so it stays current.

---

## 7. Image handling

- **`sharp`** reads image dimensions server-side on design-photo upload (`src/lib/designs.ts`). *(Its old compositing/masking role died with the render pipeline, #36 — keep the dependency.)*
- **Storage:** the private **`designs`** bucket (base house photos + custom-item images), 1-hour signed URLs via the service-role client.
- **Other tables store images inline as base64** in jsonb/text (`training_houses.photos[]`, `reference_assets.base64`) — not in Storage. Keep that consistent unless you migrate them.
- **Source asset weight:** the real install photos in `public/references/` are multi-MB PNGs (one is ~4MB). Next/Image optimizes them for customers, but the **dev image optimizer can stall** on a page that loads ~11 at once. Compressing the source files to WebP is a known cleanup (LCP win) — flagged in the portal work.
- **Frontend images:** prefer `next/image`. Allowed remote hosts are allow-listed in `next.config.ts` (`images.remotePatterns`); add a host there before hotlinking it. Image `qualities` must be allow-listed too (`images.qualities` includes `85` for the snowglobe hero).

---

## 8. Load-bearing / "do not casually touch"

- **`pricingEngine.ts`** — pure money math; treat as canonical. Don't modify `pricingEngine.ts`, `photoAnalysis.ts`, `corrections.ts`, `training.ts` as a side effect of unrelated feature work (additive only). Honor that boundary.
- **The "stamp DB first" + idempotency pattern** in the side-effecting routes — don't reorder it.
- **Service-role boundary** (§2) — never leak it clientward.
- **Manual/local-only quirks to know:** migrations are hand-applied in Supabase; the bucket `designs` must exist; there's no seed script (use `/quote/new` to create quotes).

---

## 9. Branching / commits / PRs

- **Observed today:** work lands directly on **`master`** with short, descriptive imperative commit subjects (e.g. "Render pipeline v2 — FLUX bush inpainting + reference library", "Security hardening + service-role client for renders pipeline"). Not Conventional Commits format. One feature branch exists (`feature/satellite-canvas`, already merged into master's history).
- **Recommended now that it's a two-person team:** use short-lived `feature/*` branches and open PRs into `master` so changes get a second set of eyes — especially around the service-role key, RLS migrations, pricing, and anything customer-facing. There's no PR template or CI gate yet; at minimum run `npx tsc --noEmit` + `npm run lint` + `npm test` before pushing. Confirm the branching/PR norm with Naldo before your first big change.
- **Never commit secrets.** `.env*` is gitignored; only `.env.local.example` (placeholders) is tracked. Review `git diff --cached` before every commit and never `git add -A` blindly.
