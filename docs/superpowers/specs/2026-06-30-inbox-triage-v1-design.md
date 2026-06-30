# Inbox triage v1 — design spec

**Date:** 2026-06-30 · **Area:** Dashboard `/inbox` (#58, Naldo) · **Status:** design, awaiting review

## Why

The `/inbox` dashboard shipped (PR #249) and is live on prod. Responding to customers faster is the
single biggest opportunity in the business, and the inbox is where that happens. Two problems block it:

1. **No triage at a glance.** The top of `/inbox` is a one-line blurb. Nothing tells the operator
   *who has waited longest*, *how many are overdue*, or *how much money is sitting unanswered*.
2. **The inbox is polluted with noise.** Live data shows it ingesting our own escalation emails,
   automated notices ("just called with no option…"), and vendor marketing (a Jobber ticket blast) —
   all surfaced as if they were customers waiting on us. The "28 unanswered" headline is inflated;
   roughly half is not a real lead. Noise erodes trust in the whole tool.

## Goals (v1)

- Make the **most-overdue / highest-value waiting customer obvious at a glance**.
- **Cut the noise** so every item in the inbox is (almost certainly) a real customer.
- Keep **one ranked work list** so the operator always knows who to answer next.

## Non-goals (v1) — deferred to v2

- **AI-drafted replies** and **reply-inline** (sending from the dashboard). Biggest speed unlock, but
  highest risk (generating + sending real messages) → ships as a fast-follow once v1 is clean.
- **$-weighted / blended sort.** v1 sorts by wait time only; the $ value is shown on the card so a
  person can override by eye. A "sort by value" toggle can come later.
- **Business-hours-aware SLA clock** (overnight ≠ overdue), **snooze / waiting-on-them**, and
  **push/SMS alerts**. Good ideas, not v1.
- **GHL-side marketing auto-detection** beyond the domain + manual layers below.

## Layout (Option A — confirmed)

A single ranked list with summary tiles on top — *not* per-channel kanban lanes (per-channel lanes
fragment the work and fight the "answer the most-overdue person next" goal). Top to bottom:

1. **At-a-glance strip** — four metric tiles: `Oldest waiting` · `Overdue (>4h)` · `In quotes waiting ($)`
   · `Open leads` (with a muted "N filtered as noise" subline).
2. **Channel filter tiles** — `All` · `Gmail` · `GHL` · `Quote`, each with its unanswered count; clicking
   one filters the list. A **Settings** gear sits at the right of this row.
3. **Response-stats bar** — the existing `responseMetrics` (median first reply, % within 1h, % within 4h).
4. **Work list** — one list, **oldest-waiting first**, with enriched cards (below).

## Card datapoints

Each card shows, at a glance:

- Channel badge + contact name + message subject/preview (existing).
- **Waiting time**, colored: red if overdue (>4h), amber (>1h), per the existing escalation thresholds.
- **New lead vs returning** — a "New lead · never contacted" badge, or "Returning · N past quotes",
  derived from the contact↔customer/quote linkage that already exists.
- **$ value** on quote-sourced items (already available on the quotetool touch).
- **Unclaimed** indicator + the existing `Claim`.
- Existing actions retained: `Handled`, `Not a lead`.

## Noise filtering (the centerpiece)

Three layers decide whether an item is a real lead or noise. **Nothing is deleted** — filtered items
stay reachable via a "Show" affordance, and the at-a-glance strip reports the filtered count + breakdown.

1. **"Us" = the whole `@yulelovelights.com` domain.** Today the Gmail self-ingest guard only treats the
   *single watched address* as "from us", so escalation/internal emails sent from a *different* company
   address land as fake new leads. Widen the from-us check to match the company domain (and the
   escalation sender). This is also a standalone bug fix and can ship first.
2. **Automated / marketing auto-detect.** Tag a message as `automated` (hidden by default) when it has a
   `List-Unsubscribe` header, a `no-reply@`-style sender, or unsubscribe language ("no longer wish to
   receive these emails"). Catches the Jobber ticket blast and the "just called with no option" notice.
3. **Manual "Not a lead" learns.** The existing button (which marks the item dismissed) also records the
   *sender* on a suppression list, so future messages from that sender are auto-hidden.

Email (Gmail) supports layers 1–3 cleanly via headers/sender. GHL conversations are harder to classify
automatically, so GHL v1 relies on layers 1 + 3; we refine only if junk keeps leaking through.

## Default sort

**Oldest-waiting first** (most overdue at top). Rationale: with no existing triage rule, pure speed best
serves the stated #1 pain ("replying too late"). New-lead status and $ value are visible on every card so
an operator can still jump a fresh, high-value lead manually.

## Components (built for isolation + testing)

- **`classifyTouch` (pure)** — given a normalized touch (sender, headers, source), returns
  `lead | automated | from-us` plus a reason. Unit-tested per layer, including the self-ingest case
  (escalation email from `@yulelovelights.com` → `from-us`).
- **`buildInboxSummary` (pure)** — given the open items, returns the at-a-glance numbers (oldest waiting,
  overdue count, $ in quotes waiting, open-leads count, filtered count + breakdown) and per-channel counts.
- **`rankInbox` (pure)** — the oldest-waiting-first ordering.
- **Ingest/store change** — apply `classifyTouch` during reconcile/poll so noise is tagged at write time;
  a small sender-suppression store backs layer 3.
- **UI** — the at-a-glance strip, the filter-tiles row, and the enriched card; the list reads `rankInbox`.

## Testing (TDD)

Write failing tests first for the pure units: `classifyTouch` (each layer + the self-ingest regression),
`buildInboxSummary` (counts, $ sum, filtered breakdown), and `rankInbox` (oldest-first ordering, ties).
UI is verified on a preview deploy (Konva-free here, but the list/strip are headless-testable at the
data layer). All gates green (`tsc · lint · vitest`) before any merge.

## To confirm during planning (not blockers)

- Exact mapping of "Not a lead" to the current status model (`unresponded | handled | dismissed`) and
  whether noise needs a new `category`/`hidden` field vs. reusing `dismissed`.
- Where the per-item quote $ is read for the "in quotes waiting" sum.
- Storage for the layer-3 sender suppression list (new table vs. an `app_settings` key).

## Phasing

- **v1 (this spec):** layout + at-a-glance data + enriched cards + noise filtering + default sort.
- **v2 (fast-follow):** AI-drafted reply + reply-inline.
