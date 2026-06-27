# AI Quote Tool — memory index

> Claude Code auto-loads these at session start. **Read order:** this index → latest entry of BOTH session logs (`session_log.md` = Jason's, `session_log_naldo.md` = Naldo's) → `project_quote_tool.md` (Current state / Decisions confirmed / Next up). See `README.md` for the continuity system + start/close protocols. `docs/context/` in the repo is the **canonical shared copy** (Jason + Naldo work on different machines; local memory is seeded from it and synced back to it).
>
> **🤝 Two devs (Jason + Naldo):** Naldo owns the dashboard (#58, `/`), Jason owns everything else. Full collaboration rules (branches, area ownership, review/merge, the anti-clobber memory convention) live in **`AGENTS.md` → "Multi-dev collaboration"**. **Per-dev session logs** — edit ONLY your own (`session_log.md` / `session_log_naldo.md`); `task_ledger.md` + `project_quote_tool.md` stay unified (sync off fresh master so git auto-merges).

**Continuity (read first):**
- [Project state — READ FIRST](project_quote_tool.md) — current state at a glance, confirmed decisions (don't re-ask), run commands, gotchas, QA backlog, next up.
- [Session log — Jason](session_log.md) — Jason's per-session continuity thread; newest entry on top.
- [Session log — Naldo](session_log_naldo.md) — Naldo's per-session thread (dashboard area, #58); newest on top. Each dev edits ONLY their own log.
- [Task ledger](task_ledger.md) — the single clean renumbered master task table (done / planning / backlog / Naldo-pending) with size + status. LIVING DOC — the source of truth for tasks.
- [Task #8 — AI training-system refinement](task_ai_training_refinement.md) — LIVING doc for task #8 (the photoAnalysis few-shot loop). **#8 Stage A→C4 SHIPPED (S7–S8): capture → similarity retrieval → learn-from-mistakes + satellite self-check + garland sections. Only C6 (per-detection confidence) deferred.** Read when resuming #8.
- [Design-tool integration plan (Path B)](project_integration.md) — JOINT initiative (task #27): absorb the **design tool** (the separate Konva canvas app that draws glowing lights on house photos) INTO this quote tool, store designs in Supabase, replace the static AI portal render with a live editable design, link line-items ⇄ scene-items. **CORE DONE & MERGED (S4–S5, #27): the design IS the master item list, lives on the portal, projects to per-unit line items; cores byte-identical with the design tool.** Living shared doc. The design tool's FULL context snapshot is in the repo at `docs/design-tool-context/`; design-tool repo on disk: `C:\Users\Jason\Desktop\YuleLoveLights\Claude`.
- [Integration DATA CONTRACT](project_integration_data_contract.md) — the keystone spec for #27: scene storage + the line-item ⇄ scene-item linkage (projection rules, roofline tier enum, surface tags, included flags). **#27 was built from it (S4–S5); contract evolved to ~v0.5.x.** Read for the linkage/projection details.
- [Inventory system plan (#82)](project_inventory_system.md) — epic vision capture (Jason S14): warehouse on-hand stock + design→materials-list projection + the YLL **clip-rules engine** + a job **Kanban** (deposit-paid trigger) + [later] WhatsApp/ordering. **🔴 Blocked on Naldo's input** (clip table, per-item stock fields, phasing) before decomposing into sub-tasks — see the doc's §10 "Open questions for Naldo".

**Reference:**
- [User — Jason](user_jason.md) — current dev (took over from Naldo); Windows/PowerShell, PR-not-master, GitHub `100levelz`.
- [User — Naldo](user_naldo.md) — owner; runs Yule Love Lights + Chick-fil-A; builds solo; not a working developer.
- [Naldo machine onboarding](ONBOARDING_NALDO.md) — concrete step-by-step to set up the quote tool on Naldo's machine (code, secrets, seed memory, graphify, dev server, gates).
- [Render engine project](project_yll_render_engine.md) — ⚰️ HISTORICAL: the Gemini render pipeline was fully REMOVED in #36 (S7, 2026-06-12). Keep only as the record of what was built.
- [Where to get secrets](project_secrets_access.md) — Vercel env vars are "Sensitive"/unreadable; pull values from the source accounts.
- [Deployment — Vercel + Supabase](project_deploy_vercel.md) — prod = quote.yulelovelights.com (Vercel, `master` auto-deploy) on real Supabase. **Check first if prod looks stale or shows "X not configured":** the Git-connection gotcha that froze prod ~7 weeks (wrong repo), env-var parity (`.env.local` ⇄ Vercel), `NEXT_PUBLIC_*` baked at build, never add `SUPABASE_DB_URL`.
- [Empty ANTHROPIC_API_KEY gotcha](feedback_claude_code_env_override.md) — the Claude-Code shell sets it to `""`, overriding `.env.local`; unset before `npm run dev`.
- [Memory/log update cadence](feedback_memory_log_cadence.md) — pause to refresh memory + logs around task completion / before committing.
- [Verify-before-commit handoff](feedback_verify_handoff.md) — at task end, give Jason **full clickable URLs** + test steps to self-verify BEFORE committing; wait for his go-ahead.
- [npx skills add flags](feedback_npx_skills_add_flags.md) — minor tooling note.

> Deep, repo-side detail (source of truth for specifics): `docs/ONBOARDING.md`, `docs/CURRENT_STATE.md`, `docs/CONVENTIONS.md`.
> Note: two files from Naldo's live memory were intentionally excluded from the repo snapshot (his 2026 business goals + a separate WhatsApp project) — don't go looking for them here.
