# Phase 1 Implementation Plan — Dashboard Shell + Native KPIs + Worklist

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the boilerplate `/` page with a real operator dashboard — KPI strip + "Needs your attention" worklist + nav, all from native `quotes` data. Zero new integrations, zero schema changes.

**Architecture:** Server-rendered React page (Next 16 App Router server component). Pure functions in `src/lib/dashboard/` compute KPIs and worklist rows from a thin Supabase query. Components are server-rendered (no client state needed in Phase 1). Brand color values lift out of `portal-dark.css` into `globals.css` as `--brand-*` vars so the portal and the operator surface share one source of truth.

**Tech Stack:** Next 16.2.6 (Turbopack), React 19, Tailwind v4, TypeScript 5 strict, Vitest, Supabase Postgres (`quotes` table), `lucide-react` icons (already a dependency).

**Branch:** `naldo/dashboard-shell` (off fresh `master`).

**Plan deviation note (from the parent `PLAN.md` §6 Phase 1):** dropped the dedicated `/api/dashboard` GET route in favor of direct server-component fetching. YAGNI — page.tsx imports the pure functions directly. Add the API later if a client-side refresh button is wanted. The pure-function modules stay testable as planned.

---

## File map (lock decomposition before tasks)

**Create (all in Naldo's owned area — no claim needed):**
- `src/lib/dashboard/types.ts` — shared types: `DashboardQuote`, `Kpis`, `WorklistItem`, `WorklistKind`
- `src/lib/dashboard/config.ts` — tunable thresholds (window days, stale days)
- `src/lib/dashboard/queries.ts` — `listQuotesForDashboard()`: Supabase query returning exactly the columns we need
- `src/lib/dashboard/metrics.ts` — `computeKpis(quotes, now)`: pure
- `src/lib/dashboard/metrics.test.ts` — Vitest tests
- `src/lib/dashboard/worklist.ts` — `computeWorklist(quotes, now)`: pure
- `src/lib/dashboard/worklist.test.ts` — Vitest tests
- `src/components/dashboard/OperatorNav.tsx` — top nav (Home · Quotes · Builder · Training · Settings)
- `src/components/dashboard/DashboardHeader.tsx` — title + "New quote" CTA
- `src/components/dashboard/KpiStrip.tsx` — the 5 KPIs row
- `src/components/dashboard/KpiCard.tsx` — one card
- `src/components/dashboard/Worklist.tsx` — the worklist section
- `src/components/dashboard/WorklistRow.tsx` — one row

**Modify (SHARED — claim with Jason BEFORE Task 2):**
- `src/app/globals.css` — add `--brand-*` tokens + `.operator-surface` + `:root` operator tokens
- `src/app/layout.tsx` — fix `<title>` / `<meta>`, add `operator-surface` class to body

**Modify (Naldo's area — no claim needed):**
- `src/app/page.tsx` — replace boilerplate with the dashboard server component

---

## Pre-work checklist (Naldo, manual)

These two steps are Naldo's, not Claude's. Do BEFORE Task 1.

- [ ] **Heads-up to Jason** (Slack/text/wherever): "I'm starting #58 dashboard work. Will be editing `globals.css` to lift the portal brand tokens into `:root` (no portal behavior change) and `layout.tsx` to fix the `<title>` and add an `operator-surface` body class (portal has its own layout so it won't see it). Branch: `naldo/dashboard-shell`. Heads up — let me know if you've got conflicting edits in flight."
- [ ] **Wait for Jason's ack** before starting Task 1.

---

## Task 1: Branch off fresh master

**Files:** none (git only).

- [ ] **Step 1: Pull latest master**

```bash
git checkout master && git pull origin master
```

Expected: `Already up to date.` or fast-forward; clean tree.

- [ ] **Step 2: Create the branch**

```bash
git checkout -b naldo/dashboard-shell
```

Expected: `Switched to a new branch 'naldo/dashboard-shell'`.

- [ ] **Step 3: Verify gates baseline pass**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: tsc clean · lint 0 errors (2 baseline warnings ok) · all tests pass. **If any gate fails on master, STOP and escalate** — that's not a dashboard problem.

---

## Task 2: Brand tokens in globals.css

Pull the four brand color values out of `portal-dark.css` (where they sit scoped under `.portal-dark-root`) and add them as shared `--brand-*` variables at `:root` in `globals.css`, then add the operator-surface tokens on top.

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Replace the file with the new tokens block**

Replace the entire current contents of `src/app/globals.css` with:

```css
@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #171717;

  /* ─── Brand color values ─────────────────────────────────────────────
   * Lifted from portal-dark.css so the operator UI and the customer
   * portal share one source of truth. The portal's .portal-dark-root
   * class still defines its own --yd-* alias variables (which keep
   * those values) for backwards compat with the rest of portal-dark.css.
   * Do not edit a value here without also auditing the portal. */
  --brand-cream:        #F4ECD8;
  --brand-cream-2:      #E0D7C1;
  --brand-cream-dim:    #A89F87;
  --brand-evergreen:    #0B140F;
  --brand-evergreen-2:  #18221C;
  --brand-evergreen-3:  #2E3D34;
  --brand-gold:         #E8B862;
  --brand-gold-bright:  #F5CC7A;
  --brand-gold-deep:    #7A5E20;
  --brand-red:          #C8313D;
  --brand-red-bright:   #D8434F;
  --brand-red-deep:     #8F1D26;

  /* ─── Operator surface tokens (light theme using the brand) ──────────
   * Applied via the .operator-surface class on body. The customer portal
   * has its own .portal-dark-root scope (inside src/app/portal/layout.tsx)
   * which overrides these on portal routes — so adding the class to the
   * root body is safe and won't bleed into the portal. */
  --op-bg:            #FAF6EC;   /* off-cream, page background */
  --op-bg-raised:     #FFFFFF;   /* card backgrounds */
  --op-bg-hover:      var(--brand-cream);
  --op-border:        rgba(11, 20, 15, 0.10); /* evergreen 10% */
  --op-border-mid:    rgba(11, 20, 15, 0.18);
  --op-text:          var(--brand-evergreen);
  --op-text-2:        var(--brand-evergreen-3);
  --op-text-dim:      #5B6B5F;
  --op-primary:       var(--brand-evergreen);
  --op-accent:        var(--brand-gold);
  --op-danger:        var(--brand-red);

  /* This is a light-themed app: the operator/admin UI uses white cards and
     light backgrounds, and the customer portal skins set their own colors.
     Pin the color scheme to light so the OS's dark mode can't flip default
     text to near-white on our white surfaces (which made text unreadable). */
  color-scheme: light;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: Arial, Helvetica, sans-serif;
}

/* ─── Operator surface base ──────────────────────────────────────────────
 * Applied to <body> in src/app/layout.tsx so every non-portal route gets
 * the cream/evergreen brand surface. The portal's own layout wraps
 * children in .portal-dark-root which overrides bg + text. */
body.operator-surface {
  background: var(--op-bg);
  color: var(--op-text);
}
```

- [ ] **Step 2: Verify the dev server still serves the portal correctly**

Start the dev server in a separate terminal (or check the already-running one):

```bash
unset ANTHROPIC_API_KEY; unset ANTHROPIC_BASE_URL; npm.cmd run dev
```

Then load **any existing portal URL** (e.g. `http://localhost:3000/portal/<any-quote-id>` from `/admin/quotes`). Expected: portal looks identical to before — dark theme, gold accents, no visible change. The `.portal-dark-root` scope wins inside the portal route.

- [ ] **Step 3: Run gates + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/app/globals.css
git commit -m "dashboard: lift brand tokens to :root + add operator surface vars"
```

Expected: all gates pass; commit lands on `naldo/dashboard-shell`.

---

## Task 3: Layout — title fix + operator surface class

Fix the `<title>` / `<meta description>` (still says "Create Next App") and add the `operator-surface` class to `<body>`. Portal route segment has its own layout that wraps in `.portal-dark-root` so this is non-destructive.

**Files:**
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Replace the file**

Replace `src/app/layout.tsx` with:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Yule Love Lights",
  description: "Operator console for Yule Love Lights — quoting, customer portal, and dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="operator-surface min-h-full flex flex-col">{children}</body>
    </html>
  );
}
```

- [ ] **Step 2: Verify the portal STILL looks right**

Reload a `/portal/<quote-id>` page. Expected: still dark/snowglobe theme, no cream bleed. (The portal's own `layout.tsx` wraps children in `<div class="portal-dark-root portal-snowglobe-root">` which sets its own `background` + `color`.)

- [ ] **Step 3: Verify the title in the browser tab**

The browser tab title on the boilerplate `/` page should now say **"Yule Love Lights"** instead of "Create Next App". (We'll replace the page body in Task 9.)

- [ ] **Step 4: Run gates + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/app/layout.tsx
git commit -m "dashboard: fix tab title + add operator-surface body class"
```

---

## Task 4: Dashboard types + config

Define the shared types and the tunable thresholds in one place so metrics + worklist + components all agree.

**Files:**
- Create: `src/lib/dashboard/types.ts`
- Create: `src/lib/dashboard/config.ts`

- [ ] **Step 1: Write types.ts**

Create `src/lib/dashboard/types.ts`:

```ts
// Shared types for the dashboard. Kept in one place so metrics, worklist,
// queries, and components all agree on the shape of a dashboard quote row.

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
};

/** The 5 KPIs shown in the header strip. */
export type Kpis = {
  /** Lifetime booked revenue: sum of `total` where customer_approved_at is set. */
  bookedRevenue: number;
  /** Revenue booked in the trailing N days (config.recentlyBookedWindowDays). */
  bookedRevenueRecent: number;
  /** Count of quotes that are sent but not yet approved AND sent within the active window. */
  activeQuotes: number;
  /** Distinct customers (by HL contact id, falling back to email/phone/name) with an active quote. */
  activeCustomers: number;
  /** Average days between created_at and quote_sent_at across all sent quotes; null if no sent quotes. */
  avgTurnaroundDays: number | null;
  /** approved / sent ratio across all-time, as a 0–1 number; null if no sent quotes. */
  conversionRate: number | null;
};

/** Kinds of worklist rows. Phase 1 ships two; more added in later phases. */
export type WorklistKind =
  | 'draft-stale'      // quote created, never sent, > config.draftStaleDays
  | 'sent-no-reply';   // quote sent, not yet approved, > config.sentNoReplyStaleDays

export type WorklistItem = {
  kind: WorklistKind;
  quoteId: string;
  title: string;        // e.g. "Smith family — 1234 Main St"
  subtitle: string;     // e.g. "Drafted 3 days ago"
  ageDays: number;
  href: string;         // deep link that resolves the row
};
```

- [ ] **Step 2: Write config.ts**

Create `src/lib/dashboard/config.ts`:

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
} as const;
```

- [ ] **Step 3: Verify tsc + commit**

```bash
npx tsc --noEmit
git add src/lib/dashboard/types.ts src/lib/dashboard/config.ts
git commit -m "dashboard: shared types + config thresholds"
```

---

## Task 5: KPI metrics (TDD — tests first)

Pure function `computeKpis(quotes, now): Kpis`. No I/O. `now` is injected so tests are deterministic.

**Files:**
- Create: `src/lib/dashboard/metrics.test.ts`
- Create: `src/lib/dashboard/metrics.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/dashboard/metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeKpis } from './metrics';
import type { DashboardQuote } from './types';
import { DASHBOARD_CONFIG } from './config';

// Fixed "now" for deterministic time math.
const NOW = new Date('2026-06-24T12:00:00Z');

function makeQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: crypto.randomUUID(),
    customer_name: 'Test',
    customer_email: null,
    customer_phone: null,
    total: 1000,
    created_at: '2026-06-20T12:00:00Z',
    quote_sent_at: null,
    customer_approved_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    ...over,
  };
}

describe('computeKpis — empty', () => {
  it('returns all zeros / nulls on an empty list', () => {
    const k = computeKpis([], NOW);
    expect(k.bookedRevenue).toBe(0);
    expect(k.bookedRevenueRecent).toBe(0);
    expect(k.activeQuotes).toBe(0);
    expect(k.activeCustomers).toBe(0);
    expect(k.avgTurnaroundDays).toBeNull();
    expect(k.conversionRate).toBeNull();
  });
});

describe('computeKpis — booked revenue', () => {
  it('sums total only for approved quotes', () => {
    const k = computeKpis(
      [
        makeQuote({ total: 1500, customer_approved_at: '2026-06-01T00:00:00Z' }),
        makeQuote({ total: 2000, customer_approved_at: '2025-01-01T00:00:00Z' }),
        makeQuote({ total: 9999, customer_approved_at: null }), // not approved, ignored
      ],
      NOW,
    );
    expect(k.bookedRevenue).toBe(3500);
  });

  it('treats null totals as 0', () => {
    const k = computeKpis(
      [makeQuote({ total: null, customer_approved_at: '2026-06-01T00:00:00Z' })],
      NOW,
    );
    expect(k.bookedRevenue).toBe(0);
  });

  it('booked-recent uses only approvals within the configured window', () => {
    const withinWindow = new Date(NOW.getTime() - 10 * 86400_000).toISOString();
    const outsideWindow = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.recentlyBookedWindowDays + 5) * 86400_000,
    ).toISOString();
    const k = computeKpis(
      [
        makeQuote({ total: 800, customer_approved_at: withinWindow }),
        makeQuote({ total: 1200, customer_approved_at: outsideWindow }),
      ],
      NOW,
    );
    expect(k.bookedRevenueRecent).toBe(800);
    expect(k.bookedRevenue).toBe(2000); // lifetime ignores window
  });
});

describe('computeKpis — active quotes / customers', () => {
  it('counts only sent-but-not-approved quotes within the active window as active', () => {
    const recentSent = new Date(NOW.getTime() - 5 * 86400_000).toISOString();
    const oldSent = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.activeQuoteWindowDays + 5) * 86400_000,
    ).toISOString();
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: recentSent }),                                          // active
        makeQuote({ quote_sent_at: recentSent, customer_approved_at: '2026-06-20T00:00:00Z' }), // approved → not active
        makeQuote({ quote_sent_at: oldSent }),                                             // outside window → not active
        makeQuote({ quote_sent_at: null }),                                                // never sent → not active
      ],
      NOW,
    );
    expect(k.activeQuotes).toBe(1);
  });

  it('dedupes active customers by highlevel_contact_id, then email, then phone, then name', () => {
    const recentSent = new Date(NOW.getTime() - 1 * 86400_000).toISOString();
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: recentSent, highlevel_contact_id: 'hl1' }),
        makeQuote({ quote_sent_at: recentSent, highlevel_contact_id: 'hl1' }), // same contact → 1
        makeQuote({ quote_sent_at: recentSent, customer_email: 'a@x.com' }),
        makeQuote({ quote_sent_at: recentSent, customer_email: 'a@x.com' }),    // same email → 1
        makeQuote({ quote_sent_at: recentSent, customer_phone: '555-0100' }),
        makeQuote({ quote_sent_at: recentSent, customer_name: 'Solo' }),
      ],
      NOW,
    );
    expect(k.activeCustomers).toBe(4); // hl1, a@x.com, 555-0100, Solo
  });
});

describe('computeKpis — turnaround + conversion', () => {
  it('avg turnaround averages (sent - created) in days across sent quotes', () => {
    const k = computeKpis(
      [
        // 2 days
        makeQuote({ created_at: '2026-06-01T00:00:00Z', quote_sent_at: '2026-06-03T00:00:00Z' }),
        // 4 days
        makeQuote({ created_at: '2026-06-10T00:00:00Z', quote_sent_at: '2026-06-14T00:00:00Z' }),
        // not sent — ignored
        makeQuote({ created_at: '2026-06-20T00:00:00Z' }),
      ],
      NOW,
    );
    expect(k.avgTurnaroundDays).toBe(3);
  });

  it('returns null turnaround when no quote has been sent', () => {
    const k = computeKpis([makeQuote({ quote_sent_at: null })], NOW);
    expect(k.avgTurnaroundDays).toBeNull();
  });

  it('conversion rate = approved / sent across all-time', () => {
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: '2026-01-01T00:00:00Z', customer_approved_at: '2026-01-05T00:00:00Z' }),
        makeQuote({ quote_sent_at: '2026-02-01T00:00:00Z' }),
        makeQuote({ quote_sent_at: '2026-03-01T00:00:00Z', customer_approved_at: '2026-03-05T00:00:00Z' }),
        makeQuote({ quote_sent_at: '2026-04-01T00:00:00Z' }),
      ],
      NOW,
    );
    expect(k.conversionRate).toBe(0.5);
  });

  it('conversion is null when no quote has been sent', () => {
    const k = computeKpis([makeQuote({ quote_sent_at: null })], NOW);
    expect(k.conversionRate).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/lib/dashboard/metrics.test.ts
```

Expected: red — file `./metrics` not found.

- [ ] **Step 3: Implement metrics.ts to pass**

Create `src/lib/dashboard/metrics.ts`:

```ts
import { DASHBOARD_CONFIG } from './config';
import type { DashboardQuote, Kpis } from './types';

const MS_PER_DAY = 86_400_000;

function daysBetween(later: string, earlier: string): number {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / MS_PER_DAY;
}

/** Stable customer key: HL contact id wins; otherwise email, phone, then name. */
function customerKey(q: DashboardQuote): string {
  return q.highlevel_contact_id
    ?? q.customer_email
    ?? q.customer_phone
    ?? q.customer_name
    ?? `__unknown_${q.id}`;
}

export function computeKpis(quotes: DashboardQuote[], now: Date): Kpis {
  const nowMs = now.getTime();
  const recentCutoff = nowMs - DASHBOARD_CONFIG.recentlyBookedWindowDays * MS_PER_DAY;
  const activeCutoff = nowMs - DASHBOARD_CONFIG.activeQuoteWindowDays * MS_PER_DAY;

  let bookedRevenue = 0;
  let bookedRevenueRecent = 0;
  let activeQuotes = 0;
  let sentCount = 0;
  let approvedCount = 0;
  let turnaroundSum = 0;
  let turnaroundN = 0;
  const activeCustomerKeys = new Set<string>();

  for (const q of quotes) {
    const approvedAt = q.customer_approved_at;
    const sentAt = q.quote_sent_at;
    const total = q.total ?? 0;

    if (approvedAt) {
      bookedRevenue += total;
      const approvedMs = new Date(approvedAt).getTime();
      if (approvedMs >= recentCutoff) bookedRevenueRecent += total;
      approvedCount += 1;
    }

    if (sentAt) {
      sentCount += 1;
      // Avg turnaround uses created→sent for every sent quote (no window).
      turnaroundSum += daysBetween(sentAt, q.created_at);
      turnaroundN += 1;

      const sentMs = new Date(sentAt).getTime();
      if (!approvedAt && sentMs >= activeCutoff) {
        activeQuotes += 1;
        activeCustomerKeys.add(customerKey(q));
      }
    }
  }

  return {
    bookedRevenue,
    bookedRevenueRecent,
    activeQuotes,
    activeCustomers: activeCustomerKeys.size,
    avgTurnaroundDays: turnaroundN > 0 ? turnaroundSum / turnaroundN : null,
    conversionRate: sentCount > 0 ? approvedCount / sentCount : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/lib/dashboard/metrics.test.ts
```

Expected: green — all assertions pass.

- [ ] **Step 5: Run full gates + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/lib/dashboard/metrics.ts src/lib/dashboard/metrics.test.ts
git commit -m "dashboard: computeKpis (TDD) — booked revenue, active, turnaround, conversion"
```

---

## Task 6: Worklist classification (TDD — tests first)

Pure function `computeWorklist(quotes, now): WorklistItem[]`. Sorted oldest-first (most-overdue at top), capped to `worklistMaxRows`.

**Files:**
- Create: `src/lib/dashboard/worklist.test.ts`
- Create: `src/lib/dashboard/worklist.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/dashboard/worklist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeWorklist } from './worklist';
import type { DashboardQuote } from './types';
import { DASHBOARD_CONFIG } from './config';

const NOW = new Date('2026-06-24T12:00:00Z');

function makeQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: crypto.randomUUID(),
    customer_name: 'Smith Family',
    customer_email: null,
    customer_phone: null,
    total: 1500,
    created_at: '2026-06-20T12:00:00Z',
    quote_sent_at: null,
    customer_approved_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    ...over,
  };
}

describe('computeWorklist — empty', () => {
  it('returns [] on empty input', () => {
    expect(computeWorklist([], NOW)).toEqual([]);
  });
});

describe('computeWorklist — draft-stale', () => {
  it('does NOT surface a quote drafted within the draftStaleDays window', () => {
    const recent = new Date(NOW.getTime() - 0.5 * 86400_000).toISOString();
    const out = computeWorklist([makeQuote({ created_at: recent })], NOW);
    expect(out).toEqual([]);
  });

  it('surfaces a quote drafted more than draftStaleDays ago with no quote_sent_at', () => {
    const old = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.draftStaleDays + 2) * 86400_000,
    ).toISOString();
    const out = computeWorklist([makeQuote({ id: 'q1', created_at: old })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('draft-stale');
    expect(out[0].quoteId).toBe('q1');
    expect(out[0].href).toBe('/quote/q1');
  });
});

describe('computeWorklist — sent-no-reply', () => {
  it('does NOT surface a quote sent within the sentNoReplyStaleDays window', () => {
    const recent = new Date(NOW.getTime() - 0.5 * 86400_000).toISOString();
    const out = computeWorklist(
      [makeQuote({ created_at: '2026-06-01T00:00:00Z', quote_sent_at: recent })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('surfaces a quote sent more than sentNoReplyStaleDays ago with no approval', () => {
    const old = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.sentNoReplyStaleDays + 2) * 86400_000,
    ).toISOString();
    const out = computeWorklist(
      [makeQuote({ id: 'q2', created_at: '2026-06-01T00:00:00Z', quote_sent_at: old })],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('sent-no-reply');
    expect(out[0].quoteId).toBe('q2');
    expect(out[0].href).toBe('/portal/q2');
  });

  it('does NOT surface an approved quote even if sent long ago', () => {
    const old = new Date(NOW.getTime() - 30 * 86400_000).toISOString();
    const out = computeWorklist(
      [makeQuote({
        quote_sent_at: old,
        customer_approved_at: new Date(NOW.getTime() - 25 * 86400_000).toISOString(),
      })],
      NOW,
    );
    expect(out).toEqual([]);
  });
});

describe('computeWorklist — sorting + cap', () => {
  it('sorts oldest-stale first (most overdue at the top)', () => {
    const aDay = 86400_000;
    const out = computeWorklist(
      [
        makeQuote({ id: 'newer', created_at: new Date(NOW.getTime() - 2 * aDay).toISOString() }),
        makeQuote({ id: 'older', created_at: new Date(NOW.getTime() - 10 * aDay).toISOString() }),
      ],
      NOW,
    );
    expect(out.map(r => r.quoteId)).toEqual(['older', 'newer']);
    expect(out[0].ageDays).toBeGreaterThan(out[1].ageDays);
  });

  it('caps the row count at worklistMaxRows', () => {
    const aDay = 86400_000;
    const rows = Array.from({ length: DASHBOARD_CONFIG.worklistMaxRows + 5 }, (_, i) =>
      makeQuote({ id: `q${i}`, created_at: new Date(NOW.getTime() - (i + 2) * aDay).toISOString() }),
    );
    expect(computeWorklist(rows, NOW)).toHaveLength(DASHBOARD_CONFIG.worklistMaxRows);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/lib/dashboard/worklist.test.ts
```

Expected: red — file `./worklist` not found.

- [ ] **Step 3: Implement worklist.ts to pass**

Create `src/lib/dashboard/worklist.ts`:

```ts
import { DASHBOARD_CONFIG } from './config';
import type { DashboardQuote, WorklistItem } from './types';

const MS_PER_DAY = 86_400_000;

function customerLabel(q: DashboardQuote): string {
  return q.customer_name?.trim() || 'Unknown customer';
}

export function computeWorklist(quotes: DashboardQuote[], now: Date): WorklistItem[] {
  const nowMs = now.getTime();
  const items: WorklistItem[] = [];

  for (const q of quotes) {
    if (!q.quote_sent_at) {
      // Draft: never sent. Age = days since created.
      const ageDays = (nowMs - new Date(q.created_at).getTime()) / MS_PER_DAY;
      if (ageDays >= DASHBOARD_CONFIG.draftStaleDays) {
        items.push({
          kind: 'draft-stale',
          quoteId: q.id,
          title: customerLabel(q),
          subtitle: `Drafted ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? '' : 's'} ago — never sent`,
          ageDays,
          href: `/quote/${q.id}`,
        });
      }
      continue;
    }

    if (!q.customer_approved_at) {
      // Sent but no reply.
      const ageDays = (nowMs - new Date(q.quote_sent_at).getTime()) / MS_PER_DAY;
      if (ageDays >= DASHBOARD_CONFIG.sentNoReplyStaleDays) {
        items.push({
          kind: 'sent-no-reply',
          quoteId: q.id,
          title: customerLabel(q),
          subtitle: `Sent ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? '' : 's'} ago — no reply`,
          ageDays,
          href: `/portal/${q.id}`,
        });
      }
    }
  }

  // Oldest first (most overdue at top).
  items.sort((a, b) => b.ageDays - a.ageDays);
  return items.slice(0, DASHBOARD_CONFIG.worklistMaxRows);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/lib/dashboard/worklist.test.ts
```

Expected: green — all assertions pass.

- [ ] **Step 5: Run full gates + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/lib/dashboard/worklist.ts src/lib/dashboard/worklist.test.ts
git commit -m "dashboard: computeWorklist (TDD) — draft-stale + sent-no-reply rules"
```

---

## Task 7: Dashboard Supabase query

A thin server-only fetcher that returns the columns the dashboard needs. Lives in Naldo's `src/lib/dashboard/` to keep changes inside his area (rather than extending the shared `src/lib/quotes.ts`).

**Files:**
- Create: `src/lib/dashboard/queries.ts`

- [ ] **Step 1: Write the query**

Create `src/lib/dashboard/queries.ts`:

```ts
import { getSupabaseClient, getSupabaseServiceClient } from '@/lib/supabase';
import type { DashboardQuote } from './types';

/**
 * Fetch quotes for the dashboard: id, customer info, total, and the full
 * lifecycle timestamp chain. Service client preferred (same pattern as
 * `listQuotes` in `lib/quotes.ts`) so admin-side reads never trip RLS.
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
        'homeworks_sent_at, homeworks_signed_at, highlevel_contact_id',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listQuotesForDashboard error:', error);
    return [];
  }
  return (data ?? []) as DashboardQuote[];
}
```

- [ ] **Step 2: Verify tsc + commit**

```bash
npx tsc --noEmit
git add src/lib/dashboard/queries.ts
git commit -m "dashboard: listQuotesForDashboard query (server-only)"
```

---

## Task 8: UI components

Server components for the dashboard. No client state in Phase 1. All five files are created in a single task because they're small and tightly coupled.

**Files:**
- Create: `src/components/dashboard/OperatorNav.tsx`
- Create: `src/components/dashboard/DashboardHeader.tsx`
- Create: `src/components/dashboard/KpiStrip.tsx`
- Create: `src/components/dashboard/KpiCard.tsx`
- Create: `src/components/dashboard/Worklist.tsx`
- Create: `src/components/dashboard/WorklistRow.tsx`

- [ ] **Step 1: OperatorNav**

Create `src/components/dashboard/OperatorNav.tsx`:

```tsx
import Link from 'next/link';

type NavItem = { label: string; href: string };

const ITEMS: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Quotes', href: '/admin/quotes' },
  { label: 'New quote', href: '/quote/new' },
  { label: 'Training', href: '/training' },
  { label: 'Settings', href: '/settings' },
];

export function OperatorNav({ active }: { active: 'home' | 'quotes' | 'new' | 'training' | 'settings' }) {
  const isActive = (href: string) =>
    (active === 'home' && href === '/') ||
    (active === 'quotes' && href === '/admin/quotes') ||
    (active === 'new' && href === '/quote/new') ||
    (active === 'training' && href === '/training') ||
    (active === 'settings' && href === '/settings');

  return (
    <nav
      aria-label="Operator navigation"
      className="border-b"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <div className="max-w-6xl mx-auto px-4 flex items-center gap-6 h-12">
        <span
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: 'var(--brand-evergreen-3)' }}
        >
          Yule Love Lights
        </span>
        <ul className="flex items-center gap-1 text-sm">
          {ITEMS.map(item => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="px-3 py-1.5 rounded-md transition-colors"
                style={
                  isActive(item.href)
                    ? { background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }
                    : { color: 'var(--op-text-2)' }
                }
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: DashboardHeader**

Create `src/components/dashboard/DashboardHeader.tsx`:

```tsx
import Link from 'next/link';

export function DashboardHeader() {
  return (
    <header className="flex items-end justify-between mb-8">
      <div>
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-1"
          style={{ color: 'var(--brand-evergreen-3)' }}
        >
          Operator dashboard
        </p>
        <h1 className="text-3xl font-semibold" style={{ color: 'var(--op-text)' }}>
          Good morning.
        </h1>
      </div>
      <Link
        href="/quote/new"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm"
        style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
      >
        + New quote
      </Link>
    </header>
  );
}
```

- [ ] **Step 3: KpiCard + KpiStrip**

Create `src/components/dashboard/KpiCard.tsx`:

```tsx
export function KpiCard({
  label,
  value,
  sub,
  prominent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  prominent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${prominent ? 'md:col-span-2' : ''}`}
      style={{
        background: 'var(--op-bg-raised)',
        borderColor: prominent ? 'var(--brand-gold)' : 'var(--op-border)',
      }}
    >
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
        {label}
      </div>
      <div
        className={`mt-1 font-semibold tabular-nums ${prominent ? 'text-4xl' : 'text-2xl'}`}
        style={{ color: 'var(--op-text)' }}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}
```

Create `src/components/dashboard/KpiStrip.tsx`:

```tsx
import type { Kpis } from '@/lib/dashboard/types';
import { KpiCard } from './KpiCard';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtDays(n: number | null): string {
  if (n == null) return '—';
  if (n < 1) return `${(n * 24).toFixed(1)} hr`;
  return `${n.toFixed(1)} d`;
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

export function KpiStrip({ kpis }: { kpis: Kpis }) {
  return (
    <section aria-label="Key metrics" className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8">
      <KpiCard
        label="Quote turnaround"
        value={fmtDays(kpis.avgTurnaroundDays)}
        sub="created → sent (avg)"
        prominent
      />
      <KpiCard label="Booked (30 days)" value={fmtMoney(kpis.bookedRevenueRecent)} sub="trailing 30 days" />
      <KpiCard label="Booked (lifetime)" value={fmtMoney(kpis.bookedRevenue)} />
      <KpiCard label="Active quotes" value={kpis.activeQuotes.toString()} sub="sent · awaiting customer" />
      <KpiCard label="Conversion" value={fmtPct(kpis.conversionRate)} sub="approved / sent" />
    </section>
  );
}
```

- [ ] **Step 4: WorklistRow + Worklist**

Create `src/components/dashboard/WorklistRow.tsx`:

```tsx
import Link from 'next/link';
import type { WorklistItem } from '@/lib/dashboard/types';

const KIND_LABEL: Record<WorklistItem['kind'], string> = {
  'draft-stale': 'Draft',
  'sent-no-reply': 'No reply',
};

export function WorklistRow({ item }: { item: WorklistItem }) {
  return (
    <Link
      href={item.href}
      className="flex items-center gap-4 px-4 py-3 border-t transition-colors hover:opacity-90"
      style={{ borderColor: 'var(--op-border)' }}
    >
      <span
        className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded"
        style={{
          background: item.kind === 'sent-no-reply' ? 'var(--op-danger)' : 'var(--brand-gold)',
          color: item.kind === 'sent-no-reply' ? 'var(--brand-cream)' : 'var(--brand-evergreen)',
        }}
      >
        {KIND_LABEL[item.kind]}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate" style={{ color: 'var(--op-text)' }}>{item.title}</div>
        <div className="text-xs" style={{ color: 'var(--op-text-dim)' }}>{item.subtitle}</div>
      </div>
      <span aria-hidden style={{ color: 'var(--op-text-dim)' }}>→</span>
    </Link>
  );
}
```

Create `src/components/dashboard/Worklist.tsx`:

```tsx
import type { WorklistItem } from '@/lib/dashboard/types';
import { WorklistRow } from './WorklistRow';

export function Worklist({ items }: { items: WorklistItem[] }) {
  return (
    <section aria-label="Needs your attention" className="mb-8">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        Needs your attention
      </h2>
      <div
        className="rounded-lg border overflow-hidden"
        style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
      >
        {items.length === 0 ? (
          <div className="p-6 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>
            Inbox zero. Nothing aging out right now.
          </div>
        ) : (
          items.map(item => <WorklistRow key={`${item.kind}:${item.quoteId}`} item={item} />)
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Verify tsc + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/components/dashboard/
git commit -m "dashboard: server components — nav, header, KPI strip, worklist"
```

---

## Task 9: Wire `page.tsx` to the dashboard

Replace the boilerplate `src/app/page.tsx` with the actual dashboard.

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Replace page.tsx**

Replace `src/app/page.tsx` with:

```tsx
import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { computeKpis } from '@/lib/dashboard/metrics';
import { computeWorklist } from '@/lib/dashboard/worklist';
import { OperatorNav } from '@/components/dashboard/OperatorNav';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { Worklist } from '@/components/dashboard/Worklist';

// Always render fresh — the dashboard reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const quotes = await listQuotesForDashboard(500);
  const now = new Date();
  const kpis = computeKpis(quotes, now);
  const worklist = computeWorklist(quotes, now);

  return (
    <>
      <OperatorNav active="home" />
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
        <DashboardHeader />
        <KpiStrip kpis={kpis} />
        <Worklist items={worklist} />
      </main>
    </>
  );
}
```

- [ ] **Step 2: Verify the page renders**

In a browser, load **`http://localhost:3000/`**. Expected:
- Cream background, evergreen text.
- Top nav with Home (active), Quotes, New quote, Training, Settings.
- "Operator dashboard" eyebrow + "Good morning." heading.
- "+ New quote" CTA button (evergreen filled).
- 6-column KPI strip with prominent gold-bordered Turnaround card on the left + 4 regular KPI cards.
- "Needs your attention" worklist below — populated if there are real stale drafts or stale-sent quotes in the DB, or the empty state copy if not.
- No console errors. No layout shift.

- [ ] **Step 3: Verify the portal is still untouched**

Load `http://localhost:3000/portal/<any-quote-id>` from the admin list. Expected: dark snowglobe theme, exactly as before — confirms the operator surface and brand tokens don't leak.

- [ ] **Step 4: Run gates + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/app/page.tsx
git commit -m "dashboard: replace boilerplate / with operator dashboard"
```

---

## Task 10: Push + open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin naldo/dashboard-shell
```

Expected: git prints a PR URL ("Create a pull request for 'naldo/dashboard-shell' on GitHub by visiting: …"). **Click that URL.**

- [ ] **Step 2: Open the PR on GitHub**

PR title: `Dashboard Phase 1 — shell, KPIs, worklist (#58)`

PR description template:

```markdown
First slice of task #58 — the boilerplate `/` is now the operator dashboard.

Closes part of #58 (Phase 1 of the plan in `docs/dashboard/PLAN.md`).

## What's in
- Brand color tokens lifted from `portal-dark.css` into `globals.css` (`--brand-*`) so portal + operator UI share one source of truth.
- Operator surface tokens (`--op-*`) + `.operator-surface` body class — light cream/evergreen scheme. Portal route is unchanged (its own layout wraps in `.portal-dark-root`).
- `<title>` fixed: "Create Next App" → "Yule Love Lights".
- `src/lib/dashboard/{types,config,queries,metrics,worklist}.ts` — pure functions, server-only query.
- `src/components/dashboard/{OperatorNav,DashboardHeader,KpiStrip,KpiCard,Worklist,WorklistRow}.tsx` — server components.
- `src/app/page.tsx` — server-rendered dashboard.
- Unit tests for `computeKpis` + `computeWorklist`.

## What's out (later phases)
- Per-service breakdown (Phase 2; needs `service_type` migration).
- Customer detail (Phase 3).
- Charts (Phase 4).
- home.works-sourced metrics (Phase 5; integration is shelved per task #16).

## Test plan
- [ ] `/` loads with KPI strip + worklist, no console errors.
- [ ] Portal `/portal/<id>` still renders dark snowglobe theme.
- [ ] Browser tab title says "Yule Love Lights".
- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run lint` 0 errors.
- [ ] `npm test` all green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Self-merge (Naldo's area, per `AGENTS.md` review-merge rule)**

`AGENTS.md` says "Own-area PRs: self-merge." Phase 1 only touches Naldo's area + two shared files Jason was given a heads-up about. After Jason confirms his ack, merge the PR. (If Jason wants to review the shared-file edits anyway, wait for him.)

---

## Self-review — verify the plan against the spec

The parent `docs/dashboard/PLAN.md` §6 Phase 1 promised the following — confirm each is covered:

- ✅ Brand tokens in `globals.css` (Task 2).
- ✅ `<title>` + `<meta description>` fix in `layout.tsx` (Task 3).
- ✅ Dashboard shell at `/` (Task 9).
- ✅ KPI strip: booked revenue, active quotes, active customers, avg turnaround, conversion (Tasks 5 + 8).
- ✅ "Needs your attention" worklist from lifecycle timestamps (Tasks 6 + 8).
- ✅ Nav links to existing pages, no new pages built (Task 8).
- ✅ Unit tests for `metrics.ts` + `worklist.ts` (Tasks 5 + 6).
- ⚠️ Plan deviation: dropped `/api/dashboard/route.ts` in favor of direct server-component fetching (documented at the top of this file). Re-add if a client-side refresh is wanted later.

## Files Naldo's session should NOT touch in Phase 1 (Jason's lane)

Per `AGENTS.md`, hands off these without coordinating first:
- `src/lib/pricing/**`, `src/lib/photoAnalysis.ts`, `src/lib/portal/**`, `src/lib/integrations/**`
- `src/components/portal/**`, `src/components/quote/**`, `src/components/design/**`
- `src/app/portal/**`, `src/app/quote/**`, `src/app/admin/**`, `src/app/training/**`, `src/app/settings/**`
- `src/app/api/*` except `src/app/api/dashboard/**` (which we're not creating in Phase 1)

## Execution handoff

When Naldo approves this plan, execute via one of:

1. **Subagent-driven (recommended)** — fresh subagent per task with review checkpoints (`superpowers:subagent-driven-development`).
2. **Inline execution** — batch in this session with checkpoints (`superpowers:executing-plans`).

Naldo to confirm approach before execution begins.
