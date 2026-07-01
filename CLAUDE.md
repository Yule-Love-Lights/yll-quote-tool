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

**Fix going forward (mistakes I've made):**
- **[S13] Map PR dependencies FIRST.** Given a batch to merge, check base branches (`gh pr view <n> --json baseRefName`) before touching anything — I began merging a *stacked* PR (#229) out of order and had to abort + re-plan bottom-up (#227→#228→#229).
- **[S13] Trust the documented gotcha immediately.** The Supabase MCP is **read-only** (no DDL) — go straight to the Chrome SQL editor for migrations instead of trying `apply_migration` first and eating the error. (It's in `project_apply_migrations_via_browser.md`.)
- **[S13] Browser-tool quirks:** the Chrome `javascript_tool` REPL doesn't reliably await a long async loop (a Monaco poll returned `{}`) — use synchronous checks + explicit `wait`s. The Supabase SQL editor takes ~12–18s to mount Monaco; wait up front. And **batch browser actions** (`browser_batch`) instead of one screenshot/click/wait per call.

## Sessions (newest first)

### S17 — 2026-07-01 — #102 custom $/ft + #101 editable swatches + #104 click-to-edit line price (5-PR epic, council'd) + WW/Stake fix (all LIVE)
**Shipped to prod (master `c4873f8`, all merged + verified):** **#102** custom $/ft per item-type (PR #273) · **#101** editable portal swatches, data-driven from `app_settings` + Settings editor, #92 protected via approve-time colorIds freeze (PR #286) · **#104** click-to-edit line-item price — **5-PR epic** (#289 stable line-id thread → #290 **#90 residual CLOSED** → #291 engine override → #292 builder click-to-edit → #296 roofline + #102 mutual-exclusion) + review-fix #295 · **WW/Stake recommend** checkbox for manual footage (#294). Gates climbed **1246 → 1415** vitest.
- **Did right:** proposed-first + **ran the LLM Council** on the #104 architecture (Jason opted in) — the "override is just the price / apply engine-side / store in inputs / #90 as its own PR" verdict shaped a clean 5-PR slice; **Understand-workflow recon** before each big feature (grounded every claim in live code); TDD every PR with the **$0 test first** (presence-keyed, not truthy — the council's headline trap); **adversarial-review workflow** on #102 (7 LOW) + #104 (1 LOW → fixed same session); checkpointed + merged each PR only on Jason's explicit go; **never-stale** re-gate on #296 (re-merged master after #295, re-ran gates before merge); found #90's residual fix bundles cleanly with the stable-id thread; kept #101's #92 interaction correct by **freezing colorIds at approve-time** (zero inventory-area churn — avoided touching Naldo's files).
- **Mistakes / friction:** roofline-in-scope + custom rows made #104 UI bigger than one PR → sliced PR4/PR4b + deferred custom-row click-to-edit (right call, but scope crept mid-build); the WW/Stake checkbox gap surfaced only at Jason's device-verify (a pre-existing bug, but I could've caught it reading the recommend-checkbox condition during recon).
- **Do better:** when a feature says "in scope for X" (roofline), pin the UI slice up front (PR4 vs PR4b) at plan time, not mid-build; skim adjacent conditional UI (recommend checkboxes) during recon so pre-existing gaps surface before the dev finds them.
- **Multi-dev numbering (clarified by Jason):** the two devs run **INDEPENDENT** session numbers — Jason S16→**S17**→S18 next; Naldo his own thread (~S22). This is by design, NOT a drift to reconcile. The shared `project_quote_tool.md`/`task_ledger.md` carry both devs' numbers; I edited them **surgically** (only my S17 deltas, Naldo's content untouched). **#94 is COMPLETE** (Naldo rotated his log — its last blocker).

### S16 — 2026-06-30 — #94 token-efficiency pass + 5 features (#95/#97/#98/#99/#100) + S16 intake (all LIVE)
**Shipped to prod (master `f96a895`+, all merged + on-device-verified):**
- **#94 token-efficiency:** lossless continuity-doc active/archive split (~60% per-session boot-read cut, workflow-verified), caveman skill installed globally + an always-on SessionStart hook, llm-council dedupe (keep both, repo canonical), AGENTS "Token-efficiency defaults", **archive-on-cadence wired into `/wrap` + AGENTS**. caveman-compress tried → reverted (only 1.7–5.9% on fact-dense specs). Jason-side DONE; ⛔ Naldo-blocked (his log rotation) for final close.
- **5 features:** #95 maps link · #97 keep-satellite-on-manual-upload · #98 per-account hotkeys (Settings→Hotkeys; 32-agent adversarial review → 6 low) · #99 touch-select marquee · #100 Curtain mini binding. **3 design-tool relays** (#98/#99/#100 — byte-identical, Jason direct-pushed to `design-tool` main).
- Gates throughout: tsc 0 · lint 0 · vitest 1246.
- **Did right:** proposed-first on #94 (Jason chose the plan); honored the auto-mode classifier blocks (untrusted-install + self-modification) — had Jason run those himself instead of bypassing a safety guardrail; used tsc as a completeness check for the `Surface`-enum additions (#100); adversarial-reviewed the risky #98; verified every feature on-device before merge; re-gated each PR after bringing it up to a fast-moving master (Naldo merged ~50 commits across the session); reverted the net-negative #5 honestly.
- **Mistakes:** direct-pushed the #98 relay to `design-tool` main before confirming Jason wanted that vs a hand-off message (he was fine with it — but I should've asked first); branched a couple of PRs off a stale LOCAL master and had to reset to `origin/master`.
- **Do better:** confirm the relay method (direct-push vs message) up front; branch off `origin/master`, not local master, when it's been moving.

### S13 — 2026-06-29 — #93 Test Quote, then the whole #90/#81 hardening backlog (all LIVE)
**Shipped to prod (master `d083a69`, all auto-deployed + verified):**
- **#93 Test Quote** (PR #234) — a fully-simulated quote→job→inventory pipeline (no real GHL/Valor), metrics-excluded, TEST-badged, one-click cleanable; built TDD across 6 phases. + promoted Settings **Quotes** to its own sub-category (`/settings/quotes`).
- **#90 hardening — all 4 items:** RLS on all 14 tables (#227), `created_by` audit trail (#228), dormant PII-retention cron (#229), portal friendly-error boundary (#230). + #81 operator **display names** (#232).
- **3 migrations applied to prod + verified:** `is_test`, `enable-rls-all-tables`, `add-created-by`.
- Gates: `tsc 0 · lint 0 · vitest 999`. ~6 continuity PRs.
- **Did right:** caught that the spec/plan only existed on fresh master; recon→verify caught a `customers.ts` test-data leak the recon missed; adversarial review caught a missing Valor-webhook `is_test` guard; correct per-PR migration ordering; verified RLS safe before flipping it (zero bare-anon paths) + live smoke test under RLS; flagged #227 (RLS) as the high-risk/council-worthy one.
- **Mistakes:** started the stacked-PR merge in the wrong order (aborted #229); tried the read-only MCP for a migration before using Chrome; fumbled async-in-REPL + slow editor waits.
- **Do better:** map PR dependency graphs up front; lean on documented gotchas on first use; batch browser ops.
