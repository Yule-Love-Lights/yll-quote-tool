# For Jason: 2026-07-06 tooling consolidation (what changed + optional setup)

Naldo's machine ran a CLAUDE.md consolidation today. Three repo PRs landed (#410, #414,
#416), all docs/config, zero product code. Here is what reaches you on `git pull`, what
stayed on his machine, and three prompts you can paste into your own Claude if you want
the same per-machine safety nets.

## What you get on pull (no action needed)

1. **Three slash commands** under `.claude/commands/` (new, now git-tracked):
   `/billing-review` (adversarial pass on a billing endpoint before commit),
   `/defect-audit` (payment + auth invariant auditor), `/feature-fleet` (parallel
   TDD fleet over 'ready' issues; never merges). These were Naldo's saved prompts;
   now they version with the repo.
2. **Five checklist skills** under `.claude/skills/`: `merge-safe`, `money-review`,
   `new-vertical`, `verify-handoff`, `dev-up`. Each is a short checklist where every
   item carries the incident that earned it. Your Claude will surface them when the
   matching work comes up; you can also invoke them by name.
3. **AGENTS.md additions** (all additive):
   - Five new pitfalls: grep-count reconcile across similar sites; positive-match
     service-type gates (`=== 'holiday'`, never `!== 'permanent'`); per-migration
     ordering; customer-facing money verticals need the browser/human
     create-send-portal-approve leg (or say so loudly + stage a rollback); deleting a
     launch flag names its replacement rollback.
   - The merge policy now records: Naldo's wrap skill auto-merges its OWN docs-only
     notes PR on HIS machine (his standing go). Your wrap is unchanged and stays
     human-gated. The two wrap copies differ on purpose; documented so nobody "fixes"
     them as drift.
4. **CLAUDE.md journal slimmed**: five stable rules moved into AGENTS.md (single
   source), S19 detail archived to `docs/context/assistant_journal_archive.md`.

Nothing above changes what you have to do. Your gates, your merge flow, your wrap: all
unchanged.

## What stayed on Naldo's machine (context only)

His global `~/.claude/CLAUDE.md` was rebuilt (identity/voice/prompt-first rule files),
plus per-machine git-safety hooks, a `.claude/launch.json`, and a permission allowlist.
None of that syncs through git.

## Optional: three prompts for your own Claude

Paste any of these into a Claude Code session on your machine. Each is self-contained.
They set up the same guards Naldo now runs. All three were built and live-tested on his
machine today.

### Prompt 1: git safety hooks (branch-change notice + glob-delete block)

```
Add two git-safety hooks to my global Claude Code settings at ~/.claude/settings.json,
merging with whatever is already there (do not replace existing keys or hooks).

1. A PostToolUse hook, matcher "Bash": whenever a command contains git checkout,
   git switch, or git worktree, inject a reminder that branch/worktree state changed
   (verify git branch --show-current before the next state-changing git command, and
   Read files before Edit). Reason: wrong-branch commits and stale-path edits are our
   most common git mistakes after a switch.

2. A PreToolUse hook, matcher "Bash": DENY any git push --delete or git branch -D/-d
   command whose arguments contain glob characters (* or ?), with the reason that
   branch deletes must use exact names (a glob once deleted 10 remote branches).

Notes from the machine where this already works: jq is not installed on our Windows
Git Bash, so grep the raw stdin JSON instead. The tested commands are:

PostToolUse:
grep -qE '"command":"[^"]*git (checkout|switch|worktree)' && echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Branch or worktree state just changed: run git branch --show-current before the next state-changing git command, Read files before Edit, and re-check cwd-relative paths."}}' || true

PreToolUse:
grep -qE '"command":"[^"]*git (push[^"]*--delete|branch[^"]*-[dD])[^"]*[*?]' && echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Branch deletes use exact names, never globs: a glob once deleted 10 remote branches (S12). Re-run with the exact branch name."}}' || true

Use type "command", shell "bash", timeout 5 for both. Pipe-test each command with a
sample stdin JSON before writing, validate the settings file still parses afterward,
then prove the PostToolUse hook fires by running a harmless git worktree list, and the
PreToolUse hook by attempting git push origin --delete 'zzz-nonexistent-*' (harmless:
the branch does not exist).
```

### Prompt 2: session status hook + dev-server launch config

```
In the AI Quote Tool repo, set up two local conveniences (both live in gitignored
files, so they stay on this machine):

1. Add a SessionStart hook to .claude/settings.local.json (merge, do not replace) that
   prints the current branch, the worktree root, and whether node_modules exists, as
   additionalContext. Reason: OneDrive eats node_modules and concurrent sessions move
   branches; seeing the real state at session start kills a whole class of confusion.
   The tested command is:

B=$(git branch --show-current 2>/dev/null); W=$(git rev-parse --show-toplevel 2>/dev/null); N=$([ -d node_modules ] && echo present || echo MISSING); echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"Quote Tool repo status: branch=$B tree=$W node_modules=$N. If node_modules MISSING run npm ci first (OneDrive eats it).\"}}"

   Use type "command", shell "bash", timeout 10.

2. Create .claude/launch.json with one configuration named "quote-tool-dev" that runs
   the dev server through bash with ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL unset
   (the Claude Code shell sets the key to an empty string, which overrides .env.local
   and 503s every AI route), port 3000:

{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "quote-tool-dev",
      "runtimeExecutable": "bash",
      "runtimeArgs": ["-lc", "unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL; npm run dev"],
      "port": 3000
    }
  ]
}

Validate both files parse when done.
```

### Prompt 3: fewer permission prompts

```
Run the /fewer-permission-prompts skill if you have it. If not: create or update
.claude/settings.json in the AI Quote Tool repo (it is gitignored here, so this stays
local) and add these narrow allow rules, merging with anything present:

"Bash(npx tsc --noEmit)", "Bash(npm run lint)", "Bash(npx vitest run src)"

Reason: these three exact gate commands run constantly in this repo and are safe;
wildcard rules for npx/npm would grant arbitrary code execution, so keep the exact
forms only. Most other frequent commands (git log/status/diff, head/tail/grep,
gh pr view) are already auto-allowed by Claude Code and need no rule.
```

## Questions

Ask Naldo, or read `docs/context/session_log_naldo.md` (S27 entry) for the full session
record. PRs: 410, 414, 416 on the repo.
