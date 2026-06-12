# Onboarding — yll-quote-tool

Goal: get you from `git clone` to a running dev server with zero tribal knowledge. Read this top to bottom once.

> **Repo location (verified):** the repository now lives at the **`Yule-Love-Lights` org** —
> `https://github.com/Yule-Love-Lights/yll-quote-tool.git`. (Confirmed during the handoff push:
> GitHub reported the repo *moved* from the old personal account `naldoven/yll-quote-tool` and
> redirected the push to the org.) **Clone the org URL below.** Note for Naldo: the machine's local
> `origin` still points at the old `naldoven/...` URL and works only via GitHub's redirect — run
> `git remote set-url origin https://github.com/Yule-Love-Lights/yll-quote-tool.git` to stop
> relying on it.

---

## 1. Prerequisites & run steps

### Clone

```bash
git clone https://github.com/Yule-Love-Lights/yll-quote-tool.git
cd yll-quote-tool
```

### Node.js version

- **No version is pinned** in the repo — there is no `.nvmrc` and no `engines` field in `package.json`.
- **Naldo runs Node v24.15.0 / npm 11.12.1.**
- The stack is **Next.js 16.2.4** (App Router + Turbopack), **React 19**, **TypeScript 5 (strict)**, **Tailwind 4**. Next.js 16 requires **Node `^20.9.0` or `>=22`**.
- **Recommendation:** use Node 20 LTS or newer (22 LTS or 24 both fine). If you use `nvm`, `nvm install 22 && nvm use 22`.

### Install (npm — matches the lockfile)

The repo has a `package-lock.json` (no `yarn.lock`/`pnpm-lock.yaml`), so use **npm**:

```bash
npm install        # first time / after dependency changes
# or, for a clean reproducible install matching the lockfile exactly:
npm ci
```

### Scripts (from `package.json` — verified, not guessed)

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server (Next 16 + Turbopack) at http://localhost:3000 |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint (`eslint-config-next`) |

> There is **no `test` script and no dedicated `typecheck` script** in `package.json`. To typecheck,
> run TypeScript directly: `npx tsc --noEmit`. (Naldo/CI has been running `tsc --noEmit` manually as
> the green-light gate before commits.) There is a non-wired pricing exercise script at
> `src/lib/pricing/test.ts` (not run by any npm script).

### ⚠️ Claude Code users — the empty-`ANTHROPIC_API_KEY` gotcha

If you run the dev server **through Claude Code's Bash tool**, the inherited shell sets
`ANTHROPIC_API_KEY=""` (empty), which silently overrides `.env.local`, so Claude-powered routes
return `503 "ANTHROPIC_API_KEY missing"` while everything else works. **Unset it first:**

```bash
unset ANTHROPIC_API_KEY; unset ANTHROPIC_BASE_URL; npm run dev
```

This does **not** affect running `npm run dev` from a normal terminal. Full detail in
`docs/context/feedback_claude_code_env_override.md`.

---

## 2. Environment variables — the complete list (BY NAME)

Derived by scanning the codebase for `process.env.*` (not from memory). **21 distinct variables: 5 PUBLIC (shipped to the browser via the `NEXT_PUBLIC_` prefix) and 16 server-only/secret** (including the framework-provided `NODE_ENV`). *(7 render-pipeline vars — `GEMINI_API_KEY`, `RENDER_MODEL`, `RENDER_VARIANT_MODEL`, `RENDER_VARIANT_CACHE_BUST`, `RENDER_BUDGET_MONTHLY_USD`, `REPLICATE_API_TOKEN`, `REPLICATE_INPAINT_MODEL` — were removed in the #36 Gemini teardown.)*

> **Get the real values out-of-band** (see §3 and the handoff report). Copy `.env.local.example`
> → `.env.local` and fill them in. **`.env.local` is gitignored — never commit it.**

### Secret / server-only

| Name | Purpose | Where read |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude (Sonnet 4.5) vision + quote analysis | `src/lib/claude.ts` |
| `GOOGLE_MAPS_API_KEY` | Geocode + Street View + satellite imagery for address analysis | `src/lib/googleMaps.ts` |
| `SUPABASE_URL` | Supabase project URL | `src/lib/supabase.ts` |
| `SUPABASE_ANON_KEY` | Supabase anon key (RLS-bound client; read server-side here) | `supabase.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Service-role key — bypasses RLS. God-mode. Server-only, never to the browser.** | `supabase.ts` |
| `ADMIN_SECRET` | Shared secret gating all admin mutations (`x-admin-secret` header) | 4 API routes (quotes, quotes/[id], video, homeworks/send) |
| `HIGHLEVEL_API_KEY` | HighLevel/GoHighLevel CRM Private Integration token (`pit-…`) | `integrations/highlevel.ts` |
| `HIGHLEVEL_LOCATION_ID` | HighLevel location (sub-account) ID | `integrations/highlevel.ts` |
| `HIGHLEVEL_PIPELINE_ID` | Holiday Lights sales pipeline ID | `api/integrations/highlevel/attach/route.ts` |
| `HIGHLEVEL_STAGE_QUOTE_CREATED` | Stage: new quote built | attach route |
| `HIGHLEVEL_STAGE_QUOTE_SENT` | Stage: quote sent to customer | `quotes/[id]/send/route.ts` |
| `HIGHLEVEL_STAGE_QUOTE_INTERESTED` | Stage: customer approved on portal | `quotes/[id]/approve/route.ts` |
| `HIGHLEVEL_STAGE_QUOTE_SIGNED` | Stage: home.works reports signature | `api/integrations/homeworks/signed/route.ts` |
| `HOMEWORKS_ZAPIER_WEBHOOK_URL` | Zapier Catch Hook for outbound quote→home.works | `integrations/homeworks.ts` |
| `HOMEWORKS_SIGNED_SECRET` | Shared secret validating the inbound signature webhook (`x-homeworks-secret`) | `api/integrations/homeworks/signed/route.ts` |
| `NODE_ENV` | Framework-set; gates error-stack exposure in API responses | 3 API routes (set automatically by Next.js — you don't define it) |

### Public (`NEXT_PUBLIC_*`, shipped to the browser — never put secrets here)

| Name | Purpose | Where read |
|---|---|---|
| `NEXT_PUBLIC_PORTAL_LEADER_NAME` | Portal display name in copy/CTAs (e.g. "Naldo") | `lib/portal/adapter.ts` + portal pages |
| `NEXT_PUBLIC_PORTAL_PHONE` | "Text Naldo" tap-to-call number shown on portals | portal pages |
| `NEXT_PUBLIC_PORTAL_WEEKLY_BOOKINGS` | Scarcity banner: weekly bookings count | `lib/portal/adapter.ts` |
| `NEXT_PUBLIC_PORTAL_BOOKED_THROUGH_DATE` | Scarcity banner: "booked through" date copy | `lib/portal/adapter.ts` |
| `NEXT_PUBLIC_PORTAL_WALKTHROUGH_VIDEO_ID` | Global YouTube walkthrough video ID for all portals (public ID, not a secret) | `lib/portal/adapter.ts` |

**Discrepancies found during the scan (flag for Naldo):**
- `HIGHLEVEL_STAGE_QUOTE_INTERESTED` was **used in code but missing from `.env.local.example`** — it has now been **added** to the example. Make sure your real `.env.local` sets it, or customer approval will silently fail to advance the CRM stage.
- `.env.local.example` references a dev script `scripts/list-highlevel-pipelines.ts` that **does not exist** in the repo (comment softened). Use `listPipelines()` from `src/lib/integrations/highlevel.ts` to discover pipeline/stage IDs.

---

## 3. Third-party accounts & how to get access

Every external dependency is **config-gated** — the app boots and runs with any subset configured (each integration has an `isXConfigured()` check and degrades gracefully). So you can start with just Supabase + Anthropic and add the rest as access arrives.

| Service | What it's for | How you get access |
|---|---|---|
| **Supabase** | Postgres DB (quotes, corrections, training, reference assets, designs) + private Storage bucket (`designs`) | Naldo invites you to the Supabase **project** (Supabase dashboard → Project → Settings → Members → Invite). You copy `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY` from Settings → API. **The service-role key is god-mode — handle per the security note below.** |
| **Anthropic (Claude)** | Vision photo analysis + quote measurement (`claude-sonnet-4-5`) | Naldo adds you to the Anthropic **Console** org (console.anthropic.com → Settings → Members) or shares a scoped API key out-of-band. |
| **Google Maps Platform** | Geocoding + Street View + satellite imagery for address-based analysis | `GOOGLE_MAPS_API_KEY` — Naldo shares it or grants Cloud project access. |
| **HighLevel / GoHighLevel** | CRM: contact lookup + sales-pipeline sync | Naldo creates a **Private Integration** (app.gohighlevel.com → Settings → Private Integrations → New, scoped to contacts + opportunities + pipelines, read+write) and shares the `pit-…` token + `HIGHLEVEL_LOCATION_ID`. Pipeline/stage IDs come from `listPipelines()`. |
| **Zapier ↔ home.works** | Estimate hand-off (outbound) + signature callback (inbound), both via Zapier Catch Hooks | Naldo shares the `HOMEWORKS_ZAPIER_WEBHOOK_URL` (must be a `hooks.zapier.com` catch-hook) and the `HOMEWORKS_SIGNED_SECRET`. To edit the Zaps themselves, Naldo invites you to the Zapier account/workspace. |
| **`ADMIN_SECRET`** | Not a third party — a shared secret you set yourself in `.env.local` to gate admin routes. Naldo shares the value he uses (so prod + your dev agree) or you pick your own for local dev. |

### Security note on shared credentials
Real secret values must reach you through a **secure private channel** — a 1Password/Bitwarden secure share or a direct encrypted message — **never** the repo, a commit, an issue, a doc, or chat. The single most dangerous value is `SUPABASE_SERVICE_ROLE_KEY` (bypasses all Row Level Security). Treat it like a root password.

---

## 4. First run, end to end

```bash
git clone https://github.com/Yule-Love-Lights/yll-quote-tool.git
cd yll-quote-tool
npm install
cp .env.local.example .env.local      # then fill in real values received out-of-band
npm run dev                            # http://localhost:3000  (Claude Code: prefix with `unset ANTHROPIC_API_KEY;`)
```

Useful URLs once it's up:
- `/quote/new` — operator quote builder (the main internal tool)
- `/admin/quotes` — quote list + edit/portal/video links + "send to customer"
- `/portal/[quoteId]` — the live customer-facing portal (the Snowglobe design, real DB data)

Then read **`docs/CURRENT_STATE.md`** (what's done vs. half-done vs. fragile) and **`docs/CONVENTIONS.md`** (how to add code without breaking patterns), and load the context snapshot per **`docs/context/README.md`**.
