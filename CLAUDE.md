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
- **[S15] Re-check a plan's premises against CURRENT master before building on them.** The dashboard branch was ~40 commits behind; a documented Phase-0 blocker (legacy-table RLS) had already shipped in #90, so that work was moot. A 2-minute `git log origin/master` saved redundant effort and corrected the plan.
- **[S15] Honor hard guardrails by DESIGN, not just by avoidance** — built a dependency-free Gmail REST client to respect "no `npm install`", and kept every live GHL/Gmail write coded-but-dormant (fires only on a real operator action). Constraints shape the architecture; they don't have to block the feature.

**Fix going forward (mistakes I've made):**
- **[S15] NEVER pipe `tsc` through `tail`/`head`/`grep`** — the pipe's exit status masks tsc's non-zero code, so a real type error reads as green and gets committed (it did). Run `npx tsc --noEmit; echo "exit=$?"` and read the full output.
- **[S13] Map PR dependencies FIRST.** Given a batch to merge, check base branches (`gh pr view <n> --json baseRefName`) before touching anything — I began merging a *stacked* PR (#229) out of order and had to abort + re-plan bottom-up (#227→#228→#229).
- **[S13] Trust the documented gotcha immediately.** The Supabase MCP is **read-only** (no DDL) — go straight to the Chrome SQL editor for migrations instead of trying `apply_migration` first and eating the error. (It's in `project_apply_migrations_via_browser.md`.)
- **[S13] Browser-tool quirks:** the Chrome `javascript_tool` REPL doesn't reliably await a long async loop (a Monaco poll returned `{}`) — use synchronous checks + explicit `wait`s. The Supabase SQL editor takes ~12–18s to mount Monaco; wait up front. And **batch browser actions** (`browser_batch`) instead of one screenshot/click/wait per call.

## Sessions (newest first)

### S15 — 2026-06-29 — #58 Unified Customer Dashboard `/inbox` built end-to-end (draft PR #249, NOT merged/live)
**Built (branch `naldo/dashboard-foundation`, ~22 commits, draft PR #249):** the whole `/inbox` — every unresponded customer touch across **GHL + Gmail + Quote + Homeworks** in one queue. Escalation (amber>1h / red>4h / EOD ET, team emails + watchdog, sole owner of `notified_levels`), outbound auto-resolve, dismiss, **claim**, follow-ups + due-today strip, response-time/SLA stats, identity-merge (`/inbox/duplicates`), and the **Full Handled write-back** (GHL mark-read + tag + ensure-opportunity; Gmail `YLL/Handled` label). **Dependency-free Gmail REST client** (no googleapis). DRAFT migration (6 tables, RLS+policies — not applied). `tsc 0 · lint 0 · vitest 1040`; **7 verified adversarial reviews**, every confirmed finding fixed.
- **Hard lines held ALL session:** nothing applied/deployed; **no live GHL/Gmail write executed**; no `npm install`; no merge. Every external write is dormant until a real operator Handled click.
- **Did right:** TDD pure cores + all 3 gates after every wave; one adversarial review per delta with each finding dispositioned; respected the no-install line by design (dep-free Gmail); surfaced the quote-view-interest ambiguity instead of guessing (Naldo chose "create a follow-up"); closed the `sales@` self-ingest loop via from-us detection; caught + fixed a self-introduced reducer/escalation ownership bug before it shipped; flagged every go-live blocker + the shared-file edits for Jason.
- **Caught at close:** branch ~40 behind master; **#90 already did the legacy-RLS** the plan called a Phase-0 blocker → premise corrected. Merged master in **CLEAN (0 conflicts)** but **gates not yet re-run on the merged tree** → continuation prompt covers Step 0.
- **Mistakes:** piped `tsc` through `tail` once → masked a non-zero exit (committed a test type-error, caught next step) — use `tsc; echo $?`. Backtick in a `git commit -m` got shell-evaluated (cosmetic).
- **Next:** finish Step 0 (re-gate merged tree + push → PR merge-ready); then human-gated go-live — apply migration, set secrets (incl. Gmail OAuth), add Vercel crons (reconcile/quotetool/gmail-poll/escalate), GHL "Customer Replied" webhook, **GHL mark-read live test**, Jason reviews shared-file edits + supplies the GHL user↔person mapping.

### S13 — 2026-06-29 — #93 Test Quote, then the whole #90/#81 hardening backlog (all LIVE)
**Shipped to prod (master `d083a69`, all auto-deployed + verified):**
- **#93 Test Quote** (PR #234) — a fully-simulated quote→job→inventory pipeline (no real GHL/Valor), metrics-excluded, TEST-badged, one-click cleanable; built TDD across 6 phases. + promoted Settings **Quotes** to its own sub-category (`/settings/quotes`).
- **#90 hardening — all 4 items:** RLS on all 14 tables (#227), `created_by` audit trail (#228), dormant PII-retention cron (#229), portal friendly-error boundary (#230). + #81 operator **display names** (#232).
- **3 migrations applied to prod + verified:** `is_test`, `enable-rls-all-tables`, `add-created-by`.
- Gates: `tsc 0 · lint 0 · vitest 999`. ~6 continuity PRs.
- **Did right:** caught that the spec/plan only existed on fresh master; recon→verify caught a `customers.ts` test-data leak the recon missed; adversarial review caught a missing Valor-webhook `is_test` guard; correct per-PR migration ordering; verified RLS safe before flipping it (zero bare-anon paths) + live smoke test under RLS; flagged #227 (RLS) as the high-risk/council-worthy one.
- **Mistakes:** started the stacked-PR merge in the wrong order (aborted #229); tried the read-only MCP for a migration before using Chrome; fumbled async-in-REPL + slow editor waits.
- **Do better:** map PR dependency graphs up front; lean on documented gotchas on first use; batch browser ops.
