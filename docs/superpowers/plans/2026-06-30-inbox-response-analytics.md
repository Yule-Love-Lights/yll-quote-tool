# Inbox Response-Time Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Richer inbox response-time analytics — response-time buckets, time-to-completed, week-over-week trend, and reopen rate — over an All-time / 90-day / 30-day window, shown on the inbox card, the insights page, and the home dashboard via one reusable component.

**Architecture:** Extend the pure `responseMetrics.ts` (buckets, time-to-completed, trend, reopen-rate, and a `computeResponseAnalytics` assembler that returns the three pre-computed windows + the fixed trend). The data layer fetches all-time items (+ `created_at`) and reopen counts; each of the three server pages computes the bundle and passes it to a new client `ResponseAnalytics` component that toggles the window. No migration.

**Tech Stack:** TypeScript (no `any` — lint error), React/Next server+client components, Vitest. Gates from repo root: `npx tsc --noEmit`, `npx eslint src` (0 errors — NOT `npm run lint`, which scans nested worktrees), `npx vitest run <file>`.

**Spec:** `docs/superpowers/specs/2026-06-30-inbox-response-analytics-design.md`.

**Pre-flight (every implementer):** repo root `C:/Users/ebhdh/OneDrive/Documents/Ai Quote Tool`; branch `naldo/inbox-response-analytics` (confirm with `git rev-parse --abbrev-ref HEAD`). READ `src/lib/dashboard/inbox/responseMetrics.ts` (existing `MetricItem`, `ResponseMetrics`, `median`, `computeResponseMetrics`, `ESCALATION` import) before editing.

---

## File map
**Modify:** `src/lib/dashboard/inbox/responseMetrics.ts` (+ `.test.ts`), `src/lib/dashboard/inbox/store.ts`, `src/app/inbox/page.tsx`, `src/app/insights/page.tsx`, `src/app/page.tsx`.
**Create:** `src/components/dashboard/inbox/ResponseAnalytics.tsx`.

---

## Task 1: Buckets + window filter + extend `computeResponseMetrics`

**Files:** `src/lib/dashboard/inbox/responseMetrics.ts`, `responseMetrics.test.ts`

- [ ] **Step 1: Failing tests** (append to `responseMetrics.test.ts`; READ the file first for its existing imports/helpers)

```ts
import { bucketOfResponse, RESPONSE_BUCKETS, filterByWindow, computeResponseMetrics } from './responseMetrics';

const T = new Date('2026-06-30T12:00:00Z');
const agoMs = (ms: number) => new Date(T.getTime() - ms);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe('bucketOfResponse', () => {
  it('maps durations to the right bucket key', () => {
    expect(bucketOfResponse(10 * MIN)).toBe('15m');
    expect(bucketOfResponse(45 * MIN)).toBe('1h');
    expect(bucketOfResponse(3 * HOUR)).toBe('4h');
    expect(bucketOfResponse(20 * HOUR)).toBe('1d');
    expect(bucketOfResponse(2 * DAY)).toBe('3d');
    expect(bucketOfResponse(6 * DAY)).toBe('1w');
    expect(bucketOfResponse(10 * DAY)).toBe('over');
  });
});

describe('filterByWindow', () => {
  const items = [
    { status: 'handled', lastMessageAt: agoMs(2 * DAY), handledAt: agoMs(2 * DAY), handledBy: 'a', source: 'ghl', createdAt: agoMs(2 * DAY) },
    { status: 'handled', lastMessageAt: agoMs(40 * DAY), handledAt: agoMs(40 * DAY), handledBy: 'a', source: 'ghl', createdAt: agoMs(40 * DAY) },
  ];
  it('null window keeps all; 30d drops the 40-day-old item', () => {
    expect(filterByWindow(items, null, T)).toHaveLength(2);
    expect(filterByWindow(items, 30, T)).toHaveLength(1);
    expect(filterByWindow(items, 90, T)).toHaveLength(2);
  });
});

describe('computeResponseMetrics — buckets + time-to-completed', () => {
  const items = [
    { status: 'handled', lastMessageAt: agoMs(3 * HOUR), handledAt: agoMs(2 * HOUR), handledBy: 'a', source: 'ghl', createdAt: agoMs(5 * HOUR) }, // 1h response
    { status: 'completed', lastMessageAt: agoMs(5 * DAY), handledAt: agoMs(1 * DAY), handledBy: 'a', source: 'ghl', createdAt: agoMs(3 * DAY) }, // completed in 2 days
  ];
  it('produces a bucket distribution over handled responses', () => {
    const m = computeResponseMetrics(items, T);
    const total = m.buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(1); // one handled item
    expect(m.buckets.find((b) => b.key === '1h')?.count).toBe(1);
  });
  it('computes the median time-to-completed for completed items', () => {
    const m = computeResponseMetrics(items, T);
    expect(m.timeToCompletedMedianMs).toBe(2 * DAY);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `npx vitest run src/lib/dashboard/inbox/responseMetrics.test.ts`

- [ ] **Step 3: Implement** in `responseMetrics.ts`:
  - Add `createdAt: Date | null` to `MetricItem`.
  - Add the bucket table + helper + distribution:
  ```ts
  export const RESPONSE_BUCKETS = [
    { key: '15m', label: '≤15 min', maxMs: 15 * 60_000 },
    { key: '1h', label: '≤1 hr', maxMs: 60 * 60_000 },
    { key: '4h', label: '≤4 hr', maxMs: 4 * 60 * 60_000 },
    { key: '1d', label: '≤1 day', maxMs: 24 * 60 * 60_000 },
    { key: '3d', label: '≤3 days', maxMs: 3 * 24 * 60 * 60_000 },
    { key: '1w', label: '≤1 week', maxMs: 7 * 24 * 60 * 60_000 },
    { key: 'over', label: '>1 week', maxMs: Infinity },
  ] as const;
  export type ResponseBucketKey = (typeof RESPONSE_BUCKETS)[number]['key'];

  export function bucketOfResponse(ms: number): ResponseBucketKey {
    return (RESPONSE_BUCKETS.find((b) => ms <= b.maxMs) ?? RESPONSE_BUCKETS[RESPONSE_BUCKETS.length - 1]).key;
  }

  function distribution(durations: number[]): { key: ResponseBucketKey; label: string; count: number; pct: number | null }[] {
    const counts = new Map<ResponseBucketKey, number>();
    for (const d of durations) counts.set(bucketOfResponse(d), (counts.get(bucketOfResponse(d)) ?? 0) + 1);
    const total = durations.length;
    return RESPONSE_BUCKETS.map((b) => {
      const count = counts.get(b.key) ?? 0;
      return { key: b.key, label: b.label, count, pct: total ? count / total : null };
    });
  }

  export function filterByWindow(items: MetricItem[], days: number | null, now: Date): MetricItem[] {
    if (days == null) return items;
    const cutoff = now.getTime() - days * 86_400_000;
    return items.filter((i) => {
      const t = i.handledAt ?? i.lastMessageAt;
      return t != null && t.getTime() >= cutoff;
    });
  }
  ```
  - Extend `ResponseMetrics` with `buckets`, `timeToCompletedMedianMs: number | null`, `completedBuckets` (same shape as `buckets`). In `computeResponseMetrics`, after the existing `responses` array, add:
  ```ts
  const completedItems = items.filter((i) => i.status === 'completed' && i.createdAt && i.handledAt);
  const completedTimes = completedItems.map((i) => Math.max(0, (i.handledAt as Date).getTime() - (i.createdAt as Date).getTime()));
  ```
  and include in the return: `buckets: distribution(responses), completedBuckets: distribution(completedTimes), timeToCompletedMedianMs: median(completedTimes)`.

- [ ] **Step 4: Run → PASS.** `npx tsc --noEmit` → 0; `npx eslint src` → 0 errors.
- [ ] **Step 5: Commit** — `git add src/lib/dashboard/inbox/responseMetrics.ts src/lib/dashboard/inbox/responseMetrics.test.ts && git commit -m "feat(#58): response-time buckets + time-to-completed + window filter"`

---

## Task 2: Trend + reopen rate + `computeResponseAnalytics`

**Files:** `src/lib/dashboard/inbox/responseMetrics.ts`, `responseMetrics.test.ts`

- [ ] **Step 1: Failing tests** (append)

```ts
import { computeTrend, reopenRate, computeResponseAnalytics } from './responseMetrics';

describe('computeTrend', () => {
  it('medians this/last week + this month and flags direction', () => {
    const items = [
      { status: 'handled', lastMessageAt: agoMs(2 * DAY), handledAt: new Date(agoMs(2 * DAY).getTime() + HOUR), handledBy: 'a', source: 'ghl', createdAt: agoMs(2 * DAY) }, // this week, 1h
      { status: 'handled', lastMessageAt: agoMs(10 * DAY), handledAt: new Date(agoMs(10 * DAY).getTime() + 4 * HOUR), handledBy: 'a', source: 'ghl', createdAt: agoMs(10 * DAY) }, // last-ish: outside 7d, inside 30d
    ];
    const t = computeTrend(items, T);
    expect(t.thisWeekMs).toBe(HOUR);
    expect(t.thisMonthMs).not.toBeNull();
    expect(['faster', 'slower', 'flat', 'na']).toContain(t.direction);
  });
});

describe('reopenRate', () => {
  it('ratio, capped at 1, null when no handled', () => {
    expect(reopenRate(10, 3)).toBeCloseTo(0.3);
    expect(reopenRate(0, 0)).toBeNull();
    expect(reopenRate(2, 5)).toBe(1);
  });
});

describe('computeResponseAnalytics', () => {
  it('assembles the three windows + trend + reopen rates', () => {
    const items = [
      { status: 'handled', lastMessageAt: agoMs(2 * DAY), handledAt: agoMs(2 * DAY), handledBy: 'a', source: 'ghl', createdAt: agoMs(2 * DAY) },
      { status: 'handled', lastMessageAt: agoMs(45 * DAY), handledAt: agoMs(45 * DAY), handledBy: 'a', source: 'ghl', createdAt: agoMs(45 * DAY) },
    ];
    const reopen = { all: { handled: 10, reopened: 2 }, '90': { handled: 8, reopened: 1 }, '30': { handled: 5, reopened: 0 } };
    const a = computeResponseAnalytics(items, reopen, T, false);
    expect(a.windows.all.handled).toBe(2);
    expect(a.windows['30'].handled).toBe(1); // the 45-day item is filtered out
    expect(a.reopen.all).toBeCloseTo(0.2);
    expect(a.reopen['30']).toBe(0);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**:
```ts
export type TrendDirection = 'faster' | 'slower' | 'flat' | 'na';
export type Trend = { thisWeekMs: number | null; lastWeekMs: number | null; thisMonthMs: number | null; direction: TrendDirection };

function medianResponseIn(items: MetricItem[], startMs: number, endMs: number): number | null {
  const rs = items
    .filter((i) => i.status !== 'unresponded' && i.lastMessageAt && i.handledAt && (i.handledAt as Date).getTime() >= startMs && (i.handledAt as Date).getTime() < endMs)
    .map((i) => Math.max(0, (i.handledAt as Date).getTime() - (i.lastMessageAt as Date).getTime()));
  return median(rs);
}

export function computeTrend(items: MetricItem[], now: Date): Trend {
  const n = now.getTime(), D = 86_400_000;
  const thisWeekMs = medianResponseIn(items, n - 7 * D, n + D);
  const lastWeekMs = medianResponseIn(items, n - 14 * D, n - 7 * D);
  const thisMonthMs = medianResponseIn(items, n - 30 * D, n + D);
  let direction: TrendDirection = 'na';
  if (thisWeekMs != null && lastWeekMs != null) direction = thisWeekMs < lastWeekMs ? 'faster' : thisWeekMs > lastWeekMs ? 'slower' : 'flat';
  return { thisWeekMs, lastWeekMs, thisMonthMs, direction };
}

export function reopenRate(handled: number, reopened: number): number | null {
  if (handled <= 0) return null;
  return Math.min(1, reopened / handled);
}

export type WindowKey = 'all' | '90' | '30';
export type ReopenCounts = Record<WindowKey, { handled: number; reopened: number }>;
export type ResponseAnalyticsData = {
  windows: Record<WindowKey, ResponseMetrics>;
  trend: Trend;
  reopen: Record<WindowKey, number | null>;
  truncated: boolean;
};

export function computeResponseAnalytics(items: MetricItem[], reopen: ReopenCounts, now: Date, truncated: boolean): ResponseAnalyticsData {
  const windowDays: Record<WindowKey, number | null> = { all: null, '90': 90, '30': 30 };
  const windows = {} as Record<WindowKey, ResponseMetrics>;
  const reopenRates = {} as Record<WindowKey, number | null>;
  for (const k of ['all', '90', '30'] as WindowKey[]) {
    windows[k] = computeResponseMetrics(filterByWindow(items, windowDays[k], now), now);
    reopenRates[k] = reopenRate(reopen[k].handled, reopen[k].reopened);
  }
  return { windows, trend: computeTrend(items, now), reopen: reopenRates, truncated };
}
```

- [ ] **Step 4: Run → PASS.** tsc 0; `eslint src` 0.
- [ ] **Step 5: Commit** — `git add src/lib/dashboard/inbox/responseMetrics.ts src/lib/dashboard/inbox/responseMetrics.test.ts && git commit -m "feat(#58): response trend + reopen rate + computeResponseAnalytics assembler"`

---

## Task 3: Data layer — all-time metrics + reopen counts

**Files:** `src/lib/dashboard/inbox/store.ts`

- [ ] **Step 1: Implement** (service-role glue — tsc + review). READ `listItemsForMetrics` + `MetricsResult` + `METRICS_ROW_CAP` first.
  - In `listItemsForMetrics`: change the default to fetch **all-time** (drop the `.gte('last_message_at', since)` filter, or set `sinceDays` to a large default like 3650) and **add `created_at`** to the `.select(...)` and to the mapped `MetricItem` (`createdAt: r.created_at ? new Date(...) : null`). Keep the `METRICS_ROW_CAP` `.limit` + the `truncated` flag (truncated = data.length === cap). Order by `last_message_at desc` so the cap keeps the most recent.
  - Add `getReopenCounts`:
  ```ts
  import type { ReopenCounts, WindowKey } from './responseMetrics';
  export async function getReopenCounts(now: Date): Promise<ReopenCounts> {
    const sb = getSupabaseServiceClient();
    const empty: ReopenCounts = { all: { handled: 0, reopened: 0 }, '90': { handled: 0, reopened: 0 }, '30': { handled: 0, reopened: 0 } };
    if (!sb) return empty;
    const windows: Record<WindowKey, number | null> = { all: null, '90': 90, '30': 30 };
    const out = { ...empty };
    for (const k of ['all', '90', '30'] as WindowKey[]) {
      const since = windows[k] == null ? null : new Date(now.getTime() - (windows[k] as number) * 86_400_000).toISOString();
      for (const action of ['handled', 'reopened'] as const) {
        let q = sb.from('dashboard_activity').select('inbox_item_id', { count: 'exact', head: true }).eq('action', action);
        if (since) q = q.gte('created_at', since);
        const { count } = await q;
        out[k][action === 'handled' ? 'handled' : 'reopened'] = count ?? 0;
      }
    }
    return out;
  }
  ```
  (Counts are per-event, not distinct-item — acceptable as a reopen *rate* proxy; note it in a comment. If a `count: 'exact', head: true` distinct isn't available, this event-count form is fine.)

- [ ] **Step 2:** `npx tsc --noEmit` 0; `npx eslint src` 0; `npx vitest run src/lib/dashboard/inbox/store.test.ts` (existing pass — if a metrics test asserts the 30-day filter, update it to the new all-time behavior).
- [ ] **Step 3: Commit** — `git add src/lib/dashboard/inbox/store.ts src/lib/dashboard/inbox/store.test.ts && git commit -m "feat(#58): metrics fetch all-time + created_at; reopen counts per window"`

---

## Task 4: `ResponseAnalytics` component

**Files:** Create `src/components/dashboard/inbox/ResponseAnalytics.tsx`

- [ ] **Step 1: Implement** (client). READ `src/components/dashboard/inbox/ResponseStats.tsx` for the tokens/format helpers (e.g. its ms→human duration formatter — reuse or mirror it).
  - `'use client'`. Props `{ data: ResponseAnalyticsData; nowMs: number }`.
  - `const [win, setWin] = useState<WindowKey>('30');` A 3-button toggle (All-time / 90 days / 30 days) sets `win`. `const m = data.windows[win];`
  - Render: a window toggle; a headline (median + avg + within-1h/4h from `m`); the **bucket distribution** (`m.buckets` as a labeled horizontal bar list — width = `pct`, show count + `Math.round(pct*100)%`); the **trend** row (`data.trend.thisWeekMs` vs `lastWeekMs` vs `thisMonthMs` + a ▲/▼ from `direction`, faster=green-down); **time-to-completed** (`m.timeToCompletedMedianMs` + `m.completedBuckets`); **reopen rate** (`data.reopen[win]`); **by-rep** (`m.byRep`).
  - Format ms→human ("12 min", "3.4 hr", "2.1 d") and null→"—". If `data.truncated`, a small "based on the most recent N items" note.
  - Tokens `var(--op-*)`/`var(--brand-*)`; compact. No `Date.now()` in render (use `nowMs`).
- [ ] **Step 2:** tsc 0; `eslint src` 0.
- [ ] **Step 3: Commit** — `git add src/components/dashboard/inbox/ResponseAnalytics.tsx && git commit -m "feat(#58): ResponseAnalytics component (window toggle + buckets + trend + completed + reopen)"`

---

## Task 5: Wire the three surfaces

**Files:** `src/app/inbox/page.tsx`, `src/app/insights/page.tsx`, `src/app/page.tsx`

- [ ] **Step 1: Shared wiring** — in each page (all server components), compute the bundle once:
  ```ts
  import { listItemsForMetrics, getReopenCounts } from '@/lib/dashboard/inbox/store';
  import { computeResponseAnalytics } from '@/lib/dashboard/inbox/responseMetrics';
  import { ResponseAnalytics } from '@/components/dashboard/inbox/ResponseAnalytics';
  // ...
  const [metricsRes, reopen] = await Promise.all([listItemsForMetrics(), getReopenCounts(now)]);
  const analytics = metricsRes.ok ? computeResponseAnalytics(metricsRes.items, reopen, now, metricsRes.truncated) : null;
  // render: {analytics && <ResponseAnalytics data={analytics} nowMs={now.getTime()} />}
  ```
- [ ] **Step 2: `/inbox`** — replace the existing `<ResponseStats metrics={…} truncated={…} />` with the `<ResponseAnalytics …>` block above (drop the `ResponseStats` import + `computeResponseMetrics` if now unused; remove `ResponseStats.tsx` if nothing else imports it — grep first).
- [ ] **Step 3: `/insights`** — add a "Response time" section rendering `<ResponseAnalytics …>` after the revenue cards (inside the `OperatorShell`, guarded by `analytics`). Reuse the page's existing `now`.
- [ ] **Step 4: `/` (home)** — add a section rendering `<ResponseAnalytics …>` under the `Worklist`/`ServiceSections`. Compute the bundle in the page's `Promise.all` + the existing `now`.
- [ ] **Step 5:** `npx tsc --noEmit` 0; `npx eslint src` 0; `npx vitest run src/lib/dashboard` green.
- [ ] **Step 6: Commit** — `git add src/app/inbox/page.tsx src/app/insights/page.tsx src/app/page.tsx src/components/dashboard/inbox/ResponseStats.tsx && git commit -m "feat(#58): response analytics on inbox card + insights + home"`

---

## Final verification
- [ ] `npx tsc --noEmit` (0) · `npx eslint src` (0 errors) · `npx vitest run src/lib/dashboard` (all pass, incl. new bucket/trend/reopen/analytics tests).
- [ ] Adversarial review: bucket-boundary correctness, window-filter timestamp choice, trend week math, reopen-rate edge cases, empty/truncated handling, and that all three surfaces render the same component without a data-fetch in the client.
- [ ] Preview: the window toggle changes buckets/median/reopen; trend stays fixed; completed buckets populate; the component renders on `/inbox`, `/insights`, and `/`.

## Spec coverage self-check
- Buckets → Task 1. Time-to-completed → Task 1. Trend → Task 2. Reopen rate → Tasks 2,3. Windows (all/90/30) → Tasks 2,4. Reusable component → Task 4. Three surfaces → Task 5. All-time fetch + created_at → Task 3. No migration → confirmed.
