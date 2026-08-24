### Naldo S15b — skills/config housekeeping: 3 project skills installed to global, karpathy+wrap wired into global CLAUDE.md, journal self-review (NO code shipped) (2026-06-30)

> A pure tooling/config session — no feature, no migration, no gates run (the only repo delta is a markdown journal edit). Clarified how skills install, fixed up global config, and did the running self-review.

- **Explained skill install scopes.** Global `~/.claude/skills/` (per-machine; my `npx skills add -g` default lands here) vs project `.claude/skills/` (git-tracked via `.gitignore` `.claude/*` + `!.claude/skills/`, shared with Jason). Install ≠ committed; nothing chains repo↔global automatically; "share with Jason" = install project-scoped then commit+PR.
- **Diffed global vs repo skills** — 142 in global not in repo. Advised AGAINST bulk-copying: the `gsd-*`/`seo-*`/`firecrawl-*`/`caveman-*` families are plugin bundles that belong per-machine, not in the repo.
- **Installed the 3 project skills to global.** `karpathy-guidelines`, `llm-council`, `wrap` were repo-ONLY (not in global); copied repo→`~/.claude/skills/`, verified all 3 `SKILL.md` present. (Note: `wrap` globally is near-useless — it's AI-Quote-Tool-scoped — flagged that.)
- **Edited GLOBAL `~/.claude/CLAUDE.md`** (personal, all-projects — NOT the repo) — added a "Skills — load every session" section: `karpathy` always-apply; `wrap` scoped to the AI Quote Tool + trigger-based so it won't auto-run in other repos.
- **Project `CLAUDE.md` journal** — added the S15 self-review entry + 5 scorecard items (this PR's only repo change). Noted the journal had **skipped S14** (the reprise dark-box fix; it lives here in this log) and realigned numbering.
- **Did right:** grounded every claim in real state (`ls`/`git ls-files`/`.gitignore`) — caught the repo-only-vs-global inversion that flipped what "install" meant; asked which skill instead of guessing; pushed back on the 142-skill bulk copy; matched each skill's load-rule to its real nature.
- **Mistakes:** copied `wrap` to global before flagging it's near-useless there; let the two-CLAUDE.md (global vs project) ambiguity surface twice. Both logged in the journal "Fix going forward."
- **Cross-dev:** Jason is on **S16** — his `s16-caveman-compress-refs` sync (master `7371e19`, PR #259) compressed/archived the shared docs and **edited `.claude/skills/wrap/SKILL.md`, `AGENTS.md`, `task_ledger.md`, `project_quote_tool.md`** + added `*_archive.md` files. Per-dev session counters have diverged (Jason S16, Naldo S15) — reconcile if a unified counter is wanted. My repo's `wrap` SKILL.md will update to his version on next pull (my global copy is now behind).


