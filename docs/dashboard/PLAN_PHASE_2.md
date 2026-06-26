# Phase 2 Implementation Plan — Service type + per-service dashboard sections

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the holiday/permanent/event lens. Adds a `service_type` column to `quotes`, backfills existing rows to `'holiday'`, and renders three per-service sections on the dashboard (Holiday by-install-month vs goal · Permanent in-care · Event upcoming + revenue).

**Architecture:** A single nullable `service_type` text column (with a CHECK constraint enum-style) on `quotes`. Pure-function service metrics in `src/lib/dashboard/serviceMetrics.ts`. Three server components on the dashboard. The dashboard treats NULL as `'holiday'` so anything not categorized still classifies correctly. Installed-status uses `homeworks_signed_at` as a proxy until Phase 5 (clearly marked in the UI).

**Tech Stack:** Same as Phase 1.

**Branch:** `naldo/dashboard-service-type` (off fresh `master` AFTER Phase 1 merges).

## Pre-flight — prerequisites BEFORE Task 1

- [ ] **Phase 1 PR merged to master.** Don't start Phase 2 until it lands; otherwise this branch will diverge from the live dashboard work.
- [ ] **Naldo runs the migration in Supabase** (Task 2 step 2; you'll get the SQL there). Without the column, the dashboard reads will return `service_type: undefined` from Supabase and the per-service sections will silently render as if everything is `'holiday'` (the fallback). Apply the migration as soon as Task 2's SQL is ready.

---

## SUB-PHASE SPLIT (read this first)

Phase 2 is split because the builder-form change needs Jason's coordination and we don't want it blocking the dashboard work.

### Phase 2a (this plan, this branch, Naldo-only)
What Naldo ships now:
- Migration adding `service_type` to `quotes`.
- Dashboard reads + classifies + displays per-service sections.
- All existing quotes show as Holiday (backfilled).

### Phase 2b (separate PR, needs Jason)
What's deferred to a follow-up PR:
- `src/lib/quotes.ts` (shared data layer) accepts `serviceType` on `saveQuote`/`updateQuote`.
- `/quote/new` + `/quote/[id]` builder forms get a service-type radio (default Holiday).
- That PR is Jason's lane primarily; Naldo proposes it OR Jason ships it directly.

**Until 2b ships, you can categorize quotes as permanent/event only via:**
- Direct SQL in Supabase (`UPDATE quotes SET service_type='permanent' WHERE id = '…';`).
- Or wait for Jason's builder-form change.

The Phase 2a dashboard sections will show Permanent/Event as zero until that categorization happens — that's expected.

---

## File map

**Create:**
- `migrations/2026-06-24-quotes-service-type.sql` — the column + backfill
- `src/lib/dashboard/serviceMetrics.ts` — pure functions
- `src/lib/dashboard/serviceMetrics.test.ts` — Vitest tests
- `src/components/dashboard/ServiceSections.tsx` — wrapper that lays out the three sections
- `src/components/dashboard/HolidaySection.tsx` — by-install-month + season goal progress
- `src/components/dashboard/PermanentSection.tsx` — active + in-care counts
- `src/components/dashboard/EventSection.tsx` — upcoming + booked + revenue

**Modify (Naldo's area only):**
- `src/lib/dashboard/types.ts` — add `ServiceType` + extend `DashboardQuote`
- `src/lib/dashboard/config.ts` — add `holidaySeasonGoalHomes`
- `src/lib/dashboard/queries.ts` — select the new column
- `src/app/page.tsx` — render `<ServiceSections>` under the worklist

**NOT modified in 2a (saved for 2b):**
- `src/lib/quotes.ts` — keep as-is; the builder-form change in 2b extends it.
- `src/app/quote/new/page.tsx`, `src/app/quote/[id]/page.tsx` — Jason's area; 2b.
- `FULL-SCHEMA.sql` — yes, the migration should be folded in per `CONVENTIONS.md` §6 ("a new schema change still goes in a new dated migration **and** should be folded into `FULL-SCHEMA.sql`"). Naldo to confirm whether 2a does this or 2b folds it together with quotes.ts changes. Default: **2a folds it** so FULL-SCHEMA stays current.

---

## Task 1: Branch off fresh master (post Phase 1 merge)

**Files:** none (git only).

- [ ] **Step 1: Confirm Phase 1 is merged**

```bash
git checkout master && git pull origin master
git log --oneline -5
```

Expected: the top commits include the Phase 1 PR merge (commit message mentioning `Dashboard Phase 1` or the squash-merge title from GitHub).

If the merge isn't there, **STOP** and wait for it. Phase 2 depends on Phase 1's `src/lib/dashboard/*` and `src/components/dashboard/*`.

- [ ] **Step 2: Create the branch**

```bash
git checkout -b naldo/dashboard-service-type
```

- [ ] **Step 3: Verify gates baseline pass**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: tsc clean · lint 0 errors (2 baseline warnings ok) · all tests pass (288 baseline after Phase 1).

---

## Task 2: Migration — `quotes.service_type`

Add a text column with a CHECK constraint (preferred over a PG enum — easier to extend later). Backfill existing rows to `'holiday'`. Idempotent per `CONVENTIONS.md` §6.

**Files:**
- Create: `migrations/2026-06-24-quotes-service-type.sql`
- Modify: `FULL-SCHEMA.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/2026-06-24-quotes-service-type.sql`:

```sql
-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `service_type` to quotes (#58 Phase 2a)
-- ─────────────────────────────────────────────────────────────────────────
-- Adds a categorization column so the dashboard can break results down by
-- Holiday / Permanent / Event service line (per docs/dashboard/VISION.md §4).
--
-- - text + CHECK rather than a true PG enum: extending an enum requires
--   ALTER TYPE which is annoying to roll back; text + CHECK lets us add
--   a new value with a simple ALTER and a new constraint.
-- - Nullable. The app reads NULL as 'holiday' (the legacy default) so
--   pre-existing rows don't need a backfill to render correctly — but
--   we backfill explicitly below anyway, so the data is canonical.
-- - Idempotent: ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS
--   before re-adding, per CONVENTIONS.md §6.

-- 1. Add the column (idempotent).
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS service_type text;

-- 2. (Re-)add the CHECK constraint. Drop first so re-running this file
--    after editing the value set doesn't error.
ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_service_type_check;
ALTER TABLE quotes
  ADD CONSTRAINT quotes_service_type_check
  CHECK (service_type IS NULL OR service_type IN ('holiday', 'permanent', 'event'));

-- 3. Backfill existing rows (only ones that are still NULL — idempotent).
UPDATE quotes
  SET service_type = 'holiday'
  WHERE service_type IS NULL;

-- 4. Index for the dashboard per-service grouping.
CREATE INDEX IF NOT EXISTS quotes_service_type_idx ON quotes (service_type);
```

- [ ] **Step 2: Apply the migration in Supabase (Naldo, manual)**

Per `CONVENTIONS.md` §6: there is no automated runner — copy/paste into the **Supabase SQL Editor**.

1. Open the Supabase project dashboard.
2. SQL Editor → New Query.
3. Paste the SQL from `migrations/2026-06-24-quotes-service-type.sql`.
4. Click **Run**.
5. Verify: in the SQL Editor, run `SELECT COUNT(*), service_type FROM quotes GROUP BY service_type;`. Expected: one row, `service_type='holiday'`, count = total existing quotes.

- [ ] **Step 3: Fold the migration into `FULL-SCHEMA.sql`**

Open `FULL-SCHEMA.sql`. Find the `CREATE TABLE quotes (...)` block. After the existing columns, add the same `service_type` definition. After the table block, add the CHECK constraint and the index. The file is consolidated + re-runnable — keep it that way.

Concrete edits (find the existing analogous sections — there are similar `ADD COLUMN IF NOT EXISTS` patterns from earlier migrations). Insert a new section labeled `-- service_type (added 2026-06-24, P2a)` adjacent to the other dated additions.

- [ ] **Step 4: Verify tsc + commit (NO test run needed; SQL only)**

```bash
npx tsc --noEmit
git add migrations/2026-06-24-quotes-service-type.sql FULL-SCHEMA.sql
git commit -m "dashboard: add quotes.service_type (#58 Phase 2a migration)"
```

---

## Task 3: Extend types + config

Add `ServiceType` and extend `DashboardQuote` with the column. Add the season goal to config.

**Files:**
- Modify: `src/lib/dashboard/types.ts`
- Modify: `src/lib/dashboard/config.ts`

- [ ] **Step 1: Extend types.ts**

In `src/lib/dashboard/types.ts`, replace the file with:

```ts
// Shared types for the dashboard. Kept in one place so metrics, worklist,
// queries, and components all agree on the shape of a dashboard quote row.

/** Service line a quote belongs to (per docs/dashboard/VISION.md §4). */
export type ServiceType = 'holiday' | 'permanent' | 'event';

/** All known service types in canonical display order. */
export const SERVICE_TYPES: readonly ServiceType[] = ['holiday', 'permanent', 'event'] as const;

/** A `quotes` row trimmed to the columns the dashboard actually reads. */
export type DashboardQuote = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  total: number | null;
  created_at: string;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  homeworks_sent_at: string | null;
  homeworks_signed_at: string | null;
  highlevel_contact_id: string | null;
  /** Holiday/permanent/event. NULL on legacy rows; treat NULL as 'holiday'. */
  service_type: ServiceType | null;
};

/** The 5 KPIs shown in the header strip. */
export type Kpis = {
  bookedRevenue: number;
  bookedRevenueRecent: number;
  activeQuotes: number;
  activeCustomers: number;
  avgTurnaroundDays: number | null;
  conversionRate: number | null;
};

/** Kinds of worklist rows. Phase 1 ships two; more added in later phases. */
export type WorklistKind =
  | 'draft-stale'
  | 'sent-no-reply';

export type WorklistItem = {
  kind: WorklistKind;
  quoteId: string;
  title: string;
  subtitle: string;
  ageDays: number;
  href: string;
};

/** Holiday section: bookings/installs by install-month bucket. */
export type HolidayBreakdown = {
  /** Total approved holiday quotes (lifetime). */
  bookedTotal: number;
  /** Total holiday quotes whose home.works signature is recorded (proxy for "installed"). */
  installedTotal: number;
  /** Bookings + installed per install-month for the current season (Sep–Feb window). */
  byMonth: ReadonlyArray<{
    /** Month label, e.g. "Sep 2026". */
    label: string;
    /** YYYY-MM key for stable sorting. */
    key: string;
    booked: number;
    installed: number;
  }>;
  /** Season goal (configurable) and current count toward it. */
  goal: { booked: number; goal: number };
};

/** Permanent section: in-care recurring base. */
export type PermanentSummary = {
  /** All approved permanent quotes (treated as the recurring base — Permanent never archives). */
  inCare: number;
  /** Permanent quotes sent but not yet approved (still in the funnel). */
  pending: number;
  /** Lifetime revenue from approved permanent quotes. */
  bookedRevenue: number;
};

/** Event section: simple funnel + revenue. */
export type EventSummary = {
  /** Approved event quotes. */
  booked: number;
  /** Sent + not-yet-approved event quotes. */
  pending: number;
  /** Lifetime approved event revenue. */
  bookedRevenue: number;
};
```

- [ ] **Step 2: Extend config.ts**

In `src/lib/dashboard/config.ts`, replace the file with:

```ts
// Tunable thresholds for the dashboard. One place to adjust without
// hunting through metrics / worklist code. Times are in days unless noted.

export const DASHBOARD_CONFIG = {
  /** A quote is "active" if sent within this many days and not yet approved. */
  activeQuoteWindowDays: 60,
  /** Booked-recent KPI window. */
  recentlyBookedWindowDays: 30,
  /** Drafted-not-sent surfaces in worklist after this many days idle. */
  draftStaleDays: 1,
  /** Sent-no-reply surfaces in worklist after this many days idle. */
  sentNoReplyStaleDays: 3,
  /** Cap how many worklist rows we render (newest-first). */
  worklistMaxRows: 25,
  /** Holiday season goal — total bookings target. The current value of 50 is
   *  the "47/50 homes" example from the vision doc. Edit here when Naldo
   *  raises/lowers the target. */
  holidaySeasonGoalHomes: 50,
} as const;
```

- [ ] **Step 3: Verify tsc**

```bash
npx tsc --noEmit
```

Expected: errors in `queries.ts` (the DashboardQuote shape changed — fixed in Task 4) and possibly in `metrics.ts`/`worklist.ts` if they reference fields by destructure. If there are MORE errors than that, stop and investigate.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dashboard/types.ts src/lib/dashboard/config.ts
git commit -m "dashboard: extend types (ServiceType + service metrics) + season goal"
```

---

## Task 4: Update `queries.ts` to select `service_type`

**Files:**
- Modify: `src/lib/dashboard/queries.ts`

- [ ] **Step 1: Add `service_type` to the SELECT list**

In `src/lib/dashboard/queries.ts`, change the `.select(...)` string to include `service_type`. Replace the file with:

```ts
import { getSupabaseClient, getSupabaseServiceClient } from '@/lib/supabase';
import type { DashboardQuote } from './types';

/**
 * Fetch quotes for the dashboard: id, customer info, total, the full
 * lifecycle timestamp chain, and service_type. Service client preferred
 * (same pattern as `listQuotes` in `lib/quotes.ts`) so admin-side reads
 * never trip RLS.
 *
 * Server-only. Do NOT call from a client component.
 */
export async function listQuotesForDashboard(limit = 500): Promise<DashboardQuote[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_email, customer_phone, total, ' +
        'created_at, quote_sent_at, customer_approved_at, ' +
        'homeworks_sent_at, homeworks_signed_at, highlevel_contact_id, ' +
        'service_type',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listQuotesForDashboard error:', error);
    return [];
  }
  return (data ?? []) as unknown as DashboardQuote[];
}
```

- [ ] **Step 2: Verify tsc + commit**

```bash
npx tsc --noEmit && npm test
git add src/lib/dashboard/queries.ts
git commit -m "dashboard: select service_type in listQuotesForDashboard"
```

---

## Task 5: Service metrics (TDD — tests first)

Three pure functions: `computeHolidayBreakdown`, `computePermanentSummary`, `computeEventSummary`.

Service-type fallback rule everywhere: **`q.service_type ?? 'holiday'`** — legacy NULL rows are Holiday.

**Files:**
- Create: `src/lib/dashboard/serviceMetrics.test.ts`
- Create: `src/lib/dashboard/serviceMetrics.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/dashboard/serviceMetrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  computeHolidayBreakdown,
  computePermanentSummary,
  computeEventSummary,
  serviceTypeOf,
} from './serviceMetrics';
import type { DashboardQuote } from './types';
import { DASHBOARD_CONFIG } from './config';

const NOW = new Date('2026-12-15T12:00:00Z'); // mid-season for the holiday tests

function makeQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: crypto.randomUUID(),
    customer_name: 'Test',
    customer_email: null,
    customer_phone: null,
    total: 1000,
    created_at: '2026-09-01T12:00:00Z',
    quote_sent_at: null,
    customer_approved_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    service_type: null,
    ...over,
  };
}

describe('serviceTypeOf — fallback', () => {
  it('returns the literal when set', () => {
    expect(serviceTypeOf(makeQuote({ service_type: 'permanent' }))).toBe('permanent');
    expect(serviceTypeOf(makeQuote({ service_type: 'event' }))).toBe('event');
    expect(serviceTypeOf(makeQuote({ service_type: 'holiday' }))).toBe('holiday');
  });
  it('treats NULL as holiday (legacy default)', () => {
    expect(serviceTypeOf(makeQuote({ service_type: null }))).toBe('holiday');
  });
});

describe('computeHolidayBreakdown — totals', () => {
  it('counts only approved holiday quotes as booked', () => {
    const out = computeHolidayBreakdown(
      [
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-10T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-10-15T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: null }), // not booked
        makeQuote({ service_type: 'permanent', customer_approved_at: '2026-09-01T00:00:00Z' }), // wrong service
        makeQuote({ service_type: null, customer_approved_at: '2026-11-01T00:00:00Z' }),       // NULL → holiday
      ],
      NOW,
    );
    expect(out.bookedTotal).toBe(3);
  });

  it('counts only signed holiday quotes as installed (homeworks_signed_at proxy)', () => {
    const out = computeHolidayBreakdown(
      [
        makeQuote({
          service_type: 'holiday',
          customer_approved_at: '2026-09-10T00:00:00Z',
          homeworks_signed_at: '2026-10-01T00:00:00Z',
        }),
        makeQuote({
          service_type: 'holiday',
          customer_approved_at: '2026-09-10T00:00:00Z',
          homeworks_signed_at: null, // booked but not installed
        }),
      ],
      NOW,
    );
    expect(out.installedTotal).toBe(1);
  });

  it('groups booked + installed by install month (YYYY-MM key, label, stable order)', () => {
    const out = computeHolidayBreakdown(
      [
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-05T00:00:00Z', homeworks_signed_at: '2026-09-25T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-20T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-10-01T00:00:00Z', homeworks_signed_at: '2026-10-10T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-12-01T00:00:00Z' }),
      ],
      NOW,
    );
    const sepBucket = out.byMonth.find(b => b.key === '2026-09');
    const octBucket = out.byMonth.find(b => b.key === '2026-10');
    const decBucket = out.byMonth.find(b => b.key === '2026-12');
    expect(sepBucket).toEqual(expect.objectContaining({ booked: 2, installed: 1 }));
    expect(octBucket).toEqual(expect.objectContaining({ booked: 1, installed: 1 }));
    expect(decBucket).toEqual(expect.objectContaining({ booked: 1, installed: 0 }));
    // Stable chronological order
    const keys = out.byMonth.map(b => b.key);
    expect(keys).toEqual([...keys].sort());
  });

  it('goal mirrors config + total booked', () => {
    const out = computeHolidayBreakdown(
      [makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-10T00:00:00Z' })],
      NOW,
    );
    expect(out.goal.goal).toBe(DASHBOARD_CONFIG.holidaySeasonGoalHomes);
    expect(out.goal.booked).toBe(1);
  });
});

describe('computePermanentSummary', () => {
  it('inCare = count of approved permanent quotes; pending = sent-not-approved', () => {
    const out = computePermanentSummary(
      [
        makeQuote({ service_type: 'permanent', customer_approved_at: '2026-09-10T00:00:00Z', total: 13000 }),
        makeQuote({ service_type: 'permanent', customer_approved_at: '2026-10-10T00:00:00Z', total: 11000 }),
        makeQuote({ service_type: 'permanent', quote_sent_at: '2026-11-01T00:00:00Z' }),
        makeQuote({ service_type: 'holiday',   customer_approved_at: '2026-09-15T00:00:00Z' }), // wrong service
      ],
      NOW,
    );
    expect(out.inCare).toBe(2);
    expect(out.pending).toBe(1);
    expect(out.bookedRevenue).toBe(24000);
  });

  it('handles empty / no permanent quotes', () => {
    const out = computePermanentSummary([makeQuote({ service_type: 'holiday' })], NOW);
    expect(out).toEqual({ inCare: 0, pending: 0, bookedRevenue: 0 });
  });
});

describe('computeEventSummary', () => {
  it('booked / pending / revenue from event quotes only', () => {
    const out = computeEventSummary(
      [
        makeQuote({ service_type: 'event', customer_approved_at: '2026-10-01T00:00:00Z', total: 4800 }),
        makeQuote({ service_type: 'event', quote_sent_at: '2026-11-01T00:00:00Z' }),
        makeQuote({ service_type: 'event', quote_sent_at: '2026-11-01T00:00:00Z', customer_approved_at: '2026-11-05T00:00:00Z', total: 6000 }),
        makeQuote({ service_type: 'permanent', customer_approved_at: '2026-10-01T00:00:00Z' }),
      ],
      NOW,
    );
    expect(out.booked).toBe(2);
    expect(out.pending).toBe(1);
    expect(out.bookedRevenue).toBe(10800);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/lib/dashboard/serviceMetrics.test.ts
```

Expected: red — file `./serviceMetrics` not found.

- [ ] **Step 3: Implement serviceMetrics.ts**

Create `src/lib/dashboard/serviceMetrics.ts`:

```ts
import { DASHBOARD_CONFIG } from './config';
import type {
  DashboardQuote,
  EventSummary,
  HolidayBreakdown,
  PermanentSummary,
  ServiceType,
} from './types';

/** NULL service_type rows are Holiday (the legacy default). */
export function serviceTypeOf(q: DashboardQuote): ServiceType {
  return q.service_type ?? 'holiday';
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function monthKey(iso: string): string {
  // YYYY-MM (UTC) — stable string sort = chronological sort.
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthLabel(key: string): string {
  // key = 'YYYY-MM'; turn into 'Sep 2026'.
  const [y, m] = key.split('-');
  return `${MONTH_LABELS[Number(m) - 1]} ${y}`;
}

export function computeHolidayBreakdown(
  quotes: DashboardQuote[],
  _now: Date,
): HolidayBreakdown {
  let bookedTotal = 0;
  let installedTotal = 0;
  const buckets = new Map<string, { booked: number; installed: number }>();

  for (const q of quotes) {
    if (serviceTypeOf(q) !== 'holiday') continue;
    if (!q.customer_approved_at) continue;

    bookedTotal += 1;

    // Install-month bucket: prefer the install proxy (homeworks_signed_at)
    // for the month attribution if present; otherwise group by approval month
    // so the section shows the booking even before install is confirmed.
    const monthIso = q.homeworks_signed_at ?? q.customer_approved_at;
    const key = monthKey(monthIso);
    const bucket = buckets.get(key) ?? { booked: 0, installed: 0 };
    bucket.booked += 1;
    if (q.homeworks_signed_at) {
      bucket.installed += 1;
      installedTotal += 1;
    }
    buckets.set(key, bucket);
  }

  const byMonth = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({ key, label: monthLabel(key), booked: v.booked, installed: v.installed }));

  return {
    bookedTotal,
    installedTotal,
    byMonth,
    goal: { booked: bookedTotal, goal: DASHBOARD_CONFIG.holidaySeasonGoalHomes },
  };
}

export function computePermanentSummary(quotes: DashboardQuote[], _now: Date): PermanentSummary {
  let inCare = 0;
  let pending = 0;
  let bookedRevenue = 0;

  for (const q of quotes) {
    if (serviceTypeOf(q) !== 'permanent') continue;
    if (q.customer_approved_at) {
      inCare += 1;
      bookedRevenue += q.total ?? 0;
    } else if (q.quote_sent_at) {
      pending += 1;
    }
  }

  return { inCare, pending, bookedRevenue };
}

export function computeEventSummary(quotes: DashboardQuote[], _now: Date): EventSummary {
  let booked = 0;
  let pending = 0;
  let bookedRevenue = 0;

  for (const q of quotes) {
    if (serviceTypeOf(q) !== 'event') continue;
    if (q.customer_approved_at) {
      booked += 1;
      bookedRevenue += q.total ?? 0;
    } else if (q.quote_sent_at) {
      pending += 1;
    }
  }

  return { booked, pending, bookedRevenue };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/lib/dashboard/serviceMetrics.test.ts
```

Expected: green.

- [ ] **Step 5: Full gates + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/lib/dashboard/serviceMetrics.ts src/lib/dashboard/serviceMetrics.test.ts
git commit -m "dashboard: per-service metrics (TDD) — Holiday by-month, Permanent in-care, Event"
```

---

## Task 6: Per-service section components

Three sibling components + a wrapper. Render with the brand tokens (cream surface, evergreen text, gold for "installed" indicator, red used sparingly).

**Files:**
- Create: `src/components/dashboard/ServiceSections.tsx`
- Create: `src/components/dashboard/HolidaySection.tsx`
- Create: `src/components/dashboard/PermanentSection.tsx`
- Create: `src/components/dashboard/EventSection.tsx`

- [ ] **Step 1: HolidaySection**

Create `src/components/dashboard/HolidaySection.tsx`:

```tsx
import type { HolidayBreakdown } from '@/lib/dashboard/types';

export function HolidaySection({ data }: { data: HolidayBreakdown }) {
  const pct = data.goal.goal > 0
    ? Math.min(100, Math.round((data.goal.booked / data.goal.goal) * 100))
    : 0;

  return (
    <section
      aria-label="Holiday — season at a glance"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Holiday</h3>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
          Season goal {data.goal.booked}/{data.goal.goal} homes
        </span>
      </div>

      {/* Goal bar */}
      <div
        className="h-2 rounded-full mb-4 overflow-hidden"
        style={{ background: 'var(--op-bg-hover)' }}
        aria-label={`${pct}% of season goal`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: 'var(--brand-evergreen)' }}
        />
      </div>

      {/* By-install-month */}
      {data.byMonth.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
          No bookings yet this season.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {data.byMonth.map(m => {
            const denom = Math.max(m.booked, 1);
            const installPct = Math.round((m.installed / denom) * 100);
            return (
              <li key={m.key} className="text-sm flex items-center gap-3">
                <span className="w-20 shrink-0 tabular-nums" style={{ color: 'var(--op-text-2)' }}>
                  {m.label}
                </span>
                <span className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--op-bg-hover)' }}>
                  <span
                    className="block h-full"
                    style={{ width: `${installPct}%`, background: 'var(--brand-gold)' }}
                    aria-hidden
                  />
                </span>
                <span className="w-24 text-right tabular-nums" style={{ color: 'var(--op-text-dim)' }}>
                  {m.installed} of {m.booked}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-[10px]" style={{ color: 'var(--op-text-dim)' }}>
        Installed = home.works signature received (proxy until Phase 5).
      </p>
    </section>
  );
}
```

- [ ] **Step 2: PermanentSection**

Create `src/components/dashboard/PermanentSection.tsx`:

```tsx
import type { PermanentSummary } from '@/lib/dashboard/types';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function PermanentSection({ data }: { data: PermanentSummary }) {
  return (
    <section
      aria-label="Permanent — ongoing care"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Permanent</h3>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>Ongoing care</span>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>In care</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {data.inCare}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Pending</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {data.pending}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Booked</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {fmtMoney(data.bookedRevenue)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
```

- [ ] **Step 3: EventSection**

Create `src/components/dashboard/EventSection.tsx`:

```tsx
import type { EventSummary } from '@/lib/dashboard/types';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function EventSection({ data }: { data: EventSummary }) {
  return (
    <section
      aria-label="Event — date-driven jobs"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Event</h3>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>Date-driven</span>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Booked</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {data.booked}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Pending</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {data.pending}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Revenue</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {fmtMoney(data.bookedRevenue)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
```

- [ ] **Step 4: ServiceSections wrapper**

Create `src/components/dashboard/ServiceSections.tsx`:

```tsx
import type { EventSummary, HolidayBreakdown, PermanentSummary } from '@/lib/dashboard/types';
import { HolidaySection } from './HolidaySection';
import { PermanentSection } from './PermanentSection';
import { EventSection } from './EventSection';

export function ServiceSections({
  holiday,
  permanent,
  event,
}: {
  holiday: HolidayBreakdown;
  permanent: PermanentSummary;
  event: EventSummary;
}) {
  return (
    <section aria-label="By service line" className="mb-8">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        By service line
      </h2>
      {/* Holiday takes the full row (richer content); Permanent + Event side-by-side. */}
      <div className="grid grid-cols-1 gap-3 mb-3">
        <HolidaySection data={holiday} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PermanentSection data={permanent} />
        <EventSection data={event} />
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Verify tsc + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/components/dashboard/HolidaySection.tsx \
        src/components/dashboard/PermanentSection.tsx \
        src/components/dashboard/EventSection.tsx \
        src/components/dashboard/ServiceSections.tsx
git commit -m "dashboard: per-service sections — Holiday + Permanent + Event"
```

---

## Task 7: Wire ServiceSections into `page.tsx`

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Wire it up**

Replace `src/app/page.tsx` with:

```tsx
import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { computeKpis } from '@/lib/dashboard/metrics';
import { computeWorklist } from '@/lib/dashboard/worklist';
import {
  computeHolidayBreakdown,
  computePermanentSummary,
  computeEventSummary,
} from '@/lib/dashboard/serviceMetrics';
import { OperatorNav } from '@/components/dashboard/OperatorNav';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { Worklist } from '@/components/dashboard/Worklist';
import { ServiceSections } from '@/components/dashboard/ServiceSections';

// Always render fresh — the dashboard reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const quotes = await listQuotesForDashboard(500);
  const now = new Date();
  const kpis = computeKpis(quotes, now);
  const worklist = computeWorklist(quotes, now);
  const holiday = computeHolidayBreakdown(quotes, now);
  const permanent = computePermanentSummary(quotes, now);
  const event = computeEventSummary(quotes, now);

  return (
    <>
      <OperatorNav active="home" />
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
        <DashboardHeader />
        <KpiStrip kpis={kpis} />
        <Worklist items={worklist} />
        <ServiceSections holiday={holiday} permanent={permanent} event={event} />
      </main>
    </>
  );
}
```

- [ ] **Step 2: Verify the dashboard renders**

Load `http://localhost:3000/`. Expected:
- All of Phase 1's content still there.
- A new "**By service line**" section under the worklist.
- **Holiday card** showing the season-goal bar + by-install-month buckets (all backfilled quotes count as Holiday).
- **Permanent + Event** cards side-by-side — both showing zeros until quotes get categorized.
- Footnote: "Installed = home.works signature received (proxy until Phase 5)."

- [ ] **Step 3: Verify portal still works**

`curl http://localhost:3000/portal/<any-quote-id>` → HTTP 200, still dark snowglobe.

- [ ] **Step 4: Run gates + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/app/page.tsx
git commit -m "dashboard: render per-service sections (#58 Phase 2a)"
```

---

## Task 8: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin naldo/dashboard-service-type
```

- [ ] **Step 2: Open the PR** at the URL git prints. Suggested title:

`Dashboard Phase 2a — service_type + per-service sections (#58)`

Suggested body:

```markdown
Phase 2a of #58 — adds the service-line lens to the dashboard.

## What's in
- `quotes.service_type` text column with CHECK constraint (`'holiday' | 'permanent' | 'event'`), backfilled to `'holiday'`. Index added.
- FULL-SCHEMA.sql updated to match.
- `DashboardQuote.service_type` + `ServiceType` exported.
- `serviceMetrics.ts` (pure): Holiday by-install-month + season goal · Permanent in-care · Event funnel.
- 3 new server components + `ServiceSections` wrapper.
- `page.tsx` renders the new section under the worklist.

## What's out (Phase 2b — Jason coordination needed)
- Builder form (`/quote/new`, `/quote/[id]`) does NOT yet have a service-type radio. New quotes still save with NULL service_type (treated as `'holiday'`). Until 2b ships, Permanent/Event quotes can be set via direct SQL: `UPDATE quotes SET service_type='permanent' WHERE id='…';`.

## Test plan
- [x] Migration applied to Supabase; `SELECT … GROUP BY service_type` shows backfill.
- [x] tsc clean.
- [x] lint 0 errors.
- [x] All tests pass (288 + N new = ?).
- [x] `/` shows the new section with Holiday populated.
- [x] `/portal/[id]` still dark snowglobe.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-review — verify against PLAN.md §6 Phase 2

- ✅ `quotes.service_type` migration (Task 2).
- ⚠️ Builder form change — **deferred to Phase 2b** (called out at top of this file). NOT in 2a.
- ✅ Dashboard per-service sections (Tasks 5–7).
- ✅ Holiday: by-install-month + booked/installed + season goal (`homeworks_signed_at` proxy clearly marked).
- ✅ Permanent: in-care + pending + revenue.
- ✅ Event: booked + pending + revenue.
- ✅ Season goal in `DASHBOARD_CONFIG`.

## Phase 2b — separate plan, when Jason's coordinated

When ready, the 2b PR is:
- `src/lib/quotes.ts`: extend `saveQuote` + `updateQuote` + `getQuoteRaw` + `QuoteListItem` to handle `serviceType` (column maps to `service_type`).
- `src/components/quote/QuoteBuilder.tsx`: add a 3-radio control for the service type, default Holiday.
- `src/app/quote/new/page.tsx` + `src/app/quote/[id]/page.tsx`: pass it through to save/update.
- Tests: round-trip the value through save → list → edit → update.

Branch name: `naldo/dashboard-service-type-builder-form` (or Jason's call if he ships it).
