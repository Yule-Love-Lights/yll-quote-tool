# `docs/context/` — Claude Code memory snapshot

## What these are

Claude Code keeps **per-project memory** as Markdown files on the developer's machine. They auto-load at the start of every Claude Code session for that project, which is how the assistant "remembers" decisions across sessions. Because they live outside the repo, they **do not travel when you clone** — so this folder is a point-in-time **snapshot** committed into the repo so a new teammate's assistant can pick up the accumulated context.

This mirrors the convention already used in the sibling **`design-tool`** repo (which snapshots its memory into `docs/context/` the same way).

## The continuity system (how sessions hand off)

Long sessions run out of context, so work spans many fresh sessions across two machines (Jason + Naldo). Two files make a cold start resumable:

- **`session_log.md`** — append-only, newest-on-top log. Each entry = what shipped, ending state, and the single most important NEXT step. Read the latest entry first.
- **`project_quote_tool.md`** — "current state at a glance," **Decisions confirmed (don't re-ask)**, run commands, gotchas, and the live QA backlog. Read this second.

**`docs/context/` is the canonical, shared copy.** The two machines' *local* Claude memories don't sync with each other, so this in-repo folder is the source of truth that travels via GitHub. Local memory is *seeded from* it at session start and *snapshotted back into* it at session close.

- **Start of session:** read `MEMORY.md` → latest `session_log.md` entry → `project_quote_tool.md`; if local memory is empty/stale, copy these files into the local memory dir; confirm the dev server runs; then don't re-ask anything under "Decisions confirmed."
- **Close of session (~90% context):** finish the current `session_log.md` entry, make `project_quote_tool.md` accurate, copy the local `memory/*.md` back into `docs/context/`, then have Jason commit + push.

## Snapshot metadata

- **Snapshot date:** 2026-05-29
- **Source machine:** Naldo's PC
- **Files:** `MEMORY.md` (index), `session_log.md` + `project_quote_tool.md` (continuity — added Session 1, 2026-06-01), `user_jason.md`, `user_naldo.md`, `project_yll_render_engine.md`, `project_secrets_access.md`, and the two `feedback_*` files.
- **Redaction:** No secrets (API keys/tokens) were present in any memory file. Two files were **omitted** — `project_yll_goals.md` (sensitive business financials + belongs to a separate project) and `project_naldos_brain.md` (separate WhatsApp project, out of scope). See `MEMORY.md` for details.

> ⚠️ **Keep this in sync.** It began as a one-time snapshot (2026-05-29) but is now an **actively maintained** continuity copy. Per the close-of-session protocol, re-snapshot every session (copy local `memory/*.md` → here, then commit + push) so it never drifts from the live memory.

## Where the live copy lives

On the machine that built this repo, Claude Code stores the live memory at:

```
~/.claude/projects/<encoded-project-path>/memory/
```

`<encoded-project-path>` is the repo's **absolute path with the drive colon and every path separator replaced by a dash**.

**Concrete example (the machine this was snapshotted from):**
The Claude Code session was rooted at `C:\Users\ebhdh\OneDrive\Documents\Claude`, so its memory lived at:

```
C:\Users\ebhdh\.claude\projects\C--Users-ebhdh-OneDrive-Documents-Claude\memory\
```

Note the encoding: `C:\Users\ebhdh\OneDrive\Documents\Claude` → `C--Users-ebhdh-OneDrive-Documents-Claude` (the `C:\` becomes `C--`, each remaining `\` becomes `-`).

> **Honest caveat for this repo:** the live memory was stored under the *session root* path above, **not** under the repo's own folder path (`C:\Users\ebhdh\OneDrive\Documents\Ai Quote Tool`). There was **no repo-rooted `memory/` folder** on Naldo's machine — the quote-tool work happened in sessions rooted at the `Documents\Claude` path. That's why this snapshot exists: so the context is captured in the repo regardless of which session folder it originally lived in.

## How to load this context on your machine (Jason)

### Option A — auto-load as Claude Code memory (persists across sessions)

1. Figure out **your** encoded project path from wherever you clone the repo. Example: if you clone to
   `C:\Users\Jason\Desktop\YuleLoveLights\yll-quote-tool`, the encoded folder is
   `C--Users-Jason-Desktop-YuleLoveLights-yll-quote-tool`.
2. Create the memory folder if it doesn't exist:
   `C:\Users\Jason\.claude\projects\C--Users-Jason-Desktop-YuleLoveLights-yll-quote-tool\memory\`
3. Copy every `.md` from this `docs/context/` folder into that `memory/` folder.
4. Start a Claude Code session in the repo — the files auto-load.

> The encoding rule is identical on macOS/Linux: take the absolute clone path, replace the leading drive/`/` and every separator with `-`. When unsure, run `ls ~/.claude/projects/` after opening the project once — Claude Code creates the correctly-named folder automatically; drop the `.md` files into its `memory/` subfolder.

### Option B — read on demand (no setup, doesn't persist)

At the start of a session, just tell your assistant:

> "Read all of `docs/context/*.md` before we start."

No memory-folder setup; the assistant reads them as normal files for that session only.

## What to read first

Start with **`project_yll_render_engine.md`** — it captures the architecture decisions and hard-won gotchas (exact Gemini model ID, REST response parsing, RLS history) behind the render pipeline, which is the most subtle part of the codebase. Then `user_naldo.md` for owner context. The two `feedback_*` files are environment quirks worth knowing before you run the dev server.
