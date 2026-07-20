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
- **Cross-cutting change across N similar sites: `grep -c` the pattern and reconcile the count against your edit list before gating.** Reason: the photoId stamp covered 13 of 14 item-creation sites; the missed one (the garland TRACE commit path) shipped a bug only a device check caught (S19).
- **Service-type / vertical seam gates are positive-match (`=== 'holiday'`), never negative (`!== 'permanent'`).** Reason: a negative gate silently hands every FUTURE vertical the old behavior; event inherited holiday's confirmation page, rush/takedown add-ons, and scheduling windows across 5 seams (S23/S25).
- **Migration ORDER is a per-migration decision.** A column-add ships migration-first (the column must exist before code reads or writes it); enabling RLS ships code-first (the service-role switch lands before the lock, so RLS can't break the old anon paths). Reason: "additive + nullable tolerates pre-apply" proved false the moment code SELECTed the column (S16).
- **A customer-facing money vertical is not "verified" until a human or a browser E2E runs create→send→portal→approve.** When that leg can't run (no creds, no browser), say so loudly, stage a rollback lever BEFORE the go, and hand the human the exact steps. Reason: event went live on a logic-layer E2E alone and the council flagged it as the session's #1 risk (S23).
- **Deleting a launch flag deletes your instant rollback lever: name the replacement (usually revert-the-PR) in the same breath.** Reason: `eventEnabled` was deleted hours after go-live; right product call, suddenly missing kill switch (S23).

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
- **Keep continuity docs lean — archive on cadence, don't wait to be asked.** Tight ledger Notes; completed tasks → `task_ledger_archive.md`; session logs keep only the latest ~3 (older → `session_log_archive.md`); `project_quote_tool` history in its archive. **This happens automatically at every session close (a `/wrap` step), and a fresh session self-checks at start and archives if they've grown** — so the docs never balloon between manual cleanups and the dev never has to remember to ask.
- **The `caveman` skill compresses OUTPUT** — per-machine opt-in via a SessionStart hook.

**Skills placement.** Repo-shared skills live in `.claude/skills/` (git-synced to both devs); per-machine / global skills in `~/.claude/skills/`. Choose **repo** for team skills, **global** for personal. Don't keep the same skill in both (drift) — the **`llm-council` canonical copy is the repo one**. Known exception: `wrap` exists in both ON PURPOSE (per-dev merge behavior; see "Review / merge" below); don't "fix" it as drift.

# Model routing & production guardrails (STANDING POLICY — applies to ALL plans/builds, both devs; Naldo 2026-07-02)

**1. Work auto-routes to the right model tier (silent, automatic — the dev is not asked):**

| Tier | Model | Does |
|---|---|---|
| DOWN | **Haiku 4.5** | reads: recon, file location, doc lookups, log scans |
| DOWN | **Sonnet 5** | builds: routine implementation, tests, UI components, docs |
| SEAT (default) | **Opus 4.8** | plans, judges, reviews: orchestration, adversarial review passes, PR review, finding dispositions |
| UP | **Fable 5** | top-tier — **always asks first**, never used silently |

**Subagent spawns (added 2026-07-06, both devs):**
- **Never spawn a subagent on Fable, for any reason.** Subagents inherit the session model by default, so in a Fable-seat session pass an explicit model on EVERY spawn (the Agent tool, Workflow `agent()` calls, council advisors), picked from the table above. Reason: Fable burns usage roughly twice as fast as Opus, and one forgotten spawn bills all its grunt work at the top rate. In non-Fable sessions this rule costs nothing.
- **Do NOT enforce this with the `CLAUDE_CODE_SUBAGENT_MODEL` env var.** Per the official Claude Code docs it sits at the TOP of model resolution: it overrides agent frontmatter AND the explicit per-call `model` parameter, so any single value flattens this whole table (either Haiku reads bill at Opus, or Opus reviewers silently drop to Sonnet). Instruction-level routing keeps the tiers.
- **Write every spawn brief self-contained:** goal, files or area involved, constraints, what done looks like, report format. Reason: the worker has zero context from the conversation, and a vague brief wastes the whole agent run.
- **When a worker's output falls short, send the fix back to a worker with specific corrections** instead of the seat quietly redoing it. Reason: the seat redoing labor pays top rate twice for one piece of work.
- **Default to parallel fan-out for independent work (added 2026-07-11, Naldo).** When a task splits into 2+ independent pieces (recon of separate areas, builds on disjoint files, review lenses, batch fixes), spawn one agent per piece in a SINGLE message so they run concurrently, instead of doing pieces one at a time inline. Do NOT fan out when pieces depend on each other's output, or when the whole task is one small edit (spawn overhead loses). Every spawn still follows the routing table above and carries an explicit model in Fable sessions. Reason: serial completion of independent work wastes wall-clock time, and independent perspectives improve review quality.

**2. Only 2 interruptions ever:** *"use the expensive model?"* and *"ship to production?"*. Everything else proceeds without stopping the dev.

**3. Top-tier (Fable 5) = design, danger, or money ONLY** — architecture calls, production debugging, security review, migrations, money-math verdicts. **Never routine coding. ~20% of the work, max.**

**Named Fable-eligible cases (added 2026-07-10, Naldo). All still ask-first; naming them stops them running casually on lower tiers:**
- **Quoting/analyzer prompt changes count as MONEY.** The quoting SYSTEM_PROMPT and per-vertical analyzer prompts directly shape customer prices and detected footage; a prompt rewrite is a money change unless byte-identity is proven (the S19 substring-move technique). Reason: wrong prompt = silent money drift, same failure class as pricing-engine math.
- **Golden-number re-anchoring counts as a money-math verdict.** Moving golden-job totals redefines what "correct" means for every future run. Itemize every cent of the delta first (the S25 #144 standard); the go/no-go verdict on the re-anchor is Fable-eligible.
- **Council chairman verdict may run on Fable.** The council is already ask-first; when it runs, advisors stay on lower tiers per the routing table, but the chairman synthesis is the single highest-leverage output of the run and may take the top tier (one call).
- **Stuck-escalation (the UP path).** Fallback in rule 5 only covers a tier being DOWN; this covers a tier being BEATEN. When the same problem defeats the seat twice (a fix loop bounces twice, a review keeps missing the root cause, a worker returns garbage twice on a corrected brief), offer Fable for that ONE call, ask first, then drop back to normal tiers. Scoped to the single stuck problem, never the whole session.

**4. Every production change is guarded:** `branch → PR → automated checks (tsc · lint · vitest) → merge → deploy → verify`. **The AI never merges itself** — before any merge it shows the dev a **plain-English summary derived from the ACTUAL code diff** (not from intent) and waits for an explicit "go". (Strengthens the human-merge rule below; Jason-area PRs still carry his review flag.) Post-merge, the deploy is **verified in-browser**, never assumed.

**5. Model fallback:** if a tier's model is down/unavailable, drop **exactly one tier** (Fable → Opus → Sonnet → Haiku) and **say so** in the output. For anything risky (money math, prod migrations, approve/amend paths, security), do NOT silently substitute — **stop and ask** first.

# Review gates: pre-merge lenses + wrap review (STANDING POLICY, both devs; Naldo 2026-07-20)

**1. Pre-merge lens review (every PR; the one carve-out is named below).** Before asking the dev for a merge-go on ANY PR (code, docs, skill, or config), spawn four review agents in parallel, in a single message. Each spawn carries an explicit model: lens finders run Sonnet 5 (the S20 finder pattern: cheap hunters, the seat verifies), and the seat's finding dispositions stay on Opus per the routing table. Never let a spawn inherit the session model; this matters most in Fable sessions. Each brief is self-contained: it names the PR or branch, states that the app is a quoting and portal tool for a residential lighting company, points the agent at the real surfaces (the Area-ownership paths below: portal, quote builder, pricing engine, dashboard, API routes), and gives the lens. For changes touching portal, quote, or checkout UI, the customer and staff briefs tell the agent to drive the actual pages (preview deploy or dev server) at desktop and mobile widths, not just read the diff (S18/S41: gates-green pages still crashed in-browser). On a docs, skill, or config PR the lenses review process impact instead: who could this rule change hurt. The four lenses:

- **Customer lens:** what a homeowner hits. The portal, the quote view, emails, the approval and payment flow. Hunt for broken links, wrong or confusing prices shown, dead-end states, mobile rendering breaks.
- **Staff lens:** what a crew member or office staffer hits. The quote builder, the dashboard, the day-to-day workflow. Hunt for extra clicks, lost work on reload or reopen, broken tools, workflow dead ends.
- **Admin lens:** what the owner hits. Settings, pricing rules, reporting, permissions, data integrity. Hunt for silent misconfiguration, wrong totals in reports, access gaps, rows that drift out of sync.
- **Technical lens:** correctness. Money math (integer cents, rounding direction, partial selections), idempotency and retry, duplicate submission, auth and permission gaps, migration order, service-type seam gates (positive-match, per Pitfalls), client/server import boundaries.

The seat dispositions every finding: fix it, accept it with a stated reason, or defer it to a ledger row. HIGH findings get fixed BEFORE the merge-go is asked, not after. The merge-go message shows the dev the dispositioned findings list (never raw agent output) alongside the plain-English diff summary from rule 4 above. This gate supersedes the "don't fire a heavy review on a typo" guidance above for PR merges specifically: Naldo's explicit call (2026-07-20), cost accepted. Depth still scales inside each lens; a tiny diff means a short review, not a skipped one.

One carve-out: the wrap skill's own close PR is pure continuity docs (memory, a prod behavior no-op), so it takes no lens review; it gets the wrap skill's collision verify instead. On Naldo's machine that PR auto-merges under his standing go; on Jason's machine it still stops for his explicit merge-go. If a close branch touches AGENTS.md or CLAUDE.md (the shared rule files), auto-merge is OFF for that PR: stop for an explicit go.

**2. Wrap review (every /wrap).** Session close runs a multi-agent review of EVERYTHING the session shipped: the diff from the session's starting master SHA to current master, plus any branch still open at close. It runs even when every PR was lens-reviewed at merge time, because the combined tree can break in ways per-PR reviews miss. A session that changed a live non-repo customer surface (WordPress, Elementor, GHL, Vercel config) with zero git diff still gets a review: run at least the customer lens against a written description of what changed (S44 shipped a customer-facing change with no repo diff at all). Findings go into the session log entry and the self-assessment; findings against the assistant's own work go in its Mistakes list. Step-by-step detail lives in the wrap skill (`.claude/skills/wrap/SKILL.md`).

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
- **An AI assistant never merges on its own — a human says go.** Assistants may create, push, and open PRs, but must **not** merge to `master` without their operating dev's explicit go-ahead (Jason's assistant ← Jason; Naldo's assistant ← Naldo). `master` auto-deploys to prod, so a human approves every merge. One standing exception (Naldo, 2026-07-02, per-machine): on Naldo's machine the `wrap` skill may auto-merge its OWN docs-only session-notes PR after a re-sync onto fresh master and a collision check; every code/feature PR still needs the dev's explicit go. Reason: wrap notes PRs once piled up six deep waiting for manual gos. (Jason's machine keeps the human-gated wrap; the two wrap skill copies differ on purpose.)
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
