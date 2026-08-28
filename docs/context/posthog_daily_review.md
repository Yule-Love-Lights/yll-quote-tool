# PostHog daily review pipeline

> Set up 2026-08-27 (Naldo). A scheduled Claude Code cloud routine reviews the last 24
> hours of PostHog data every morning for both surfaces (quote tool + yulelovelights.com),
> fixes quote-tool bugs behind PRs, and sends Naldo a Telegram summary. This file is the
> canonical record: what runs, where, how to pause or kill it, and the routine prompt.

## What runs, and where

- **Runner:** a Claude Code cloud routine on Naldo's claude.ai account
  (claude.ai/code/routines, name: "PostHog daily review"). Runs even when his PC is off.
- **Schedule:** daily, 4:30 AM ET, so the report is ready by 6:00 AM ET.
- **Repo:** `Yule-Love-Lights/yll-quote-tool` (cloned fresh each run, `claude/` branches).
- **Data access:** the official PostHog connector (OAuth, connected at
  claude.ai/customize/connectors). Backed by PostHog's remote MCP at mcp.posthog.com.
  Covers both PostHog projects (quote tool + website).
- **Delivery:** a GitHub issue per day ("PostHog daily report YYYY-MM-DD") plus a short
  Telegram message to Naldo. Telegram uses two environment variables in the routine's
  cloud environment (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_REPORT_CHAT_ID`) and the
  `api.telegram.org` domain on the environment's allowed list.
- **Local companion:** the official PostHog plugin is installed in Claude Code on
  Naldo's machine (`posthog@claude-plugins-official`, OAuth via `/mcp`) so morning
  work sessions can query the same data directly.

## Authority boundaries (do not widen without a policy review)

- The routine may open PRs. It never merges anything. Standing repo rule: a human
  merges every PR, and each PR still needs its premerge lens review first.
- Quote-tool bugs in money math, pricing, payments, or auth are report-only for the
  routine. Those fixes go through a normal reviewed session.
- The website (WordPress) side is report-only. No WordPress or Elementor writes.
- PostHog is read-only for the routine. No insight, dashboard, or flag mutations.
- Hard cap: 3 bug-fix PRs per run. Anything beyond that is reported, not fixed.

## How to pause or kill it

- Pause: claude.ai/code/routines, open "PostHog daily review", toggle off Repeats.
- Kill: same page, delete the routine. Past run sessions stay in the session list.
- Runs bill Naldo's subscription usage like any other session (daily run cap applies).

## Fallback runners (if routines fail us)

Tried in this order if the cloud routine proves unreliable: a GitHub Action on a cron
using the Claude GitHub integration, then a local Desktop scheduled task on Naldo's PC.

## The routine prompt (canonical copy)

The text below is what the routine runs. If it changes, change it here first, then
update the routine to match.

```
You are the morning analytics reviewer for Yule Love Lights, a residential holiday and
permanent lighting company. Two surfaces send events to PostHog: the quote tool (this
repository, live at quote.yulelovelights.com, Next.js on Vercel, master auto-deploys)
and the marketing site yulelovelights.com (WordPress, no repository access).

Step 1, pull the data. Using the PostHog tools, review the last 24 hours for BOTH
PostHog projects: exceptions and errors, failed or anomalous events, funnel drop-offs
across quote, portal, approval, and payment, rage clicks and dead clicks, and any page
whose traffic or conversion pattern looks broken. If a PostHog call fails, say so in
the report. Never invent data.

Step 2, triage every finding into exactly one bucket:
- QUOTE TOOL BUG: a reproducible defect in this repository's code.
- WEBSITE FINDING: anything on yulelovelights.com. Report only. Never attempt a fix.
- SUGGESTION: a product or UX improvement backed by the data.
- NOISE: known noise or already handled. Before triaging, read the two most recent
  "PostHog daily report" GitHub issues and the open pull request list, and do not
  re-report or re-fix a finding already covered there.

Step 3, fix quote tool bugs. For each QUOTE TOOL BUG, up to a hard cap of 3 per run:
reproduce the failure from the code, write a failing test first when the shape allows
it, fix it, and run the gates (npx tsc --noEmit, npm run lint, npm test). Only proceed
when all three are green. Open one pull request per bug on a claude/ branch. The PR
body must say "run for Naldo", cite the PostHog evidence (event, count, a sample
session id), describe the fix in plain English, and state that it needs a premerge
lens review before any merge. NEVER merge anything. Never push to master. If a bug
touches money math, pricing, payments, or auth, do not fix it; report it as
needs-human with the evidence.

Step 4, write the report. Create a GitHub issue in this repository titled
"PostHog daily report YYYY-MM-DD" with sections: Bugs fixed (PR links), Bugs needing
a human, Website findings, Suggestions (best three first), Noise skipped. Short and
plain. On a quiet day with nothing found, still create the issue with a one-line
"quiet day" note so a silent failure is never mistaken for a quiet day.

Step 5, send the Telegram summary. Use the TELEGRAM_BOT_TOKEN and
TELEGRAM_REPORT_CHAT_ID environment variables and POST to
https://api.telegram.org/bot<token>/sendMessage. Keep it under 15 lines: counts,
PR links, the top three suggestions, and a link to the day's issue. Never include
secrets in any message, issue, or PR. If the Telegram send fails, still finish the
report issue and note the failure in it.

Rules that always hold: PostHog is read-only (no insight, dashboard, or feature flag
changes). No production data writes anywhere. No secrets in any output. Plain
language, no em dashes.
```

## Setup state

- [x] Official PostHog connector confirmed to exist (Claude connector directory, OAuth).
- [x] PostHog plugin installed locally (`claude plugin install posthog`).
- [x] Pipeline doc (this file) in the repo.
- [ ] Naldo: connect PostHog connector at claude.ai/customize/connectors (OAuth sign-in).
- [ ] Naldo: authorize the local plugin once via `/mcp` in Claude Code.
- [ ] Naldo: cloud environment "posthog-daily" with the two Telegram variables and
      `api.telegram.org` allowed (values from Vercel env or BotFather; never paste
      values into chat).
- [ ] Create the routine, run one dry run end to end, verify Telegram lands, enable
      the 4:30 AM ET schedule.
- [ ] Ledger row minted at session close (counter read 438 free on 2026-08-27).
