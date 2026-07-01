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
- **[S18] Verify UI in the ACTUAL browser** — tsc-green ≠ correct. A client/server import-boundary break (#52 dragged the server-only `sharp` chain into the client bundle) and a HIGH `/training/new` railing ship-blocker BOTH passed tsc (an `as` cast laundered the type) and surfaced only in-browser + in the adversarial review.

**Fix going forward (mistakes I've made):**
- **[S18] Widening a shared/analyzer type → grep EVERY consumer + stale narrow duplicate up front.** The railing detection type had two parallel narrow copies (`/training/new`, `QuoteBuilder`) hidden behind `as` casts that tsc didn't flag; only the review caught them. Before shipping a type widen, list every UI that displays/edits it.
- **[S13] Map PR dependencies FIRST.** Given a batch to merge, check base branches (`gh pr view <n> --json baseRefName`) before touching anything — I began merging a *stacked* PR (#229) out of order and had to abort + re-plan bottom-up (#227→#228→#229).
- **[S13] Trust the documented gotcha immediately.** The Supabase MCP is **read-only** (no DDL) — go straight to the Chrome SQL editor for migrations instead of trying `apply_migration` first and eating the error. (It's in `project_apply_migrations_via_browser.md`.)
- **[S13] Browser-tool quirks:** the Chrome `javascript_tool` REPL doesn't reliably await a long async loop (a Monaco poll returned `{}`) — use synchronous checks + explicit `wait`s. The Supabase SQL editor takes ~12–18s to mount Monaco; wait up front. And **batch browser actions** (`browser_batch`) instead of one screenshot/click/wait per call.

## Sessions (newest first)

### S18 — 2026-07-01 — Full Yule ceiling #107 · side-of-house #103 (+relay) · Street View #15 · text fonts #46 · edit training examples #52 · teach-AI-railings #108 (all LIVE)
**Shipped to prod (master `8acb338`, all merged + verified):** **#107** Full Yule ceiling headline + totals reorder + GHL card lifecycle (PR #298) · **#103** side-of-house F/B/L/R tag + byte-identical design-tool relay `dbc42a5` (PR #299) · **#15** Street View move along the street, snap nearest pano (PR #301) · **#46** editor text-tool fonts in the root layout (PR #302) · **#52** edit saved training examples inline — all detection types incl. railing/curtain (PR #304) · **#108 (new)** teach the analyzer to detect railings — curtains editable-only (PR #303). Gates **1415 → 1445** vitest.
- **Did right:** EnterPlanMode on #107 + grounded every feature via Explore agents before building; TDD; adversarial-reviewed the risky ones (#107 money-adjacent; #52+#108 training/AI); **split #52-editing vs teach-AI-railings into 2 focused PRs at Jason's call** + reviewed both; **never-stale** re-gate (B re-merged master after A landed → re-gated the combined tree at 1445); dispositioned every finding (fixed the ship-blocker + the money guards; accepted the low pre-launch ones); **caught a client-bundle break in-browser** (#52 dragged `sharp` in) + a HIGH `/training/new` railing ship-blocker in review that tsc missed; **confirmed the relay method up front** (asked before direct-push — the S16 "do better").
- **Mistakes / friction:** the #52 client/server import boundary bit me first (a runtime helper imported into a client page → `sharp` in the bundle) — the client-safe pure module fix was clean but should've been the FIRST design; the railing type-widen's two stale consumers (`/training/new`, QuoteBuilder) surfaced only in review, not tsc.
- **Do better:** grep ALL consumers before widening a shared/analyzer type; when adding an editor control, confirm the READ-ONLY view echoes it (the curtain edit "vanished" from the pieces-derived panel — flagged + tagged, not fully reconciled).

### S17 — 2026-07-01 — #102 custom $/ft + #101 editable swatches + #104 click-to-edit line price (5-PR epic, council'd) + WW/Stake fix (all LIVE)
**Shipped to prod (master `c4873f8`, all merged + verified):** **#102** custom $/ft per item-type (PR #273) · **#101** editable portal swatches, data-driven from `app_settings` + Settings editor, #92 protected via approve-time colorIds freeze (PR #286) · **#104** click-to-edit line-item price — **5-PR epic** (#289 stable line-id thread → #290 **#90 residual CLOSED** → #291 engine override → #292 builder click-to-edit → #296 roofline + #102 mutual-exclusion) + review-fix #295 · **WW/Stake recommend** checkbox for manual footage (#294). Gates climbed **1246 → 1415** vitest.
- **Did right:** proposed-first + **ran the LLM Council** on the #104 architecture (Jason opted in) — the "override is just the price / apply engine-side / store in inputs / #90 as its own PR" verdict shaped a clean 5-PR slice; **Understand-workflow recon** before each big feature (grounded every claim in live code); TDD every PR with the **$0 test first** (presence-keyed, not truthy — the council's headline trap); **adversarial-review workflow** on #102 (7 LOW) + #104 (1 LOW → fixed same session); checkpointed + merged each PR only on Jason's explicit go; **never-stale** re-gate on #296 (re-merged master after #295, re-ran gates before merge); found #90's residual fix bundles cleanly with the stable-id thread; kept #101's #92 interaction correct by **freezing colorIds at approve-time** (zero inventory-area churn — avoided touching Naldo's files).
- **Mistakes / friction:** roofline-in-scope + custom rows made #104 UI bigger than one PR → sliced PR4/PR4b + deferred custom-row click-to-edit (right call, but scope crept mid-build); the WW/Stake checkbox gap surfaced only at Jason's device-verify (a pre-existing bug, but I could've caught it reading the recommend-checkbox condition during recon).
- **Do better:** when a feature says "in scope for X" (roofline), pin the UI slice up front (PR4 vs PR4b) at plan time, not mid-build; skim adjacent conditional UI (recommend checkboxes) during recon so pre-existing gaps surface before the dev finds them.
- **Multi-dev numbering (clarified by Jason):** the two devs run **INDEPENDENT** session numbers — Jason S16→**S17**→S18 next; Naldo his own thread (~S22). This is by design, NOT a drift to reconcile. The shared `project_quote_tool.md`/`task_ledger.md` carry both devs' numbers; I edited them **surgically** (only my S17 deltas, Naldo's content untouched). **#94 is COMPLETE** (Naldo rotated his log — its last blocker).
