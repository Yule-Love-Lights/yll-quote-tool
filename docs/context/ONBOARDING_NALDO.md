# Naldo — machine onboarding (yll-quote-tool, Windows)

Concrete step-by-step to get the quote tool running on Naldo's **Windows** machine and plugged into the shared two-dev workflow. His Claude Code assistant should drive these and only hand a step to Naldo when it genuinely can't do it itself. (Workflow rules live in `AGENTS.md` → "Multi-dev collaboration".)

> 📌 **Naldo's existing folder is ~a month stale** (from before Jason took over dev). It may be behind `master`, have leftover uncommitted work, or — watch for this — still point at the **personal `naldoven/yll-quote-tool` fork** instead of the canonical org repo **`Yule-Love-Lights/yll-quote-tool`**. The assistant must check `git remote -v` and fix it (or fresh-clone) before anything else.

## 1. Get a clean, current copy of the ORG repo
- Make sure **Node.js 20+** and **Git** are installed (assistant: check `node -v` / `git --version`; if missing, give Naldo the download links — nodejs.org and git-scm.com — and wait).
- In the existing folder, inspect: `git remote -v`, `git status`, `git log --oneline -3`.
  - If `origin` is **not** `https://github.com/Yule-Love-Lights/yll-quote-tool.git`, fix it:
    `git remote set-url origin https://github.com/Yule-Love-Lights/yll-quote-tool.git`
  - If the folder is messy/diverged or you're unsure, the **safest path is a fresh clone** into a new folder — do it, then tell Naldo to reopen Claude Code there:
    `git clone https://github.com/Yule-Love-Lights/yll-quote-tool.git`
- Get onto current master (⚠️ confirm with Naldo before discarding any old uncommitted work):
  ```
  git fetch origin
  git checkout master
  git reset --hard origin/master
  npm install
  ```
- Set Naldo's Git identity so commits are attributed to him:
  ```
  git config user.name "naldoven"
  git config user.email "info@yulelovelights.com"
  ```

## 2. Secrets → `.env.local`
**Jason sends Naldo his working `.env.local` file** (out of band — never in chat/commit). The assistant tells Naldo to **save that file into the repo root folder** (the folder containing `package.json`), named **exactly `.env.local`** — Windows hides extensions, so make sure it isn't saved as `.env.local.txt`. Then the assistant verifies the file exists and is non-empty. The app won't fully run until it's in place.

## 3. Seed local memory from the repo
The shared project memory lives in `docs/context/`. The assistant copies **every file** from `docs/context/` into **this machine's** Claude Code memory folder (`~/.claude/projects/<this-repo-slug>/memory/`), **overwriting** Naldo's stale month-old memory. Going forward:
- Read the newest `docs/context/journal/` fragments of both devs at session start (old `session_log*.md` files are frozen history).
- You only ever **write** your own session's fragment: `docs/context/journal/S<N>-naldo.md`.

## 4. Build the codebase knowledge graph (per-machine, free)
- `/graphify src` — builds `graphify-out/` (gitignored, ~seconds).
- `graphify hook install` — auto-rebuilds the graph on each commit/checkout.

## 5. Run the dev server (Windows)
- **Normal PowerShell terminal:** `npm run dev`
- **Inside Claude Code's Bash tool** (its shell blanks `ANTHROPIC_API_KEY`, which breaks Claude calls — unset it first):
  ```
  unset ANTHROPIC_API_KEY; unset ANTHROPIC_BASE_URL; npm.cmd run dev
  ```
- Open **http://localhost:3000** — `/` is the dashboard Naldo will build (#58; it's the Next.js boilerplate ON PURPOSE right now).

## 6. Verify the gates pass (run before every commit)
```
npx tsc --noEmit
npm run lint
npm test
```

## Done — the workflow in one breath
Naldo's area = the **dashboard** (`src/app/page.tsx` + new `src/components/dashboard/**`). Work on a branch named **`naldo/<short-desc>`**, **never commit to `master`**, open a PR (via the compare link Git prints — no `gh` CLI here), and **ask Jason before editing any SHARED file** (`layout.tsx`, `globals.css`, `package.json`, the `src/lib` data layer). Full table in `AGENTS.md`.
