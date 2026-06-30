# Inbox customer-state lifecycle + "In the works" + audit log/reverse — design spec

**Date:** 2026-06-30 · **Area:** Dashboard `/inbox` (#58, Naldo) · **Status:** design, awaiting review
**Builds on:** inbox triage v1 (#258) + v2 (#265 — reply-from-inbox, layer-3 suppression, the `followed_up_at` snooze).

## Why

Two operator asks:
1. An always-visible **"In the works"** section so the team can see at a glance every customer
   currently being worked — not just the ones needing a reply right now — and get nudged to follow up.
2. An **audit log** of every state change (handled / followed / completed / not-a-lead) with a way to
   **reverse** a wrong one.

Today, clicking **Handled** makes a customer *disappear* from the inbox. That's the core problem: a
customer we answered "in the moment" but who still needs a follow-up in a few days falls off the radar.
This spec reshapes the lifecycle so handled/followed customers stay visible until they're truly done.

## The customer-state lifecycle (confirmed with Naldo)

```
                 new inbound
                     │
                     ▼
              ┌─────────────┐   answer in the moment   ┌───────────┐
   newer ───▶ │ Needs reply │ ───────────────────────▶ │  Handled  │
  inbound     └─────────────┘                          └───────────┘
   (real)            ▲                                        │
                     │                            ~N days quiet → amber
                     │                              "needs follow-up"
                     │                                        │
                     │        we reach back out               ▼
                     │      ┌──────────────────────┐   (sets followed_up_at)
                     └───── │ Awaiting their reply  │ ◀───────┘
                            │     (followed)        │
                            └──────────────────────┘
                                       │ stale again → amber → nudge → loop
                                       ▼
                                 ┌───────────┐
                                 │ Completed │  (fully done — drops off the boards)
                                 └───────────┘

 Not a lead (dismissed) — reachable any time; hidden + sender suppressed.
 A genuine (non-automated) new inbound on ANY active OR completed item → back to Needs reply.
```

- **Needs reply** — `status='unresponded'`, no follow-up flag. The open list (top of inbox).
- **Handled** — `status='handled'`. We dealt with the current message. **Now stays visible** in
  "In the works → Handled." After the configurable threshold of no activity → amber "needs follow-up."
- **Awaiting their reply (followed)** — `followed_up_at IS NOT NULL`. We reached out (a sent reply, or a
  manual "Mark followed"); ball is in their court. Goes stale the same way → amber nudge.
- **Completed** — `status='completed'` (**NEW**). Fully done; no more contact expected. Drops off all
  boards (like dismissed, but a *good* terminal state). Recoverable via the audit log.
- **Not a lead** — `status='dismissed'`. Spam/junk; hidden + the sender is suppressed (v2 layer-3).

### Bucketing rules (the queries)
| Bucket | Condition |
|---|---|
| Needs reply | `status='unresponded' AND followed_up_at IS NULL` |
| In the works → Awaiting their reply | `followed_up_at IS NOT NULL AND status NOT IN ('completed','dismissed')` |
| In the works → Handled | `status='handled' AND followed_up_at IS NULL` |
| Completed | `status='completed'` |
| Not a lead | `status='dismissed'` |

(A sent reply marks an item **handled + followed**, so it lands in *Awaiting their reply* — correct: we
replied, we're waiting on them. A plain "Handled" click with no reply → the *Handled* group.)

## Data model changes

1. **`status` gains `completed`.** Migration alters the `inbox_items_status_check` constraint to
   `status in ('unresponded','handled','dismissed','completed')`. No other column needed — `completed`
   is just a status value; `followed_up_at` (from v2) is reused as-is.
2. **Settings key** `dashboard.followUpDays` (integer, default **3**) in the existing `app_settings`
   kv table — no migration (dashboard-owned key, same pattern as `dashboard.suppressedSenders`).
3. **`dashboard_activity` prior-state** — when an operator action is logged, record the prior status +
   followed flag in the existing `detail jsonb` (`{ from: { status, wasFollowed } }`). Lets *Reverse*
   restore the true prior state; old rows with no `from` fall back to a per-action inverse (below).

## "In the works" section (Note 1)

A new always-visible section on `/inbox`, below the open list, with **two labeled sub-groups**:
**Awaiting their reply** and **Handled** (per the bucket rules above). Server-rendered (like the existing
`FollowUpStrip`/`FollowedSection`), each row: customer name, channel, preview, and the time-in-state.

**Stale "needs follow-up" flag (compute-on-read, choice A):** for each item, if
`now − lastActivity > followUpDays`, render an **amber "Follow up — N days quiet"** badge and **sort that
item to the top of its group**. `lastActivity` = `followed_up_at` for the followed group, `handled_at`
for the handled group. No new writes, no cron — mirrors the existing amber/red escalation pattern. The
threshold comes from `dashboard.followUpDays`.

This **replaces** the v2 read-only `FollowedSection` (its "Awaiting their reply" group supersedes it).

## Completed state (Note 1)

- A **"Mark completed"** action on cards in Needs-reply and In-the-works. Sets `status='completed'`,
  clears `followed_up_at`, logs `completed` to `dashboard_activity` (with prior-state `from`).
- New `POST /api/dashboard/completed` (mirrors the v2 `/followed` + `/dismiss` route idiom).
- Completed items are excluded from every active board; a collapsed **"Completed (N)"** list (recent
  first) surfaces them read-only (for reference + the audit-log reverse path).
- **Reopen:** a genuine **newer inbound** on a completed item reopens it to Needs reply (extend the
  reducer's existing handled-reopen guard to also cover `completed`). Automated/newsletter messages are
  already classified `automated` at ingest (v2), so they do **not** reopen a completed customer — exactly
  Naldo's "no more comms unless it's automated like newsletters."

## Settings: follow-up threshold (Note 1)

On the existing `/inbox/settings` page, add a **"Follow-up reminder"** control: a number input (days)
bound to `dashboard.followUpDays`, default 3, saved via a small `POST /api/dashboard/settings` (or the
existing inbox-settings save path). Pure `getFollowUpDays()` reader with a safe default + clamp
(e.g. 1–60). The "In the works" stale flag reads this value.

## Audit log + reverse (Note 2)

A new **"Activity / Audit"** view (a tab or `/inbox/activity` page) listing `dashboard_activity` newest
first: **who** (actor → operator display name), **what** (handled / followed / completed / dismissed /
reopened / reversed / system auto-resolve), **which customer**, **when**. Paginated, operator-gated.

Each **operator** state-change entry (not system rows) gets a **"Reverse"** button → **full undo to prior
state**:
- **Reverse "Not a lead"** → restore prior status **and remove the sender from the suppression list**
  (so their messages stop auto-hiding — this also resolves the over-suppression risk flagged in the v2
  review).
- **Reverse "Completed"** → back to its prior state (Handled/Awaiting-reply via the logged `from`, else
  Handled).
- **Reverse "Handled"** → back to Needs reply (or prior).
- **Reverse "Followed"** → clear `followed_up_at` (back to Needs reply / Handled).

Mechanics: pure `inverseOf(action, fromState)` decides the target state; a thin
`POST /api/dashboard/activity/reverse` (operator-gated, item-id + activity-id validated) applies it via a
new `reverseItemState(...)` store fn, then logs a `reversed` activity row (so the reverse is itself
audited and can't silently differ). Reversing is idempotent (re-applying a no-op state is safe).

## Components / files

**Create**
- `src/lib/dashboard/inbox/lifecycle.ts` (+test) — pure: `bucketOf(item)`, `isStale(item, days, now)`,
  `inverseOf(action, from)`, `clampFollowUpDays(n)`.
- `src/app/api/dashboard/completed/route.ts` — mark completed.
- `src/app/api/dashboard/activity/reverse/route.ts` — reverse an entry.
- `src/app/api/dashboard/settings/route.ts` *(or extend the existing inbox-settings save)* — set `followUpDays`.
- `src/components/dashboard/inbox/InWorksSection.tsx` — the two-group section (replaces `FollowedSection`).
- `src/app/inbox/activity/page.tsx` + `src/components/dashboard/inbox/ActivityLog.tsx` — the audit view.

**Modify**
- `migrations/2026-06-30-inbox-completed-status.sql` — status CHECK + `completed`.
- `src/lib/dashboard/inbox/store.ts` — `listInWorks()` (two groups + stale), `listCompleted()`,
  `markItemCompleted()`, `reverseItemState()`, `listActivity()`; activity inserts record `from`.
- `src/lib/dashboard/inbox/reducer.ts` — reopen `completed` (not just `handled`) on a newer inbound.
- `src/lib/dashboard/inbox/suppression.ts` — `removeSuppressedSenders()` for the un-dismiss reverse.
- `src/app/inbox/page.tsx` — render `InWorksSection` + a link to the activity log.
- `src/app/inbox/settings/page.tsx` — the follow-up-days control.
- `src/components/dashboard/inbox/InboxList.tsx` — add "Mark completed" to the card actions.

## Testing (TDD)

Pure units first: `bucketOf` (every state → right bucket, incl. handled+followed → Awaiting-reply),
`isStale` (threshold boundary, per-group timestamp), `inverseOf` (each action → correct target),
`clampFollowUpDays`. Reducer: a newer inbound reopens `completed`; an automated touch does not; a
same-message re-ingest leaves `completed` intact. Store/route glue covered by tsc + a happy-path test +
review (per the store header convention). All gates green (`tsc · lint · vitest`) before merge.

## Non-goals / YAGNI

- No per-customer SLA config, no auto-emails on the 3-day flag (it's a visual nudge only).
- No bulk reverse / no full event-sourcing — single-entry reverse over the existing activity log.
- No change to escalation emails or the v1 "due today" `follow_ups` strip (that stays for quote-no-reply).
- Completed is not a CRM "won/lost" — just "done, stop tracking here."

## Phasing (for the implementation plan)

1. **State spine** — migration (`completed`), `lifecycle.ts` pures, store buckets, reducer reopen.
2. **In the works** — `InWorksSection` (two groups + stale flag), "Mark completed" action + route, page wiring.
3. **Settings** — `followUpDays` control + reader, wired into the stale flag.
4. **Audit log + reverse** — activity list view, reverse route + store fn + `removeSuppressedSenders`,
   prior-state logging.

## To confirm during planning (not blockers)
- The exact `/inbox/settings` save path (reuse vs new `/api/dashboard/settings`).
- Whether the activity log is a `/inbox/activity` page or an in-page tab (layout call).
- `lastActivity` source for the handled stale flag — `handled_at` (present) vs `updated_at`.
