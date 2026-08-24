# Onboarding — sharing the "Jason seat" (a second operator, same machine)

> Written S45 (2026-08-21). The "Jason seat" is the developer role that owns
> everything except the dashboard (portal, quote builder, pricing engine,
> design editor, training, settings, and — since S41 — the inbox). It has
> historically been one person (Jason). This note covers a **second person
> operating that same seat** on the **same Windows machine**, with his **own
> Anthropic (Claude) account**, taking turns with Jason.
>
> Decided by Jason 2026-08-21: the two operators **interchange** — same
> ownership, same permissions, same tasks, same git identity. They are one
> seat with two humans behind it, run **sequentially**. This is deliberately
> NOT the Jason/Naldo two-dev split (that model has separate ownership,
> per-dev session logs, and separate `name/` branch prefixes); the second
> Jason-seat operator is not a third dev, he *is* the Jason seat.

## The workflow, in one line

In this same Claude Code window on this machine: `/logout` the current
account, `/login` the other account. That's the entire switch. Everything
below explains why that's enough and the one thing to check.

## Why "just log out / log in" works

Claude Code stores its config **per Windows user, keyed by repo path** — there
is no per-Anthropic-account partition. Both operators run as the **same
Windows user** on the **same clone**, so all of this is literally the same
files on disk and carries over across a `/login` swap with zero setup:

- **The global routing policy** (`C:\Users\Jason\.claude\CLAUDE.md`: Haiku
  reads / Sonnet builds / Opus reviews / Fable ask-first) and the graphify
  trigger.
- **Personal + global skills** under `~/.claude/skills/` (graphify, caveman,
  cavecrew, the Anthropic skills), plus everything the repo ships in
  `.claude/skills/`, `.claude/agents/`, `.claude/commands/`.
- **Global settings + hooks** (`~/.claude/settings.json` — the caveman
  SessionStart hook, the graphify rebuild hook, statusline).
- **The repo layer** via git: `AGENTS.md`, `CLAUDE.md` + its running journal,
  and the whole `docs/context/*` continuity memory (session logs, task
  ledger, project state).
- **Project memory AND full conversation history** — these are keyed by the
  repo's filesystem path, not the account, so the second operator's first
  session **recalls all the accumulated memory (`MEMORY.md`) and can
  `/resume` prior threads.** Continuity is identical from day one, not a
  fresh start.
- **Git identity** (`100levelz`) and **`.env.local`** dev-server secrets —
  same Windows user, so both are already in place. Commits are authored as
  the shared seat identity, which is correct for this arrangement.
- **Model access** — both accounts are the same plan tier with Opus, so the
  routing policy behaves the same.

## The one real setup item: MCP connections

The business MCP servers (Supabase, Gmail, Google Calendar, Google Drive,
Vercel) appear to be **claude.ai connectors**, which follow whichever
claude.ai account is logged in — so they most likely will **not** carry over
to the second account automatically. On his first login he must add the same
connectors under **his** claude.ai account, each authorized to the **same
business service accounts** (the business Supabase org, the business Google
account for Gmail/Calendar/Drive, the business Vercel) — **never his personal
Google/Supabase/Vercel**. (If any of them turn out to be `claude mcp add`
servers instead of connectors, those *do* carry over automatically — the
`/mcp` check below tells you which.)

## First-login checklist (~5 minutes, one time)

1. `/login` with his account.
2. `/status` — confirm **Opus is available** and the account is in the **same
   org** as Jason's (if the two accounts sit in different orgs, org-managed
   settings can silently override local `settings.json` — permissions, hooks,
   enforced policy).
3. `/mcp` — confirm the business MCP servers show connected. Re-add any that
   are missing under his account, pointing at the **business** services.
4. Start a session and confirm memory loads (`MEMORY.md`) and `/resume` sees
   the history. It will — it's shared by repo path.

## Two operating rules to respect

- **Strictly sequential — one seat session at a time.** There is only one
  stored login per config directory, so his `/login` overwrites the other
  person's stored session (and vice versa). Taking turns is fine; **never run
  two seat sessions concurrently** (two windows / both people at once) — that
  triggers the session-number and worktree collision class `AGENTS.md` and
  the session logs already warn about.
- **The two operators are indistinguishable in the record** — shared memory,
  shared conversation history, the same `100levelz` git author, the same
  business MCP auth. That is the intended "interchangeable seat," but it also
  means either operator can `/resume` and read **every** prior conversation on
  this machine. Only put someone in this seat if that shared visibility is
  acceptable.

## Picking up the work

Follow the same session-start protocol everyone uses: read `MEMORY.md` → the
latest journal fragments for **both** devs (`docs/context/journal/S<N>-jason.md`
= the Jason seat, `S<N>-naldo.md` = Naldo; the old `session_log*.md` files are
FROZEN since the 2026-08-21 fragment migration — historical only) →
`project_quote_tool.md` (Current state / Next up). The most recent Jason-seat
fragment's NEXT line names exactly where to pick up — the next fresh
conversation continues the Jason seat's session number.
