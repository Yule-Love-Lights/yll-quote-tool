# Project context (Claude Code memory snapshot)

These `.md` files are a **snapshot of the Claude Code project-memory** for the
Yule Love Lights design tool — the accumulated context an AI assistant uses to
understand the project: what it is, how it's built, the full feature history, the
roadmap, and a per-session log.

They are committed here so the context **travels with the repo** (backup + so a new
teammate's AI assistant can pick up the project cold).

## Where the "live" copy lives

On the original author's machine (Jason), the live, auto-loading versions live at:

```
~/.claude/projects/C--Users-Jason-Desktop-YuleLoveLights-Claude/memory/
```

Claude Code reads memory from that home-folder location, **not** from this repo
folder. So the files here are a **periodic snapshot**, and they can drift out of date
between snapshots. The snapshot is refreshed manually (see "Keeping in sync" below).

## Start here

`MEMORY.md` is the index — it lists the other files and what each covers:
- `project_design_tool.md` — main state file for **the DESIGN TOOL** (the canvas app for drawing lights on house photos): current features, how to run, git/GitHub workflow, roadmap. **Read this first.** (Formerly named `project_quote_tool.md` — renamed 2026-06-02 to avoid confusion with the AI Quote Tool.)
- `session_log.md` — per-session continuity log (what each session shipped, where to pick up).
- `user_profile.md` — who Jason / Yule Love Lights are.
- `reference_hhc.md` + `project_hhc_architecture.md` — the Holiday Home Concepts tool this is modeled on.
- `project_ai_quote_tool.md` — the **separate AI Quote Tool** (`yll-quote-tool`, Next.js + Supabase) and the planned integration. NOT the design tool above.
- `project_integration.md` — the plan to merge the design tool INTO the quote tool (Path B): embedded editor on the quote builder + live design in the customer portal. Planning only, not started.
- `feedback_context_warning.md` — context-management preference.

## For a new teammate (e.g. Naldo) picking up the design tool

To get your own Claude Code assistant to auto-load this context on YOUR machine:

1. Clone the repo and find your project's memory folder. After you open the repo
   in Claude Code once, it'll be at:
   `~/.claude/projects/<your-encoded-repo-path>/memory/`
   (the encoded path is your repo's absolute path with `/` and `:` replaced by `-`).
2. Copy the `.md` files from this `docs/context/` folder into that memory folder.
3. Open a Claude Code session — it now auto-loads the full project context.

(Or, simpler for a one-off: just tell your assistant to read `docs/context/*.md`
at the start of the session.)

## Keeping in sync

The snapshot is refreshed **manually** — there's no automatic hook. The practice:
**when wrapping up a work session (or after a big change), re-copy the memory files
into `docs/context/` and commit them** so the repo stays current. The session-wrap
checklist in `session_log.md` includes this reminder.
