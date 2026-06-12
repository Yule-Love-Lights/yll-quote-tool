---
name: project-secrets-access
description: "Where to actually get yll-quote-tool's secrets — Vercel stores them but as \"Sensitive\" so values can't be read back; pull from the source accounts instead."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 834b8d13-f89f-476d-bae1-0a9ab5613799
---

All env-var values for **yll-quote-tool** live in the Vercel project (`yll-quote-tool`, Production env, which tracks `master` → `quote.yulelovelights.com`) but are **marked "Sensitive."** Vercel will not show a Sensitive value again in the dashboard, the CLI (`vercel env pull`), or the API — only the live deployment can read it. So **Vercel is a dead end for retrieving secrets.**

Get the real values from the source accounts instead (Naldo grants access or shares out-of-band — never via chat/commit):
- **Supabase** (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) → Supabase dashboard → **Settings → API** (all three viewable, including the god-mode service-role key).
- **`ANTHROPIC_API_KEY`** → Anthropic Console (shown only once at creation; mint a new key if lost).
- **`GOOGLE_MAPS_API_KEY`** → Google Cloud Console → APIs & Services → Credentials. *(`GEMINI_API_KEY` is no longer used — removed in the #36 render teardown.)*
- **`ADMIN_SECRET`** → just pick your own for local dev; it only has to match between the app and the admin password prompt.

Then fill them into the gitignored `.env.local`. Separately, the empty-`ANTHROPIC_API_KEY` Claude-Code shell quirk still applies — unset it before `npm run dev`. Also: a few Vercel env-var **names** don't match what the code reads (e.g. `ZAPIER_HOMEWORKS_WEBHOOK_URL` vs the code's `HOMEWORKS_ZAPIER_WEBHOOK_URL`; the `HIGHLEVEL_*` vars are absent) — reconcile before the CRM/home.works features go live. See [[user-jason]].
