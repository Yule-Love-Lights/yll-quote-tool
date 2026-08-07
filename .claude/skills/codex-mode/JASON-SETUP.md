# Codex mode setup for Jason

From Naldo. This lets your Claude act as orchestrator while OpenAI's Codex CLI
does the actual coding. Point: Codex bills against a ChatGPT subscription, a
separate bucket from the Claude weekly limit, so when Claude usage runs low the
work keeps moving. Verified working on Naldo's machine 2026-08-07.

## One-time install (your terminal, PowerShell)

1. You need a ChatGPT account with Codex access (Plus or Pro plan). If you don't
   have one, stop here and tell Naldo.

2. Install and log in:

   ```
   cmd /c "npm i -g @openai/codex"
   codex login
   ```

   Note: `cmd /c` wrapper is for the npm/npx call ONLY. The `codex` command
   itself runs directly in PowerShell — wrapping codex in `cmd /c` mangles the
   quotes and it errors with "unexpected argument".

3. Smoke test, from your quote-tool checkout (NOT a OneDrive-synced folder — a
   OneDrive path breaks Codex's Windows sandbox with
   `CreateProcessWithLogonW failed: 267`; your machine isn't OneDrive-synced per
   the repo notes, so your normal checkout should be fine):

   ```
   codex exec "say hello and list the files in the current directory"
   ```

   If it prints a file listing, you're wired.

## Give your Claude the skill

Copy the skill file from the repo path Naldo sends you (or from this folder:
`codex-mode/SKILL.md`) into your machine's global skills folder:

```
C:\Users\<you>\.claude\skills\codex-mode\SKILL.md
```

Then open the file and set the two per-machine values in the table near the top:

- CODEX_REPO = the full path to YOUR quote-tool checkout
- Branch prefix = `jason/`

That's it. Next Claude session, `/codex-mode` (or "hand this to codex") flips
Claude into orchestrator mode.

## If you'd rather paste than install the skill

Paste this at the start of a Claude session; it's the same contract in short
form:

```
You are orchestrator, not builder. Codex CLI does all code writing; you
conserve my Claude usage by planning, briefing, reviewing, and deciding.

Rules:
1. Restate the task in one sentence; batch your questions into one round.
2. Write a self-contained brief for Codex (goal, exact files, constraints,
   what done looks like, report format). Codex has zero context from our
   conversation. Tell it: if the brief contradicts the code, stop and
   report the contradiction instead of forcing the change.
3. Branch first (jason/<task>, off fresh origin/master, clean tree), then
   dispatch:
   codex exec --sandbox workspace-write -c model_reasoning_effort=high "<brief>"
4. Do NOT trust Codex's report. Read the real diff (git status --porcelain
   for untracked files + git diff origin/master...HEAD) and run the gates:
   npx tsc --noEmit, npm run lint, npm test.
5. If the work falls short, send a correction brief back to Codex — do not
   fix it yourself. After two failed correction rounds, stop and give me
   the options.
6. Never merge. Branch, PR, wait for my explicit go.
```

## What to expect

- Every `codex exec` run is stateless — Claude re-briefs from scratch each
  round. That's by design; it keeps the briefs honest.
- All the normal repo rules still apply: gates green before commit, four-lens
  review before a merge-go, your explicit go on every merge. Codex changes who
  types the code, nothing about the guardrails.
- The quality of the result equals the quality of the brief. Vague brief =
  wasted run. That's the skill being practiced.
