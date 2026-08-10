---
name: codex-mode
description: Use when Naldo is low on Claude usage and wants Codex CLI to do the coding while Claude orchestrates. Triggers - "/codex-mode", "codex mode", "hand this to codex", "let codex build it", "save my usage", "I'm running low on limit". Claude plans, briefs, reviews, and decides; Codex writes all the code.
---

# Codex mode: Claude orchestrates, Codex builds

You are the orchestrator, not the builder. Naldo's Claude usage is limited, so your
job is to spend few tokens on high-value thinking (planning, briefing, reviewing,
deciding) and push all the expensive grinding to Codex CLI, which bills against a
separate OpenAI quota.

## The hard rule

**You do not write implementation code in this mode.** Not "just this one small
fix." Not "it's faster if I do it." If code needs writing, it goes to Codex.

Exceptions, and only these:
- A one-line change where the brief would be longer than the fix.
- Fixing something Codex broke that you can prove in a single edit.
- Continuity docs, ledger rows, session notes (not product code).

You still read files, grep, run git, and run the gates. Reading is cheap; that is
how you review. It is the *writing* that goes to Codex.

## Per-machine config

Two values change per dev; everything else in this skill is identical:

| | Naldo | Jason |
|---|---|---|
| CODEX_REPO | `C:\dev\yll-quote-tool` | his local quote-tool checkout |
| Branch prefix | `naldo/` | `jason/` |

Every command below uses CODEX_REPO. **All Codex dispatches AND all review
commands (diff, gates) run in CODEX_REPO — never in the Claude session's own
cwd.** A Claude session often sits in a different worktree (Naldo's sessions
frequently open in the retiring OneDrive copy); running `git diff` or the gates
there reviews the wrong tree and can pass a green verdict on code Codex never
touched. Prefix every review command with the explicit path
(`git -C <CODEX_REPO> diff ...`) or cd there first in the same Bash call.

## Environment (verified 2026-08-07, Naldo's Windows machine)

- Codex CLI v0.147.0, model `gpt-5.4`, authenticated via ChatGPT account.
- **Always run from CODEX_REPO, never a OneDrive-synced path.** Codex's Windows
  sandbox spawns children via `CreateProcessWithLogonW`, which fails with
  `CreateProcessWithLogonW failed: 267` on any OneDrive-synced path. Same OneDrive
  tax that eats `node_modules`. Never run Codex from
  `C:\Users\ebhdh\OneDrive\Documents\Ai Quote Tool`.
- Codex automatically reads the repo's own `AGENTS.md` at startup, so it gets the
  repo conventions (gates, branch rules, pitfalls) for free. The brief still
  carries task specifics — AGENTS.md gives Codex the house rules, not the task.
- `codex` is a `.cmd` shim: run it directly in PowerShell. Do **not** wrap it in
  `cmd /c "..."` — the escaped quotes get mangled and you get
  `error: unexpected argument 'say' found`. The `cmd /c` wrapper is only for `npx`.
- Codex inherits Naldo's Claude plugin config, so it reads superpowers skill files
  before acting. Costs ~20k tokens of overhead per run. Irrelevant on a real build,
  wasteful on trivial commands — so don't send Codex trivial commands.
- **`.env.local` (live Supabase/Valor/GHL keys) sits inside CODEX_REPO, and
  `--sandbox workspace-write` gives Codex read access to it.** Naldo's explicit
  call (2026-08-10): accept this risk, no guard added. Do not raise it as a
  blocker on future runs — it is a known, accepted tradeoff, not an open question.

## The dispatch command

```
codex exec --sandbox workspace-write -c model_reasoning_effort=high "<brief>"
```

Flags, and why:
- `exec` — non-interactive. Codex works, prints, exits. You read the output.
- `--sandbox workspace-write` — Codex can edit files inside the repo, cannot touch
  the rest of the machine, cannot reach the network. Correct setting for build work.
  Default is `read-only`, which silently cannot edit anything.
- `-c model_reasoning_effort=high` — default is `low`. Low is fine for a file
  listing, wrong for real code.

Never use `--dangerously-bypass-approvals-and-sandbox`. It was only ever a
diagnostic for the OneDrive sandbox failure, and that is solved by running from
CODEX_REPO.

**When Claude runs the dispatch itself** (rather than handing the command to the
dev): use the Bash tool with `run_in_background: true`. A real Codex build runs
10-40 minutes; the Bash foreground default (2 min) kills the run mid-build and
the death looks like a Codex failure. Do not poll — the harness notifies on
completion. If a background run goes silent well past the expected time, check
its output before declaring it dead (the repo has a scar from declaring a slow
agent dead on elapsed time alone).

Long briefs: PowerShell 5.1 mangles here-strings passed to native exes. Write the
brief to a file in the scratchpad and pass it by reference in the prompt text
("read the brief at <path> and execute it") rather than inlining hundreds of lines.

## The loop

1. **Scope.** Restate the task in one sentence. Ask Naldo the questions you need,
   batched into one round (the standing prompt-first rule still applies).

2. **Ground.** Read the actual code yourself before briefing. A brief written from
   assumption wastes a whole Codex run. Grep the consumer, read the real lines.

3. **Branch, from a clean current tree.** Never let Codex work on `master`, and
   never dispatch onto uncommitted work — `workspace-write` lets Codex edit over
   it (a subagent stash once wiped an hour of uncommitted seat work in this repo).
   ```
   cd <CODEX_REPO>
   git status --porcelain   # must be empty; commit or stash-with-a-note first
   git fetch origin
   git checkout -b <prefix>/<task-name> origin/master
   ```
   If the clone has sat for a while, `npm ci` before anything that runs the gates
   (a stale or missing `node_modules` fails gates in ways that imitate real bugs).

4. **Brief.** Write it self-contained (format below). Codex has zero context from
   your conversation with Naldo. **Show Naldo the brief before dispatching, every
   single time** (Naldo's explicit call, 2026-08-10) — paste it in chat, no need
   to wait for a go-ahead, just show it so he sees what Codex is being told.

5. **Dispatch.** Run the command above. Hand it to Naldo to paste if you cannot
   run it yourself.

6. **Distrust the report.** Codex's summary of what it did is a claim, not
   evidence. In CODEX_REPO (not the session's cwd), read the real diff and run
   the real gates:
   ```
   git status --porcelain    # catches UNTRACKED files the diff below misses
   git diff origin/master...HEAD
   npx tsc --noEmit
   npm run lint
   npm test
   ```
   Have Codex commit its work (per completed piece, per its brief); if it left
   changes uncommitted, commit them yourself before reviewing so nothing is
   invisible to the diff.

7. **Independent second-AI check (Naldo's explicit call, 2026-08-10 — since he
   cannot read the diff himself, one seat reviewing its own dispatched worker's
   output is not enough).** Spawn a separate Claude agent — Sonnet 5, unless the
   change touches money/auth/identity, then Opus — to review the diff COLD: it
   gets the diff and the original GOAL/DONE-LOOKS-LIKE, nothing else. It does not
   see this brief-writing conversation, does not know what Codex claimed, and is
   told explicitly to verify independently rather than confirm your read. It
   reports its own verdict: does the diff actually do what GOAL says, does
   anything look wrong, would it flag this for a human. Treat a disagreement
   between your own read and this agent's as a real finding, not noise — resolve
   it before telling Naldo the work is good.

8. **Review.** Apply the repo's standing four-lens pre-merge review (customer,
   staff, admin, technical) sized to the risk. Disposition every finding: fix,
   accept with a stated reason, or defer to a ledger row.

9. **Correct via Codex, not yourself — with a stop condition.** If Codex's work
   falls short, write a correction brief naming the exact defect and dispatch
   again. Each `codex exec` is stateless: the correction brief must carry the
   original goal, what Codex did, and the specific defect — never just "fix the
   review findings". After TWO failed correction rounds on the same defect, stop
   ping-ponging: tell the dev plainly, and offer the choice — Claude fixes it
   inline (spending the usage this mode exists to save), the task gets re-scoped,
   or it goes to a ledger row. That call is the dev's, not yours. (Naldo's
   explicit call, 2026-08-10: keep this as-is, no change.)

10. **Report to Naldo in plain English.** What changed, what passed, what you
    distrust, and the independent reviewer's verdict from step 7. Derived from
    the diff, never from Codex's own summary.

11. **Never merge.** Branch, PR, wait for Naldo's explicit go. Unchanged.

## Brief format

Codex knows nothing about the conversation. Every brief carries all six:

```
GOAL: one sentence. What must be true when you are done.

CONTEXT: this is a quoting and portal tool for a residential holiday and
permanent lighting company. <the specific background this task needs>

FILES: the exact paths to change, and the paths to read for context.
Do not touch anything else.

CONSTRAINTS: <repo conventions that apply. Always include: match existing
style, no speculative abstractions, no unrelated refactors.>

DONE LOOKS LIKE: <verifiable criteria. Prefer a failing test that must pass.>
Run `npx tsc --noEmit`, `npm run lint`, and `npm test` and report the results.

REPORT: list every file you changed and why, any place you deviated from this
brief and the reason, and anything you were unsure about. Do not claim
success on a gate you did not actually run.
```

## Brief-writing rules learned the hard way

- **A fix prescription is a hypothesis.** If you tell Codex *how* to fix
  something, you may be wrong — that has shipped bad fixes four times in this
  repo. Either trace the consumer's exact behavior first, or label the snippet
  "intent, not prescription" and let Codex find the real shape.
- **Tell Codex to distrust the brief.** Add: "if anything in this brief
  contradicts what you find in the code, stop and report the contradiction
  instead of forcing the change." Builders catching seat errors is a feature.
- **Money, auth, and identity seams get a delta-verify.** After Codex's fix
  round, review the *fix* adversarially, not just the original findings. Fixes
  introduce bugs.
- **One task per dispatch.** Two loosely related tasks in one brief produce one
  muddled diff you cannot review cleanly.

## What Codex is good at vs what you keep

Give to Codex:
- A well-specified change with clear acceptance criteria.
- Test-writing, then looping until green.
- Mechanical sweeps across many similar sites.
- Routine implementation from a settled design.

Keep for yourself:
- Reading a large unfamiliar codebase to answer "how does this work."
- Judging tradeoffs and telling Naldo a plan is wrong.
- Money math, auth gaps, migration order, service-type seam gates.
- The merge-go summary and every product decision.

The quality of the result equals the quality of the brief. A vague brief wastes
a whole Codex run — write briefs tight the first time rather than relying on
correction rounds to fix scoping mistakes.

## Handoff

If Naldo is in a cloud or web session, Codex cannot run there — there is no
terminal on his machine. In that case: write the brief, tell him plainly that it
has to be pasted into a desktop session, and hand him the exact command.
