---
name: project-quote-tool
description: "AI Quote Tool — current state, confirmed decisions, run commands, gotchas, and what's next. Read first each session."
metadata: 
  node_type: memory
  type: project
  originSessionId: 834b8d13-f89f-476d-bae1-0a9ab5613799
---

# AI Quote Tool — project state (READ FIRST)

> Session-continuity layer — the quick "where are we / what's decided" so a cold session resumes without re-litigating. Deep detail lives in the repo: `docs/ONBOARDING.md` (setup), `docs/CURRENT_STATE.md` (done / half-done / bugs), `docs/CONVENTIONS.md` (how to add code). Pair this with `session_log.md`.

## Current state at a glance
- **Pre-launch.** This tool is NOT customer-facing or used internally yet. The live customer flow today is **home.works** (separate system). So changes here are lower-risk — we're building *toward* launch.
- Deployed on **Vercel** (`yll-quote-tool`, Production tracks `master` → quote.yulelovelights.com), but not yet shown to customers.
- Runs locally on **Next 16.2.6** (Turbopack), connected to the **real Supabase** (~55 real/test quotes). `.env.local` is filled on Jason's machine (values: see `project_secrets_access.md`).
- Gates all green: `npx tsc --noEmit`, `npm run lint`, `npm test` (Vitest).

## Scope / out of scope (now)
- **IN:** QA-driven bug fixes + feature work on the quote builder, pricing engine, and customer portal (the punch-list below).
- **OUT / deferred:** wiring prod CRM + home.works (on hold — likely intentional during testing; home.works may be dropped for a different route); the portal package tiers (Classic/Festive/Yule) are Claude-generated placeholders to configure later; the planned-features backlog (c9Lines, SSIM, auto-send, Replicate pin).

## Decisions confirmed — DON'T re-ask
- **Roofline model (target):** 🔴 red line = **front roofline only = Santa's**; 🔵 blue line = **ridge + sides**. **Santa's & Gingerbread are MUTUALLY EXCLUSIVE** (Santa's OR Gingerbread OR none). Pricing: Santa's = front×rate; **Gingerbread = (front + ridge+sides)×rate**. Customer picks on the portal; operator quotes everything. *(Today's code wrongly treats them as two additive line items and prices Gingerbread as ridge-only — see task #17.)*
- **$1000 minimum before tax** applies EVERYWHERE (packages + à la carte). A quote may have no roofline if other items total ≥ $1000.
- **Multi-image quoting:** extra images are **manual-only** (no AI auto-quote) to avoid double-counting; no cross-image AI dedup. Image 1 covers the roof.
- **Light color/pattern:** operator sets a default (warm white by default) in the builder; the customer sees it **pre-selected** on the portal and can change it; saved to the quote; no extra cost. (Option list in task #26.)
- **4.5ft garland:** labor $135, fullDecor $210; **bow tier still $0 — pending Naldo.**
- **Workflow:** never commit without Jason's explicit "yes"; PR-not-master; run gates (tsc + lint + test) before commit. Jason + Naldo are on different machines → `docs/context/` is the canonical shared memory.
- **Pushing:** **Claude runs `git push`** (Jason approved in Session 1). Pushing to the `Yule-Love-Lights` org is NOT blocked here, unlike the design tool's exfil guard. Commits still require Jason's explicit "yes" first.

## How to run locally
- Dev server (repo root). Via Claude Code's **Bash** tool, prefix to dodge the empty-`ANTHROPIC_API_KEY` shell quirk:
  `unset ANTHROPIC_API_KEY; unset ANTHROPIC_BASE_URL; export PATH="/c/Program Files/nodejs:$PATH"; npm.cmd run dev`
  (Normal terminal: just `npm run dev`.) → http://localhost:3000
- Gates: `npx tsc --noEmit` · `npm run lint` · `npm test`
- Key pages: `/quote/new` (operator) · `/admin/quotes` · `/admin/renders` · `/portal-snowglobe/<quoteId>` · `/training/*`.

## Known gotchas
- Empty `ANTHROPIC_API_KEY` in the Claude-Code shell overrides `.env.local` → Claude routes 503. Unset it before `npm run dev`.
- `react-hooks/set-state-in-effect` is at **error**; the fix pattern for legit effects is a `queueMicrotask`/rAF defer.
- Vercel env vars are all **"Sensitive"** (unreadable) — pull secret values from source accounts (`project_secrets_access.md`).
- Vercel prod lacks the `HIGHLEVEL_*` vars + uses mismatched home.works var names → prod CRM/home.works are off (likely intentional; task #5 on hold).

## QA punch-list (the active backlog — mirrored from the Claude task list so it survives a cold session)
- **#17** Roofline redesign (the model above — *big*) · **#18** $1000 minimum everywhere (contained) · **#19** [low] operator "recommend items" checkboxes
- **#20** corner-house default → front-door view (feasibility TBD) · **#21** move Street View camera along the road (feasibility TBD) · **#22** multi-image quoting (*big*) · **#23** re-analyze button for uploaded images · **#24** [bug] C9 line delete doesn't reset footage · **#25** [UX] discount input accept `20` not `0.20` · **#26** portal color/pattern picker
- Pending / needs Naldo: #4 verify renders RLS · #6 dormant portals decision · #7 dev Supabase · #8 bow price · #9 HL stage mapping · #10 reviews · #11 phone/video · #14 migration apply + image cleanup.

## Next up
Jason picks the first QA item. Warm-ups: **#25** (quick) or **#24** (contained bug); then **#18** ($1000 minimum); then plan **#17** (roofline — phase-1 pricing + tests before touching money logic). Also confirm the `jason/refresh-full-schema` PR is merged.
