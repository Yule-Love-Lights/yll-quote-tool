---
name: deploy-vercel
description: "How the quote tool deploys (Vercel + Supabase): the prod URL, the Git-connection gotcha that froze prod for ~7 weeks, and env-var parity. Check here first if prod looks stale or shows 'not configured'."
metadata:
  node_type: memory
  type: reference
  originSessionId: 834b8d13-f89f-476d-bae1-0a9ab5613799
---

# Deployment — Vercel + Supabase (quote tool)

**Prod:** Vercel project `yll-quote-tool` (team **Naldoven Seizeme**, now **Pro**) → **quote.yulelovelights.com**. Production branch = **`master`**; auto-deploys on push once the Git integration is healthy. Backed by the real/prod Supabase (same DB the dev server uses).

## ⚠️ The big gotcha (found + fixed S9, 2026-06-17)
**Prod had been frozen at an Apr 23 build for ~7 weeks** — every merge since (#36 → #32, all of S7–S9) never deployed, and nobody noticed because the tool isn't customer-facing yet. **Cause:** the Vercel project's **Git connection pointed at `naldoven/yll-quote-tool`** (a personal repo) and showed **"Error: Project Link not found"**, while all dev moved to the org repo **`Yule-Love-Lights/yll-quote-tool`**. So pushes to the org repo never reached Vercel, and no builds were *failing* — none were *triggered*. **Fix:** Settings → Git → **Reconnect** to `Yule-Love-Lights/yll-quote-tool` (Jason did it; needs GitHub auth/org grant — a human step). Reconnecting does NOT auto-deploy HEAD; trigger one deploy (a push, or Vercel "Create Deployment" of latest `master`) to catch up, then future pushes auto-deploy.

**If prod ever looks stale again:** check Vercel → Deployments (is the latest `master` commit there? any failed builds?) and Settings → Git (is it still connected to `Yule-Love-Lights/yll-quote-tool`?). Probe quickly from the shell: `curl -s -o /dev/null -w "%{http_code}" https://quote.yulelovelights.com/settings` (a route that only exists since #32 — 200 = current build, 404 = stale).

## Env-var parity (dev `.env.local` ⇄ Vercel)
"Feature works on dev but errors on prod ('X not configured. Set Y in .env.local')" almost always = **that env var is in local `.env.local` but missing on Vercel.** Fix by adding it in Vercel → Environment Variables (scope **Production + Preview**), value copied from `.env.local`, then **redeploy**. As of S9 close, Jason added the missing **`HIGHLEVEL_*`** (7) + **`NEXT_PUBLIC_PORTAL_*`** (5) so prod matches dev.
- **`NEXT_PUBLIC_*` are baked in at BUILD time** → they only take effect on a fresh deploy; always redeploy after adding/changing them.
- **NEVER add `SUPABASE_DB_URL` to Vercel** — it's a local-only direct-Postgres URL for running migrations via `psql`; the app never reads it at runtime.
- Two Vercel vars are **mis-named** vs the code (`GOHIGHLEVEL_WEBHOOK_SECRET`, `ZAPIER_HOMEWORKS_WEBHOOK_URL`); the code reads `HOMEWORKS_ZAPIER_WEBHOOK_URL`/`HOMEWORKS_SIGNED_SECRET`. Home.works is being dropped (#16), so leave them.
- **Claude can't enter secret values into Vercel** (API keys/tokens) — hand Jason the key-name list; he pastes values from `.env.local`. See [[where-to-get-secrets]].

## Migrations
Schema changes are applied to **prod Supabase directly** (Claude via `psql` + `SUPABASE_DB_URL`, with Jason's per-instance OK each time — it's not standing consent). Migrations live in `migrations/*.sql` (idempotent). Reconnecting Git / redeploying does NOT run migrations — they're applied out-of-band. As of S9: `app_settings`, `custom_uploads` + the public `custom-uploads` bucket are applied.
