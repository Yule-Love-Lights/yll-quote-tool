<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Default coding practice — the Karpathy guidelines

Adopt these four principles by default when writing, reviewing, or refactoring **non-trivial** code (use judgment on trivial one-liners / typo fixes — don't over-apply rigor). Full detail in the `karpathy-guidelines` skill (`.claude/skills/karpathy-guidelines/SKILL.md`).

1. **Think before coding** — state assumptions; if multiple interpretations exist, surface them instead of picking silently; push back when a simpler approach exists; stop and ask when something's unclear.
2. **Simplicity first** — minimum code that solves the problem; no speculative features / abstractions / config / error-handling that wasn't asked for. If 200 lines could be 50, rewrite it.
3. **Surgical changes** — touch only what the request requires; match existing style; don't refactor or reformat unrelated code; flag unrelated dead code rather than deleting it; clean up only orphans your own change created.
4. **Goal-driven execution** — turn tasks into verifiable success criteria (e.g. a failing test → make it pass) and loop until they're met; state a brief plan for multi-step work.

**Verification before calling it "done" (scale it to the change).** After shipping a feature/fix: run the full gates (`tsc · lint · test`) green, then a self-review **sized to the risk**. Small change → a critical re-read of your own diff (watch for unreachable branches, a stale doc/route reference, a half-updated registry). **Customer-facing or risky** change → a full adversarial review (multi-agent), then disposition each finding. Don't fire a heavy review on a typo; don't ship a customer-facing change on a glance.

**Confirm a feature variant's exact scope before editing.** Adding a variant (a light pattern, a mini-light / spritzer type, a surface) → pin down *which* bulb types / surfaces / cases it applies to first; don't apply it broadly across all types unless asked. This is principle #1 in our domain — the #92 light-patterns build went smoothly precisely because the scope (minis vs spritzers vs C9, whole-house vs per-item) was nailed before any code.

**Pitfalls we've hit — don't repeat:**
- **Branch BEFORE you edit.** Create your `jason/`/`naldo/` feature branch *first* — never start editing on `master`'s working tree (even uncommitted), then scramble to move the changes onto a branch later.
- **Trace the full side-effect chain before presenting an approach** — especially for subtle gesture / shared-editor-core changes. (e.g. a `dragstart→stopDrag` plan had to be reversed mid-build once it was found to trigger `dragend→bake→mid-draw redraw`; verifying the whole chain first avoids approving-then-reversing.)
- **After a `git checkout` / branch switch, `Read` a file before you `Edit` it** — the harness requires a fresh read post-switch; doing it proactively avoids failed-edit retries.
- **Read the giant `task_ledger.md` surgically.** Its rows are enormous single lines — grab a narrow line-range or `grep -o` just the bit you need; don't pull whole sections into context (it's the biggest avoidable context drain in a long session).
- **Don't open a separate PR for every tiny docs/ledger tweak.** Batch the bundle-able ones into one PR or fold them into your session-close sync; only land a docs change on its own when something downstream needs it first (e.g. a rule before the work it governs).

# Codebase navigation — prefer the graphify graph for big-picture questions

A `graphify-out/` knowledge graph of `src/` may exist locally. It's **gitignored — per-machine, never committed**, so a fresh clone / another machine won't have one until it's built: `/graphify src` (free for code, ~seconds). The optional post-commit auto-rebuild hook (`graphify hook install`, also per-machine) then keeps it fresh on every commit.

- **When a graph exists** — for **architecture / cross-cutting** questions ("how does X flow", "what touches Y", "trace A → B") query it first with `graphify query "..."` instead of reading lots of files; it's cheaper and faster.
- **For targeted lookups** (one specific function / prop / line) — just grep/read; that's already the cheapest route and the graph isn't worth the overhead.
- **If no graph exists** (fresh clone / another machine) — grep/read, or build one first with `/graphify src`.

Staleness guards (the graph is a point-in-time snapshot and drifts):

- Treat it as a **map for orientation, not ground truth** — verify any file / function / line it cites against the live code before acting on it.
- If it seems unaware of recent work, fall back to grep/read.

# Token-efficiency defaults

Default habits to keep sessions cheap (S16 task #94):

- **graphify-first** for architecture / cross-cutting questions ("how does X flow", "what touches Y"); grep/read for targeted one-function/one-line lookups.
- **Read code surgically** — line-ranges / `Grep`, not whole 1800–4000-line files into context.
- **On long sessions, delegate broad searches** to compressed subagents (`cavecrew` / `Explore`) so tool-results stay small.
- **Batch independent tool calls** in one message.
- **Don't re-read** a file the harness already tracks as edited.
- **Keep continuity docs lean** — tight ledger Notes; completed tasks in `task_ledger_archive.md`; session logs keep only the latest ~3 (older in `session_log_archive.md`); `project_quote_tool` history in its archive.
- **The `caveman` skill compresses OUTPUT** — per-machine opt-in via a SessionStart hook.

**Skills placement.** Repo-shared skills live in `.claude/skills/` (git-synced to both devs); per-machine / global skills in `~/.claude/skills/`. Choose **repo** for team skills, **global** for personal. Don't keep the same skill in both (drift) — the **`llm-council` canonical copy is the repo one**.

# Multi-dev collaboration (Jason + Naldo)

Two devs work in this repo on **different machines**. **Naldo owns the dashboard** (the `/` homepage, task #58); **Jason owns everything else** (portal, quote builder, pricing engine, design editor, training, settings). Both **PR into `master` — never commit to `master` directly** — and run the gates (`npx tsc --noEmit` · `npm run lint` · `npm test`) green before committing. New-machine setup → `docs/context/ONBOARDING_NALDO.md`.

## Branches
- Prefix every branch with your name: **`jason/<desc>`** or **`naldo/<desc>`** (e.g. `naldo/dashboard-shell`). Instant attribution, no name clashes.
- Branch off fresh `master` (pull first); keep PRs small; merge `master` back in if a branch lives more than a day.

## Area ownership
| Owner | Files |
|---|---|
| **Naldo** | `src/app/page.tsx`, `src/components/dashboard/**`, `src/app/api/dashboard/**`, `src/lib/dashboard/**` |
| **Jason** | `src/app/portal/**`, `src/components/portal/**`, `src/app/quote/**`, `src/components/quote/**`, pricing (`pricingEngine` / `BUSINESS_RULES`), `src/components/design/**` + `editor-core/**`, training, settings |
| **SHARED — claim it first** | `src/app/layout.tsx`, `globals.css`, `package.json` + lockfile, the data layer (`src/lib/quotes.ts`, `designs.ts`, `supabase*`), shared types (`sceneTypes.ts`), tsconfig / eslint / next config |

*Reading* a shared file (e.g. importing from `src/lib/quotes.ts`) is always fine; only **editing** a SHARED file needs a heads-up to the other owner first.

## Review / merge
- **An AI assistant never merges on its own — a human says go.** Assistants may create, push, and open PRs, but must **not** merge to `master` without their operating dev's explicit go-ahead (Jason's assistant ← Jason; Naldo's assistant ← Naldo). `master` auto-deploys to prod, so a human approves every merge.
- **Own-area PRs: no cross-review needed** — a PR touching only your own area doesn't need the *other* owner's review (your own dev's go to merge still applies, per above).
- **SHARED-file PRs: the other owner reviews first** before merge.
- **Always merge current, never stale.** Before merging ANY PR, `git fetch`. If `master` has advanced past the branch's base, bring the branch up to date with `master` (merge `master` in or rebase, resolve any conflicts) and **re-run the gates (`npx tsc --noEmit` · `npm run lint` · `npm test`) on the updated branch** before merging. Never merge a branch whose green gates predate the current `master` — a clean text-merge can still be a logical regression when `master` changed underneath (e.g. a renamed export, a changed type, new business rules). This applies even to same-day branches, and strengthens the "merge `master` back in if a branch lives more than a day" guidance above into a hard pre-merge step. (Merging on GitHub combines the branch with origin's *current* `master` regardless of your local state, so this is about updating the **branch**, not just pulling local `master`.)
- **If the Bash tool is unavailable** (e.g. a transient safety-classifier outage, as happened in S12) don't silently stall on a git/gate step — surface a **ready-to-paste manual git sequence** (or gate commands) for the dev to run in their own terminal, then continue from the verified result.

## Shared memory (docs/context ⇄ local)

**Session numbering — one conversation = one session.** Never auto-increment or relabel the session number mid-conversation: an overnight pause + "good morning" resume does NOT advance it; only a *fresh conversation* does. Read the current number from the session logs at start and keep it fixed unless the dev explicitly says otherwise. (Hard-won — the premature "S13 CLOSE" mislabel in S12.)

Each machine's local `~/.claude/.../memory` seeds from + syncs back to the repo's `docs/context/` (the canonical mirror). To stop the two machines clobbering each other:
- **Session logs are per-dev** — Jason writes `session_log.md`, Naldo writes `session_log_naldo.md`. **Only ever edit your OWN log.** Read both at session start.
- **`task_ledger.md` + `project_quote_tool.md` stay unified** (one source of truth). Before copying local → `docs/context`, **branch your sync off a fresh `git pull origin master`** so your PR is only your delta on top of the latest shared state — git auto-merges non-overlapping edits; you only hand-resolve a literal same-line clash.
- **Sync = a PR off fresh master at your own session close** (PR-not-master applies to docs too). Seed a machine (pull master → copy `docs/context/*` to local) only when local has nothing unsynced.

# Big decisions — OFFER the LLM Council, never auto-run it

A project skill, **`llm-council`** (`.claude/skills/llm-council/SKILL.md`), runs a question through 5 independent advisors → anonymized peer review → a chairman verdict. It's valuable for **high-stakes, genuinely-uncertain calls** — task sequencing, architecture, customer-facing tradeoffs, "should we do X or Y."

**An AI assistant must NEVER run the council automatically.** Three reasons: each run spawns ~11 sub-agents (real token cost); "big decision" is a judgment call (auto-running guesses wrong and fires on the wrong things); and an unprompted council is a heavy mid-work interrupt. Instead, when a genuinely council-worthy decision comes up:

1. **Prompt the dev** (Jason or Naldo) — flag that this looks like a council-worthy decision.
2. **Give your recommendation** on whether it's actually worth running here, and why or why not.
3. **Wait for an explicit yes/no.** Run the council ONLY on a "yes."

Don't raise it for small / reversible / obvious calls — that's noise. The dev can always trigger it themselves any time ("council this", "pressure-test this", "war room this").
