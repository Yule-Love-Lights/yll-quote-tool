---
name: premerge
description: "Risk-scaled parallel pre-merge review gate for yll-quote-tool. Classifies the diff into a tier (FULL, CODE, or PROCESS), spawns that tier's lens agents in parallel with a findings-file report contract, dispositions every finding, and stops for the dev's explicit merge-go. Trigger: '/premerge', 'premerge review', 'run the premerge gate'."
---

# Premerge

This is the runnable form of the AGENTS.md "Review gates" policy (the
Review gates section, standing policy). AGENTS.md stays the source of the
policy; this skill is how the running assistant actually executes it. If
the two ever disagree, AGENTS.md wins and this skill needs updating to
match, not the other way around.

The gate never merges. It ends by showing the dev a table and a plain
English diff summary, then it waits.

## Step 1: classify the diff into a tier

Get the diff before doing anything else (`git diff` against the PR's base,
or `gh pr diff <n>` for an open PR). Read the changed file list and the
actual hunks, not just file names, since a file can be touched without its
risky lines being touched.

**FULL** — any of these appear in the diff:

- Money math: pricing engine, totals, tax, rounding, anything under
  `src/lib/pricing/**`.
- Invoices or charges: PDF/doc generation, payment or charge routes,
  approve/refund/rebook paths.
- Portal, quote, or checkout UI: `src/app/portal/**`, `src/components/portal/**`,
  `src/app/quote/**`, `src/components/quote/**`, or any homeowner-facing
  screen in the approval/payment flow.
- Emails: a changed template, trigger, or send route.
- Auth, permissions, or RLS: a changed permission check, role gate, or
  Supabase row-level security policy.
- Migrations: any new or edited file under a migrations path, or a schema
  change.

**CODE** — touches application code but none of the FULL triggers above
(dashboard-only, internal tooling, tests, a component with no money or
customer-facing surface, etc).

**PROCESS** — touches only docs, a skill, an agent definition, or config
(`AGENTS.md`, `CLAUDE.md`, anything under `.claude/**`, `.github/workflows/**`,
`docs/**`, a ledger or session-log entry) with zero application code
changed. If even one application file is touched alongside docs, this is
CODE or FULL, not PROCESS, classify by the code that's there.

Print the tier and the specific trigger evidence (file:line or file names)
that put it there before moving on. If genuinely torn between two tiers,
pick the higher-risk one and say why.

## Step 2: spawn the tier's lenses, in parallel, in one message

Every spawn uses the Agent tool with an explicit model: **Sonnet 5** for
every lens finder. Never let a spawn inherit the session model; this
matters most in a Fable or Opus session, where an inherited model would
bill cheap-hunter work at a top-tier rate.

Tier to lens mapping:

- **FULL**: spawn all four — `lens-customer`, `lens-staff`, `lens-admin`,
  `lens-technical` — in one message so they run concurrently.
- **CODE**: spawn `lens-technical` plus exactly one persona lens, picked by
  the surface the diff actually touches: `lens-staff` for dashboard, quote
  builder, or internal workflow code; `lens-customer` for a customer-facing
  surface that didn't already trigger FULL; `lens-admin` for settings,
  reporting, or permissions code. Default to `lens-staff` if the surface is
  genuinely internal-only with no persona clearly implicated, and say that
  default was used.
- **PROCESS**: spawn `lens-process` alone.

Before spawning, pick a temp directory for findings files and name it in
the spawn message (an OS temp directory, or the session's scratchpad if
one is defined). Each lens gets its own unique findings-file path inside
it, e.g. `<temp-dir>/premerge-<lens-name>-<pr-or-branch>.md`.

Each spawn brief must be self-contained (the agent has no other context):

- The PR number or branch name being reviewed.
- The one-paragraph app context (quoting and portal tool for a residential
  lighting company; `master` auto-deploys; who owns what per AGENTS.md).
- Which lens it is (paste or point at the matching `.claude/agents/lens-*.md`
  definition).
- The exact findings-file path it must write to.

## Step 3: collect findings, respawn stalls once

After all spawns return, glob the findings directory for the expected
files. Any file that did not appear means that lens stalled.

- Respawn that one lens once, same brief, same findings-file path.
- If it still does not appear after the respawn, stop retrying. Report the
  stall itself as a finding against that lens: `HIGH: lens-<name> stalled
  twice, no findings file, reviewed 0 of its hunt list`. A silent gap in
  coverage is worse than a visible one.

## Step 4: disposition every finding

Read every findings file. For every single finding, in every lens, assign
one disposition:

- **fix**: change the code (or the doc, for a process finding) before
  asking for the merge-go. Every HIGH finding gets fixed before you ask,
  not after; do not ask for a go with an open HIGH.
- **accept**: leave it as is, with a one-line stated reason (not "looks
  fine", an actual reason: intentional tradeoff, already covered
  elsewhere, out of scope for this PR).
- **defer**: real issue, not blocking this PR, gets a ledger row (or the
  repo's equivalent tracked-debt location) so it does not vanish.

Fix HIGH findings, then re-check anything you fixed against the same lens's
hunt list before moving on; a fix that introduces a new problem is not a
fix.

## Step 5: print the consolidated table, then stop and wait

Print one table, all lenses that ran:

| Lens | Verdict | HIGH | MED | LOW | Disposition summary |
|---|---|---|---|---|---|

Verdict is the lens's own PASS/CONCERNS/BLOCK from its findings file.
Disposition summary is short: how many fixed, how many accepted, how many
deferred, and the ledger reference for any deferred item.

Below the table, give the dev a plain-English summary of the actual diff
(not of your intent), same as the standing merge rule in AGENTS.md rule 4.

Then stop. **Never merge.** Wait for the dev's explicit go, the same as
every other merge in this repo.
