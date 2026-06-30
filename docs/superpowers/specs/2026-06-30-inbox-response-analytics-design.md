# Inbox response-time analytics — design spec

**Date:** 2026-06-30 · **Area:** Dashboard (#58, Naldo) · **Status:** design, awaiting review
**Builds on:** the existing `responseMetrics.ts` / `ResponseStats` card (median · within-1h · within-4h · by-rep · by-source) shipped in v1/v2.

## Why

Response time is the #1 business lever ("replying too late"). Today we show median + within-1h/4h on
the inbox card only. Naldo wants to **learn as much as possible** about it: finer time buckets, how long
to *Completed*, whether we're improving over time, and how often a customer has to chase us again — visible
in **three places** (inbox card, insights page, home dashboard) with an **All-time / 90-day / 30-day** lens.

## Metrics (exact definitions)

All times use the existing convention: **response time = `handled_at − last customer message`** (clamped ≥0).

1. **Response-time buckets** (responsiveness distribution). Across handled items, share + count in:
   **≤15m · ≤1h · ≤4h · ≤1 day · ≤3 days · ≤1 week · >1 week.** Keeps the existing median + average.
2. **Time-to-completed** (resolution speed). For `status='completed'` items, `completed − first contact`
   where `completed = handled_at` (set by `markItemCompleted`) and `first contact = created_at`. Report
   **median** + coarse buckets **≤1 day · ≤3 days · ≤1 week · >1 week**. (Populates as items get Completed.)
3. **Trend** (are we improving?). Median response time for **this week** (last 7d), **last week** (prior
   7d), and **this month** (last 30d), with a faster/slower arrow (this-week vs last-week; faster = good).
   Trend is **window-independent** — always shown.
4. **Reopen rate** (response quality). Of handled customers, the share who messaged again:
   **distinct items with a `reopened` event ÷ distinct items handled**, over the selected window.

## Window selector

A toggle **All-time · Last 90 days · Last 30 days** drives metrics 1, 2, 4 and the median/avg/by-rep
(the Trend is fixed). An item is "in window W" when its activity timestamp (`handled_at`, else
`last_message_at`) falls within the last W days; All-time = no filter. The **server computes the metric set
for each of the three windows** and passes all three to the component, which toggles client-side (no refetch,
no `Date`-serialization across the boundary — the metric objects are plain numbers).

## Surfaces (one reusable component)

A single client component **`ResponseAnalytics`** renders in all three, fed the same `ResponseAnalyticsData`:
- **Inbox card** — replaces/expands `ResponseStats` on `/inbox` (the existing summary grows into this).
- **Insights page** — a new "Response time" section on `src/app/insights/page.tsx` (alongside the
  revenue cards/charts).
- **Home dashboard** — a section on `src/app/page.tsx` (under the KPI strip / worklist).

Each page (all server components) fetches the data + computes the analytics, then renders
`<ResponseAnalytics data={…} />`. The component owns the window toggle + the layout; it has **no data
fetching** of its own, so it stays pure-presentational + reusable.

## Architecture

**Pure core (`src/lib/dashboard/inbox/responseMetrics.ts`, extended — TDD):**
- `bucketOfResponse(ms): ResponseBucket` and the bucket boundary table.
- `computeResponseMetrics(items, now)` — extended to add `buckets`, `avg`, `timeToCompletedMedianMs`,
  `completedBuckets` (the existing fields stay).
- `filterByWindow(items, days | null, now)` — pure window filter.
- `computeTrend(items, now)` — `{ thisWeekMs, lastWeekMs, thisMonthMs, direction }`.
- `reopenRate(handledCount, reopenedCount): number | null` — pure ratio.
- `computeResponseAnalytics(items, reopen, now): ResponseAnalyticsData` — the one entry point: returns
  `{ windows: { allTime, last90, last30 }, trend, reopen, truncated }` (each `windows.*` is a
  `ResponseMetrics`). This is what the pages pass to the component.

**Data layer (`store.ts`):**
- Extend `listItemsForMetrics` → fetch **all-time** (up to the existing `METRICS_ROW_CAP`, not just 30 days)
  and **add `created_at`** to the select + `MetricItem` (needed for time-to-completed + window filtering).
  Keep the `truncated` flag.
- Add `getReopenCounts(sinceDays | null)` → `{ handled, reopened }` from `dashboard_activity` (distinct
  `inbox_item_id` per action, optionally since a cutoff). Called per window (3 cheap COUNT-style reads) or
  once all-time + derived — decide in planning.

**Component (`src/components/dashboard/inbox/ResponseAnalytics.tsx`, new client):**
- Props `{ data: ResponseAnalyticsData }`. Holds `window` state (all/90/30). Renders: the window toggle, a
  headline (median + within-1h/4h), the **bucket distribution** (a simple labeled bar list), the **trend**
  row (3 medians + arrow), **time-to-completed** (median + buckets), **reopen rate**, and **by-rep**.
  Tokens + compact style match `ResponseStats`. `nowMs` passed in (no `Date.now()` in render).

## Data flow

`/inbox`, `/insights`, `/` each: `listItemsForMetrics()` + `getReopenCounts(...)` →
`computeResponseAnalytics(items, reopen, now)` → `<ResponseAnalytics data={…} />`. The component toggles the
window over the pre-computed sets; the trend + reopen render from the same bundle.

## Edge / empty handling

- No handled items in a window → median/buckets show "—" / empty bars (not 0% as real). Mirror the insights
  page's existing "couldn't load" guard pattern for a failed fetch.
- `truncated` (row cap hit) → a small "based on the most recent N" note, like the current `ResponseStats`.
- Negative durations clamped ≥0 (existing). Completed/trend tolerate null timestamps.

## Testing (TDD)

Pure-first: `bucketOfResponse` (every boundary), `filterByWindow` (in/out of 30/90/all + the timestamp
choice), `computeTrend` (week/month bucketing + direction), `reopenRate` (ratio + zero-handled → null),
`computeResponseMetrics` extended (bucket counts/pcts, time-to-completed median), `computeResponseAnalytics`
(the three windows + trend assembled). The component + store reads are tsc + review (no unit test), per the
house convention. All gates green before merge.

## Non-goals (YAGNI)

- By-channel + by-time-of-day breakdowns (Naldo deferred — easy follow-up).
- Charts/graphs — a labeled bar list is enough; no charting dep.
- Per-customer SLA config, alerting, or CSV export.
- No migration — reuses `inbox_items` + `dashboard_activity`.

## Files

**Modify:** `src/lib/dashboard/inbox/responseMetrics.ts` (+ `.test.ts`), `src/lib/dashboard/inbox/store.ts`
(`listItemsForMetrics`, new `getReopenCounts`), `src/app/inbox/page.tsx` (swap `ResponseStats`→`ResponseAnalytics`),
`src/app/insights/page.tsx` (+ section), `src/app/page.tsx` (+ section).
**Create:** `src/components/dashboard/inbox/ResponseAnalytics.tsx`.
**Retire:** `ResponseStats.tsx` once nothing imports it (or keep as a thin wrapper).

## Confirm during planning (not blockers)
- `getReopenCounts` exact shape (per-window vs all-time + derive) and the `dashboard_activity` distinct query.
- Whether `ResponseAnalytics` fully replaces `ResponseStats` or wraps it.
- The home/insights section placement + heading.
