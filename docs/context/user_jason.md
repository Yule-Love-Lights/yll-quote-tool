---
name: user-jason
description: Jason — developer who took over yll-quote-tool from Naldo (the original builder)
metadata: 
  node_type: memory
  type: user
  originSessionId: 81b4503b-ae8d-477f-bfc6-0d1c5656ffef
---

Jason is picking up the **yll-quote-tool** project from Naldo, who built it solo (see [[YLL Render Engine project]] and [[User profile — Naldo]]). Jason is the developer now; Naldo remains the business owner / domain expert.

- Has GitHub **write access** to `Yule-Love-Lights/yll-quote-tool`. Local git user is `100levelz`.
- **🆕 `gh` CLI installed + authed (S13, 2026-06-25):** GitHub CLI v2.95 (machine-wide, `C:\Program Files\GitHub CLI\gh.exe`) authed as `100levelz` (scopes incl. `repo`). **Claude opens + merges PRs directly now** — `gh pr create --base master --fill` → `gh pr merge <n> --merge --delete-branch` (matches the repo's merge-commit + branch-delete convention). NO more compare-link handoffs. ⚠️ Each PowerShell tool call is a fresh process → **reload PATH first**: `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`. Naldo's separate machine has NO gh (uses the Chrome extension). Still PR-not-master + own-area + surface customer-facing/shared changes for sign-off before merging.
- Works on **Windows 11 / PowerShell** (repo at `C:\Users\Jason\Desktop\YuleLoveLights\yll-quote-tool`).
- **Workflow preference:** never commit directly to `master` — work on short-lived branches (started on `jason/onboarding`) and merge via **Pull Request**. Run `npx tsc --noEmit` + `npm run lint` before every commit (no CI/hooks exist). Review `git diff --cached` before committing; never commit secrets.
- Secrets (incl. the god-mode `SUPABASE_SERVICE_ROLE_KEY`) arrive from Naldo via a secure out-of-band channel — never paste them into chat or commit them.
