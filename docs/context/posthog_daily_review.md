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
- **Who runs that review:** routine PRs get merged only from a Claude Code session
  that has run the `/premerge` lens review on them first. Never merge a routine PR
  from the GitHub UI directly, even with green checks. Green checks prove the gates,
  not the review. Every routine PR body repeats this instruction.
- Quote-tool bugs in money math, pricing, payments, or auth are report-only for the
  routine. Those fixes go through a normal reviewed session.
- **SHARED-ownership paths are report-only too** (per the AGENTS.md ownership table):
  `src/lib/quotes.ts`, `designs.ts`, `supabase*`, `sceneTypes.ts`,
  `src/lib/integrations/**`, `src/app/layout.tsx`, `globals.css`, `package.json` and
  the lockfile, tsconfig/eslint/next config, `AGENTS.md`, `.claude/**`, and
  `.github/workflows/**`. The routine never edits these.
- A fix that touches Jason's owned area (portal, quote builder, design editor,
  training, settings, inbox) must say so in the PR body ("touches Jason's area")
  and the daily report lists it under "needs Jason's look". Ownership stays with
  the area owner; the routine only proposes. Pricing is deliberately absent from
  this list: it sits in the absolute report-only exclusion above and is never
  fixable with a flag.
- The website (WordPress) side is report-only. No WordPress or Elementor writes.
- PostHog is read-only for the routine. No insight, dashboard, or flag mutations.
- Hard cap: 3 bug-fix PRs per run. Anything beyond that is reported, not fixed.
  This cap lives in the prompt, not in code, so it is an instruction the model
  follows rather than a technical limit. The backlog rule below is the backstop.
- **Backlog rule:** before fixing anything, the routine counts its own still-open
  PRs. At 5 or more, it opens no new fix PRs that day (report-only mode) and flags
  the backlog in the Telegram summary. Routine PRs left unreviewed for 7 days get
  named in the report as stale: merge, close, or hand to a working session.
- The routine runs on Sonnet 5 (routing table: builds run Sonnet; never Fable).

## How to pause or kill it

- Pause: claude.ai/code/routines, open "PostHog daily review", toggle off Repeats.
- Kill: same page, delete the routine. Past run sessions stay in the session list.
- A run already in progress: each run is a normal cloud session listed on the
  routine's detail page; open it and stop it there. Worst case if one finishes
  anyway is bounded: no merges, no prod writes, PostHog read-only, capped output.
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

Step 1, pull the data. Using the PostHog tools, review the last 24 hours. Both
surfaces report into ONE PostHog project (Yule Love Lights, id 506466); tell them
apart by the $host property: quote.yulelovelights.com is the quote tool,
yulelovelights.com is the marketing site. Review both hosts: exceptions and errors,
failed or anomalous events, funnel drop-offs across quote, portal, approval, and
payment, rage clicks and dead clicks, and any page whose traffic or conversion
pattern looks broken. If a PostHog call fails, say so in the report. Never invent
data.

Step 2, triage every finding into exactly one bucket:
- QUOTE TOOL BUG: a reproducible defect in this repository's code.
- WEBSITE FINDING: anything on yulelovelights.com. Report only. Never attempt a fix.
- SUGGESTION: a product or UX improvement backed by the data.
- NOISE: known noise or already handled. Before triaging, read the two most recent
  "PostHog daily report" GitHub issues and the open pull request list, and do not
  re-report or re-fix a finding already covered there.

Step 3, fix quote tool bugs. First count your own still-open pull requests from
previous runs of this routine. If 5 or more are open, fix nothing today: report
everything instead and flag the backlog in the Telegram summary. While counting,
note any of those PRs open 7 days or more and list them in the report under
"Bugs needing a human" as stale, with the recommendation to merge, close, or hand
them to a working session. Otherwise, for each
QUOTE TOOL BUG, up to a hard cap of 3 per run: reproduce the failure from the code,
write a failing test first when the shape allows it, fix it, and run the gates
(npx tsc --noEmit, npm run lint, npm test). Only proceed when all three are green.
Open one pull request per bug on a claude/ branch. The PR body must say "run for
Naldo", cite the PostHog evidence (event name, count, a sample session id, never raw
customer field values), describe the fix in plain English, and end with: "Needs a
premerge lens review before any merge. Do not merge this from the GitHub UI; open a
Claude Code session and run /premerge first." NEVER merge anything. Never push to
master.

Report-only exclusions, no exceptions: do not fix a bug that touches money math,
pricing, payments, or auth. Do not edit any SHARED-ownership path: src/lib/quotes.ts,
src/lib/designs.ts, any supabase* file, src/lib/sceneTypes.ts,
src/lib/integrations/, src/app/layout.tsx, globals.css, package.json, the lockfile,
tsconfig or eslint or next config, AGENTS.md, anything under .claude/, or anything
under .github/workflows/. Report those as needs-human with the evidence. If a fix
touches the portal, quote builder, design editor, training, settings, or inbox
(Jason's owned area), add "touches Jason's area" to the PR body and list it under
"needs Jason's look" in the report. Pricing is not in that list because it is
already excluded from fixing outright above.

Step 4, write the report. Create a GitHub issue in this repository titled
"PostHog daily report YYYY-MM-DD" with sections: Bugs fixed (PR links), Bugs needing
a human, Needs Jason's look, Website findings, Suggestions (best three first), Noise
skipped. Short and plain. On a quiet day with nothing found, still create the issue
with a one-line "quiet day" note so a silent failure is never mistaken for a quiet
day. Reference PostHog data by session id, event name, and count only. Never quote
raw customer field values (email, phone, name, address) from event properties or
URLs into the issue, a PR, or Telegram; a GitHub issue is durable and visible to
everyone with repo access.

Step 5, send the Telegram summary. Use the TELEGRAM_BOT_TOKEN and
TELEGRAM_REPORT_CHAT_ID environment variables and POST to
https://api.telegram.org/bot<token>/sendMessage. Keep it under 15 lines: counts,
PR links, the top three suggestions, and a link to the day's issue. Never include
secrets in any message, issue, or PR. If the Telegram send fails, still finish the
report issue and note the failure in it by variable name and HTTP status only
(for example "Telegram send failed, TELEGRAM_BOT_TOKEN request returned 401").
Never paste the request URL or the response body anywhere; the URL contains the
bot token.

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
- [x] Routine created (`trig_01PCjNCUYyCwNL6k2vMHaWM9`), dry run passed end to end
      2026-08-28 (report issue #1035, 4.6 min, zero bugs to fix, guardrails held),
      schedule ENABLED, next run 08:37 UTC daily.
- [ ] Naldo: Telegram values into the routine's cloud environment (until then,
      reports land as GitHub issues plus a mobile push notification).
- [ ] The live routine prompt still says "BOTH PostHog projects" in Step 1; this
      doc's corrected host-split wording is the intended text. The update call was
      blocked by the tool classifier in the setup session; sync it from the routine's
      edit page or retry from a later session. Harmless meanwhile: the dry run
      self-corrected and noted the single-project reality in its report.
- [ ] Ledger row minted at session close (counter read 438 free on 2026-08-27).
