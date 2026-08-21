# `docs/context/` — Claude Code memory snapshot

## What these are

Claude Code keeps **per-project memory** as Markdown files on the developer's machine. They auto-load at the start of every Claude Code session for that project, which is how the assistant "remembers" decisions across sessions. Because they live outside the repo, they **do not travel when you clone** — so this folder is a point-in-time **snapshot** committed into the repo so a new teammate's assistant can pick up the accumulated context.

This mirrors the convention already used in the sibling **`design-tool`** repo (which snapshots its memory into `docs/context/` the same way).

## Snapshot metadata

- **Snapshot date:** 2026-05-29
- **Source machine:** Naldo's PC
- **Files included:** `MEMORY.md` (index), `project_yll_render_engine.md`, `user_naldo.md`, `feedback_claude_code_env_override.md`, `feedback_npx_skills_add_flags.md`
- **Redaction:** No secrets (API keys/tokens) were present in any memory file. Two files were **omitted** — `project_yll_goals.md` (sensitive business financials + belongs to a separate project) and `project_naldos_brain.md` (separate WhatsApp project, out of scope). See `MEMORY.md` for details.

> ⚠️ **This is a snapshot, not a live link.** It reflects the memory as of the date above and will drift as work continues. Re-snapshot before the next handoff (copy the live `memory/*.md` files back into this folder, re-scrub, and re-commit).

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

Start with **`project_quote_tool.md`** + the newest fragments in `journal/` (or the generated `JOURNAL.md`; the old `session_log*.md` files are frozen history, 2026-08-21 fragment migration) — current state, confirmed decisions, what's next. Then `user_naldo.md` for owner context. The two `feedback_*` files are environment quirks worth knowing before you run the dev server. (`project_yll_render_engine.md` is purely historical — the render pipeline was removed in #36, S7.)
