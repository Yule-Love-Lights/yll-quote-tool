@AGENTS.md

# Assistant session journal & self-review (running)

> Naldo asked me (the assistant) to keep this: a running log of what ships each
> session, an honest tally of what I get right vs. wrong, and a short retro so the
> work compounds instead of repeating mistakes. It loads every session via
> CLAUDE.md — **read the Scorecard first; it's the actionable part.** Newest
> session on top. Keep per-session detail short (the full narrative lives in
> `docs/context/session_log_naldo.md`); archive old sessions here once it grows.

## Running scorecard (cumulative — skim before starting work)

**Keep doing (these worked):**
- Branch off **FRESH `origin/master`**, never the worktree's stale base — first confirm the spec/plan commits are actually present (mine weren't until I rebased).
- Re-ground the exact lines before planning, **then independently verify the recon** — a fast read-agent missed a real data leak and cited a stale file; my own grep caught both.
- TDD + run all three gates (`tsc · lint · vitest`) **after every phase**, not just at the end.
- Run the adversarial review before merge — and **disposition** each finding (fix / accept-as-parity / process). Don't blindly "fix" a pattern that matches existing prod code.
- Apply migrations to prod **before** merge, and reason about ORDER per migration: a column-add is **migration-first** (column must exist before the code writes/reads it); enabling RLS is **code-first** (ship the service-role switch first so RLS can't break the old anon code).
- "**Never merge stale**": re-merge master + re-gate **every** PR before merging; check the cross-cutting logical interaction, not just text conflicts.
- Verify safety before an irreversible prod op (grepped for bare-anon data paths before enabling RLS; smoke-tested the live app after).
- Surface the high-risk / council-worthy / shared-file calls and confirm outward-facing actions instead of rubber-stamping.
- **[S15] For tooling/config asks too: verify actual on-disk + git state** (`ls` / `git ls-files` / `.gitignore`) before asserting how something works or acting — caught that `karpathy`/`llm-council`/`wrap` were repo-ONLY (not global), which flipped what "install" meant (copy repo→global, not a registry fetch).
- **[S15] Push back on over-broad asks** — declined to bulk-copy 142 global skills into the repo (plugin bundles belong per-machine); offered the minimal correct subset instead.
- **[S15] Match an always-load wiring to the skill's real nature** — `karpathy` as always-apply vs `wrap` as a project-scoped *trigger*, not a blanket "load both at session start."

**Fix going forward (mistakes I've made):**
- **[S13] Map PR dependencies FIRST.** Given a batch to merge, check base branches (`gh pr view <n> --json baseRefName`) before touching anything — I began merging a *stacked* PR (#229) out of order and had to abort + re-plan bottom-up (#227→#228→#229).
- **[S13] Trust the documented gotcha immediately.** The Supabase MCP is **read-only** (no DDL) — go straight to the Chrome SQL editor for migrations instead of trying `apply_migration` first and eating the error. (It's in `project_apply_migrations_via_browser.md`.)
- **[S13] Browser-tool quirks:** the Chrome `javascript_tool` REPL doesn't reliably await a long async loop (a Monaco poll returned `{}`) — use synchronous checks + explicit `wait`s. The Supabase SQL editor takes ~12–18s to mount Monaco; wait up front. And **batch browser actions** (`browser_batch`) instead of one screenshot/click/wait per call.
- **[S15] Flag a pointless step BEFORE doing it, not after.** Copied `wrap` to global on a batch request, THEN noted it's near-useless there (it's AI-Quote-Tool-scoped). When one item in a batch doesn't fit, say so first and offer to skip it.
- **[S15] Name the two-CLAUDE.md split up front.** Global `~/.claude/CLAUDE.md` (personal, all projects) vs project `CLAUDE.md` (this journal) — the "which file?" ambiguity surfaced twice this session. State the split on the first "update my CLAUDE.md"-type ask.

## Sessions (newest first)

### S15 — 2026-06-30 — skills/config housekeeping (no code shipped)
**A tooling/config session — no feature, no gates run (none needed). (Journal had skipped S14 — the reprise dark-box fix; it lives in `session_log_naldo.md`.)**
- **Explained skill install scopes:** global `~/.claude/skills/` (per-machine, your `-g` default) vs project `.claude/skills/` (git-tracked via `.gitignore` `!.claude/skills/`, shared w/ Jason). Install ≠ committed; nothing chains repo↔global automatically.
- **Diffed global vs repo skills** — 142 in global not in repo; advised AGAINST bulk-copying (gsd-*/seo-*/firecrawl-*/caveman-* plugin bundles belong per-machine).
- **"Installed" `karpathy-guidelines`, `llm-council`, `wrap`** → these were repo-ONLY (not global); copied repo→`~/.claude/skills/`, verified all 3 `SKILL.md` present.
- **Edited GLOBAL `~/.claude/CLAUDE.md`** — added a "Skills — load every session" section: `karpathy` always-apply; `wrap` scoped to AI Quote Tool + trigger-based (won't auto-run in other repos).
- **Explained `/wrap`** (4 steps: gates → continuity memory → PR off fresh master, never auto-merge → handoff) + how to extend it (edit `.claude/skills/wrap/SKILL.md`); flagged the two-copy staleness gotcha.
- **Did right:** grounded every claim in real state (ls/git ls-files/.gitignore) — caught the repo-only-vs-global inversion before acting; asked which skill instead of guessing; pushed back on the 142-skill bulk copy; matched each skill's load-rule to its real nature.
- **Mistakes:** copied `wrap` to global before flagging it's near-useless there (project-scoped); let the two-CLAUDE.md ambiguity surface twice instead of naming the split up front.
- **Do better:** flag a non-fitting batch item before executing; state the global-vs-project CLAUDE.md split on the first "update my CLAUDE.md" ask.

### S13 — 2026-06-29 — #93 Test Quote, then the whole #90/#81 hardening backlog (all LIVE)
**Shipped to prod (master `d083a69`, all auto-deployed + verified):**
- **#93 Test Quote** (PR #234) — a fully-simulated quote→job→inventory pipeline (no real GHL/Valor), metrics-excluded, TEST-badged, one-click cleanable; built TDD across 6 phases. + promoted Settings **Quotes** to its own sub-category (`/settings/quotes`).
- **#90 hardening — all 4 items:** RLS on all 14 tables (#227), `created_by` audit trail (#228), dormant PII-retention cron (#229), portal friendly-error boundary (#230). + #81 operator **display names** (#232).
- **3 migrations applied to prod + verified:** `is_test`, `enable-rls-all-tables`, `add-created-by`.
- Gates: `tsc 0 · lint 0 · vitest 999`. ~6 continuity PRs.
- **Did right:** caught that the spec/plan only existed on fresh master; recon→verify caught a `customers.ts` test-data leak the recon missed; adversarial review caught a missing Valor-webhook `is_test` guard; correct per-PR migration ordering; verified RLS safe before flipping it (zero bare-anon paths) + live smoke test under RLS; flagged #227 (RLS) as the high-risk/council-worthy one.
- **Mistakes:** started the stacked-PR merge in the wrong order (aborted #229); tried the read-only MCP for a migration before using Chrome; fumbled async-in-REPL + slow editor waits.
- **Do better:** map PR dependency graphs up front; lean on documented gotchas on first use; batch browser ops.
