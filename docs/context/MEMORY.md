# Project memory index (snapshot)

> Snapshot of the Claude Code project memory relevant to **yll-quote-tool**, taken 2026-05-29 for the handoff to Jason. See `README.md` in this folder for what these are and how to load them. This is a point-in-time copy, not a live link — it will drift from the machine's live memory.

- [User profile — Naldo](user_naldo.md) — owner context: runs Yule Love Lights (LI holiday lighting) + Chick-fil-A Director of Ops; builds solo; not a working developer.
- [YLL Render Engine project](project_yll_render_engine.md) — the locked-in design decisions for `src/lib/rendering/` (Option D: sharp composite + mask → Gemini 3 Pro Image), brand aesthetic, Phase 1 "shipped + validated" notes, and the exact Gemini model-ID / REST-parsing gotchas. **Most important file here.**
- [Claude Code empty ANTHROPIC_API_KEY gotcha](feedback_claude_code_env_override.md) — a Claude-Code-shell quirk: the inherited shell sets `ANTHROPIC_API_KEY=""` which silently overrides `.env.local`; `unset` it before `npm run dev` or Claude API routes return 503.
- [npx skills add flags](feedback_npx_skills_add_flags.md) — minor tooling note for this machine's dev environment.

## Intentionally excluded from this snapshot

Two files that exist in the live memory folder were **omitted** from the repo:

- `project_yll_goals.md` — Naldo's 2026 business goals; contains **sensitive business financials** and belongs to a separate ("Naldo's Brain") project, not the quote tool. Omitted for sensitivity + scope.
- `project_naldos_brain.md` — the separate WhatsApp "second brain" project; out of scope for this repo. Omitted.

No API keys, tokens, or secrets were present in any memory file; nothing needed redaction beyond the two omissions above.
