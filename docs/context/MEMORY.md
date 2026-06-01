# AI Quote Tool — memory index

> Claude Code auto-loads these at session start. **Read order:** this index → latest `session_log.md` entry → `project_quote_tool.md` (Current state / Decisions confirmed / Next up). See `README.md` for the continuity system + start/close protocols. `docs/context/` in the repo is the **canonical shared copy** (Jason + Naldo work on different machines; local memory is seeded from it and synced back to it).

**Continuity (read first):**
- [Project state — READ FIRST](project_quote_tool.md) — current state at a glance, confirmed decisions (don't re-ask), run commands, gotchas, QA backlog, next up.
- [Session log](session_log.md) — running per-session continuity thread; newest entry on top.

**Reference:**
- [User — Jason](user_jason.md) — current dev (took over from Naldo); Windows/PowerShell, PR-not-master, GitHub `100levelz`.
- [User — Naldo](user_naldo.md) — owner; runs Yule Love Lights + Chick-fil-A; builds solo; not a working developer.
- [Render engine project](project_yll_render_engine.md) — locked render-pipeline decisions + the exact Gemini model-ID / REST-parsing gotchas. Most detailed legacy note.
- [Where to get secrets](project_secrets_access.md) — Vercel env vars are "Sensitive"/unreadable; pull values from the source accounts.
- [Empty ANTHROPIC_API_KEY gotcha](feedback_claude_code_env_override.md) — the Claude-Code shell sets it to `""`, overriding `.env.local`; unset before `npm run dev`.
- [npx skills add flags](feedback_npx_skills_add_flags.md) — minor tooling note.

> Deep, repo-side detail (source of truth for specifics): `docs/ONBOARDING.md`, `docs/CURRENT_STATE.md`, `docs/CONVENTIONS.md`.
> Note: two files from Naldo's live memory were intentionally excluded from the repo snapshot (his 2026 business goals + a separate WhatsApp project) — don't go looking for them here.
