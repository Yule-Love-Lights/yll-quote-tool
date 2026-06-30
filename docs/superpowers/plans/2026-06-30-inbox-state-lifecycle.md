# Inbox State Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the `/inbox` customer lifecycle so handled/followed customers stay visible in an always-on "In the works" section (two groups, with a configurable stale "follow-up" nudge), add a terminal **Completed** state, and add an **audit log** with per-entry **Reverse** (full undo, incl. un-suppressing a wrongly-dismissed sender).

**Architecture:** One pure module (`lifecycle.ts`) holds all the decisions (bucketing, staleness, reverse-inverse, threshold clamp); the store + thin operator-gated routes apply them; the UI reuses the existing `/inbox` section + card patterns. `Completed` is a new `status` value (one migration); `followed_up_at` (v2) is reused. Prior-state is recorded in the existing `dashboard_activity.detail` so Reverse is exact.

**Tech Stack:** Next.js route handlers, TypeScript (no `any` — lint error), Supabase service-role, Vitest. Gates from the repo root: `npx tsc --noEmit`, `npm run lint`, `npx vitest run <file>`.

**Spec:** `docs/superpowers/specs/2026-06-30-inbox-state-lifecycle-design.md` · **Builds on:** inbox v1 (#258) + v2 (#265).

---

## File map

**Create**
- `src/lib/dashboard/inbox/lifecycle.ts` + `.test.ts` — pure: `bucketOf`, `isStale`, `inverseOf`, `clampFollowUpDays`.
- `src/app/api/dashboard/completed/route.ts` — mark completed.
- `src/app/api/dashboard/settings/route.ts` — get/set `dashboard.followUpDays`.
- `src/app/api/dashboard/activity/reverse/route.ts` — reverse an activity entry.
- `src/components/dashboard/inbox/InWorksSection.tsx` — the two-group "In the works" section (replaces `FollowedSection`).
- `src/components/dashboard/inbox/ActivityLog.tsx` + `src/app/inbox/activity/page.tsx` — the audit view.
- `migrations/2026-06-30-inbox-completed-status.sql` — `completed` status.

**Modify**
- `src/lib/dashboard/inbox/reducer.ts` — reopen `completed` (not just `handled`) on a genuinely-newer inbound.
- `src/lib/dashboard/inbox/store.ts` — `listInWorks`, `listCompleted`, `markItemCompleted`, `listActivity`, `reverseItemState`; state-change activity inserts record `detail.from`.
- `src/lib/dashboard/inbox/suppression.ts` — `removeSuppressedSenders`.
- `src/lib/dashboard/inbox/settings.ts` *(create if absent)* — `getFollowUpDays`.
- `src/app/inbox/page.tsx` — render `InWorksSection` (drop `FollowedSection`) + link to the activity log.
- `src/app/inbox/settings/page.tsx` — the follow-up-days control.
- `src/components/dashboard/inbox/InboxList.tsx` — add "Mark completed" to the card actions.

**Pre-flight for every implementer:** repo root is `C:/Users/ebhdh/OneDrive/Documents/Ai Quote Tool`. Read the real signatures before wiring glue — `store.ts` (`getSupabaseServiceClient` import, `markItemFollowed`/`dismissItem`/`markItemHandledLocal` shapes, `listOpenItems`/`listFollowedItems` query idiom), `suppression.ts` (`normalizeSuppressionValues`, `getSuppressedSenders`), `types.ts` (`InboxStatus`), an existing `src/app/api/dashboard/*/route.ts` (the `requireOperator`+`getOperator`+`rateLimitResponse`+`isUuid` idiom), and `src/app/inbox/page.tsx` + `InboxList.tsx`. Match them; if a name differs, use the real one.

---

## Task 1: Pure `lifecycle.ts`

**Files:** Create `src/lib/dashboard/inbox/lifecycle.ts`, `src/lib/dashboard/inbox/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test** (`lifecycle.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { bucketOf, isStale, inverseOf, clampFollowUpDays } from './lifecycle';

const T = new Date('2026-06-30T12:00:00Z');
const ago = (days: number) => new Date(T.getTime() - days * 86_400_000).toISOString();

describe('bucketOf', () => {
  it('needs_reply: unresponded, no follow flag', () => {
    expect(bucketOf({ status: 'unresponded', followedUpAt: null })).toBe('needs_reply');
  });
  it('awaiting_reply: any followed_up_at set (incl. a sent reply that is also handled)', () => {
    expect(bucketOf({ status: 'handled', followedUpAt: ago(1) })).toBe('awaiting_reply');
    expect(bucketOf({ status: 'unresponded', followedUpAt: ago(1) })).toBe('awaiting_reply');
  });
  it('handled: handled with no follow flag', () => {
    expect(bucketOf({ status: 'handled', followedUpAt: null })).toBe('handled');
  });
  it('completed / dismissed terminal', () => {
    expect(bucketOf({ status: 'completed', followedUpAt: null })).toBe('completed');
    expect(bucketOf({ status: 'dismissed', followedUpAt: ago(1) })).toBe('dismissed');
  });
});

describe('isStale', () => {
  it('true past the threshold, false within, false when null', () => {
    expect(isStale(ago(4), 3, T)).toBe(true);
    expect(isStale(ago(2), 3, T)).toBe(false);
    expect(isStale(null, 3, T)).toBe(false);
  });
});

describe('inverseOf', () => {
  it('un-dismiss restores prior status and un-suppresses', () => {
    expect(inverseOf('dismissed', { status: 'unresponded' })).toEqual({ status: 'unresponded', clearFollowed: false, unsuppress: true });
  });
  it('un-complete falls back to handled when no prior', () => {
    expect(inverseOf('completed')).toEqual({ status: 'handled', clearFollowed: false, unsuppress: false });
  });
  it('un-handle -> needs reply; un-follow clears the flag only', () => {
    expect(inverseOf('handled')).toEqual({ status: 'unresponded', clearFollowed: false, unsuppress: false });
    expect(inverseOf('followed')).toEqual({ status: null, clearFollowed: true, unsuppress: false });
  });
});

describe('clampFollowUpDays', () => {
  it('defaults to 3, clamps 1..60, rounds', () => {
    expect(clampFollowUpDays(undefined)).toBe(3);
    expect(clampFollowUpDays(0)).toBe(1);
    expect(clampFollowUpDays(999)).toBe(60);
    expect(clampFollowUpDays(4.6)).toBe(5);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `npx vitest run src/lib/dashboard/inbox/lifecycle.test.ts`

- [ ] **Step 3: Implement `lifecycle.ts`**

```ts
// Pure inbox lifecycle decisions (#58 v3) — bucketing, staleness, reverse-inverse,
// threshold clamp. No I/O; the store + routes apply these.
import type { InboxStatus } from './types';

export type Bucket = 'needs_reply' | 'awaiting_reply' | 'handled' | 'completed' | 'dismissed';

/** Which board bucket an item belongs to. A set follow flag wins over 'handled'
 *  (a sent reply is handled+followed → we're awaiting them). */
export function bucketOf(item: { status: InboxStatus; followedUpAt: string | null }): Bucket {
  if (item.status === 'dismissed') return 'dismissed';
  if (item.status === 'completed') return 'completed';
  if (item.followedUpAt) return 'awaiting_reply';
  if (item.status === 'handled') return 'handled';
  return 'needs_reply';
}

/** True when an active item has been quiet longer than `days`. `lastActivityIso` is
 *  the bucket-appropriate timestamp (followed_up_at for awaiting, handled_at for handled). */
export function isStale(lastActivityIso: string | null, days: number, now: Date): boolean {
  if (!lastActivityIso) return false;
  return now.getTime() - new Date(lastActivityIso).getTime() > days * 86_400_000;
}

export type ReverseAction = 'handled' | 'followed' | 'completed' | 'dismissed';
export type ReverseTarget = { status: InboxStatus | null; clearFollowed: boolean; unsuppress: boolean };

/** The inverse of an operator action. `from` (recorded in dashboard_activity.detail)
 *  makes it exact; without it we fall back to a sensible per-action target.
 *  status:null means "leave status as-is" (used by un-follow, which only clears the flag). */
export function inverseOf(action: ReverseAction, from?: { status?: InboxStatus; wasFollowed?: boolean }): ReverseTarget {
  switch (action) {
    case 'dismissed':
      return { status: from?.status ?? 'unresponded', clearFollowed: false, unsuppress: true };
    case 'completed':
      return { status: from?.status ?? 'handled', clearFollowed: false, unsuppress: false };
    case 'handled':
      return { status: 'unresponded', clearFollowed: false, unsuppress: false };
    case 'followed':
      return { status: null, clearFollowed: true, unsuppress: false };
  }
}

/** The configured follow-up-reminder window in days. Safe default 3, clamped 1..60. */
export function clampFollowUpDays(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.min(60, Math.max(1, Math.round(v)));
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git add src/lib/dashboard/inbox/lifecycle.ts src/lib/dashboard/inbox/lifecycle.test.ts && git commit -m "feat(#58): pure inbox lifecycle helpers (bucket/stale/inverse/clamp)"`

---

## Task 2: Migration + reducer reopens `completed`

**Files:** Create `migrations/2026-06-30-inbox-completed-status.sql`; Modify `src/lib/dashboard/inbox/reducer.ts`, `src/lib/dashboard/inbox/reducer.test.ts`

- [ ] **Step 1: Migration file**

```sql
-- #58 v3: a terminal "completed" state (fully done, no more contact expected) —
-- distinct from "handled" (still in the works). Additive: widen the status CHECK.
alter table public.inbox_items drop constraint if exists inbox_items_status_check;
alter table public.inbox_items add constraint inbox_items_status_check
  check (status in ('unresponded','handled','dismissed','completed'));
```
(Applied to prod before merge — not part of the code commit. Mirrors how v2's migration was handled.)

- [ ] **Step 2: Failing reducer test** (append to `reducer.test.ts`) — confirm the `decideInboxState` signature/helpers (`ExistingItemState`, `touch`, `at`, `HOUR`, `T`) by reading the file first, then add:

```ts
describe('decideInboxState — completed reopens like handled', () => {
  it('does NOT reopen a completed item on the SAME message (re-ingest)', () => {
    const existing: ExistingItemState = { status: 'completed', notifiedLevels: [], lastMessageAt: T };
    const d = decideInboxState({ existing, touch: touch({ lastMessageAt: T }), now: at(2 * HOUR) });
    expect(d.status).toBe('completed');
    expect(d.reopened).toBe(false);
  });
  it('reopens a completed item on a genuinely NEWER inbound', () => {
    const existing: ExistingItemState = { status: 'completed', notifiedLevels: [], lastMessageAt: T };
    const d = decideInboxState({ existing, touch: touch({ lastMessageAt: at(3 * HOUR) }), now: at(4 * HOUR) });
    expect(d.status).toBe('unresponded');
    expect(d.reopened).toBe(true);
  });
});
```
(An automated touch never reaches here as a real lead — `lead_kind` is set at ingest; the reducer only sees the touch direction. No extra test needed for newsletters: they're filtered upstream as `automated`, not re-opened here.)

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement** — in `reducer.ts`, generalise the handled-reopen guard to cover `completed`. Replace the `wasHandled` block:

```ts
  // A genuinely-newer inbound reopens a RESOLVED item (handled or completed); the
  // same message re-ingested by the reconcile cron leaves it as-is. (Newsletters
  // are classified 'automated' at ingest, so they never present as a real reopen.)
  const wasResolved = existing?.status === 'handled' || existing?.status === 'completed';
  if (wasResolved) {
    const newerInbound =
      existing?.lastMessageAt == null || touch.lastMessageAt.getTime() > existing.lastMessageAt.getTime();
    if (!newerInbound) {
      return { status: existing!.status, escalationLevel: 0, autoResolved: false, reopened: false };
    }
  }
  return {
    status: 'unresponded',
    escalationLevel: escalationLevel(touch.lastMessageAt, now),
    autoResolved: false,
    reopened: wasResolved,
  };
```
(Keep the earlier `dismissed`-sticky and outbound→`handled` branches unchanged. `existing!.status` is safe inside `wasResolved`.)

- [ ] **Step 5: Run → PASS** (new + all existing reducer tests). `npx tsc --noEmit` → 0.
- [ ] **Step 6: Commit** — `git add src/lib/dashboard/inbox/reducer.ts src/lib/dashboard/inbox/reducer.test.ts migrations/2026-06-30-inbox-completed-status.sql && git commit -m "feat(#58): completed status + reducer reopens completed on newer inbound"`

---

## Task 3: Store — buckets, mark-completed, prior-state logging

**Files:** Modify `src/lib/dashboard/inbox/store.ts`

- [ ] **Step 1: Implement** (service-role glue — covered by tsc + review per the store header; no unit test required). Read `listOpenItems`/`listFollowedItems` first and MIRROR their select + row-mapping idiom.

Add `listInWorks` (two groups, stalest-first):
```ts
export type InWorksItem = {
  id: string; source: InboxSource; channel: string | null; preview: string | null;
  customerName: string | null; lastActivityAt: string | null;
};
export type InWorksResult =
  | { ok: true; awaiting: InWorksItem[]; handled: InWorksItem[] }
  | { ok: false; error: string };

export async function listInWorks(limit = 200): Promise<InWorksResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const sel = 'id, source, channel, preview, followed_up_at, handled_at, status, dashboard_contacts ( display_name )';
  // Awaiting their reply: any follow flag, not terminal. Oldest follow first (stalest).
  const aw = await sb.from('inbox_items').select(sel)
    .not('followed_up_at', 'is', null).not('status', 'in', '(completed,dismissed)')
    .order('followed_up_at', { ascending: true }).limit(limit);
  // Handled with no follow flag. Oldest handled first.
  const hd = await sb.from('inbox_items').select(sel)
    .eq('status', 'handled').is('followed_up_at', null)
    .order('handled_at', { ascending: true }).limit(limit);
  if (aw.error) return { ok: false, error: aw.error.message };
  if (hd.error) return { ok: false, error: hd.error.message };
  const map = (rows: unknown[], tsKey: 'followed_up_at' | 'handled_at'): InWorksItem[] =>
    (rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const c = (row.dashboard_contacts as { display_name?: string | null } | null) ?? null;
      return {
        id: String(row.id), source: row.source as InboxSource,
        channel: (row.channel as string | null) ?? null,
        preview: (row.preview as string | null) ?? null,
        customerName: (c?.display_name as string | null) ?? null,
        lastActivityAt: (row[tsKey] as string | null) ?? null,
      };
    });
  return { ok: true, awaiting: map(aw.data ?? [], 'followed_up_at'), handled: map(hd.data ?? [], 'handled_at') };
}
```

Add `listCompleted` (read-only recent list, same `InWorksItem` shape ordered by `handled_at` desc — reuse the mapper; `status='completed'`).

Add `markItemCompleted` — capture prior state for an exact reverse, then set completed:
```ts
export async function markItemCompleted(itemId: string, operatorId: string, now: Date): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data: prior } = await sb.from('inbox_items').select('status, followed_up_at').eq('id', itemId).maybeSingle();
  const from = prior ? { status: (prior as { status: string }).status, wasFollowed: !!(prior as { followed_up_at: string | null }).followed_up_at } : undefined;
  const { error } = await sb.from('inbox_items')
    .update({ status: 'completed', followed_up_at: null, handled_by: operatorId, handled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', itemId);
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'completed', inbox_item_id: itemId, detail: { from } });
  return { ok: true };
}
```
> **Prior-state for the other actions:** add the same `detail: { from }` capture to the existing `markItemFollowed`, `dismissItem`, and `markItemHandledLocal` activity inserts (read the prior `status, followed_up_at` first). Keep each function's existing return contract.

- [ ] **Step 2:** `npx tsc --noEmit` → 0; `npm run lint` → 0; `npx vitest run src/lib/dashboard/inbox/store.test.ts` (existing pass — update any mocked query-builder to expose `.not`/`.is`/`.in` if a test exercises these reads).
- [ ] **Step 3: Commit** — `git add src/lib/dashboard/inbox/store.ts src/lib/dashboard/inbox/store.test.ts && git commit -m "feat(#58): store buckets (in-works/completed) + mark-completed + prior-state logging"`

---

## Task 4: `POST /api/dashboard/completed`

**Files:** Create `src/app/api/dashboard/completed/route.ts`

- [ ] **Step 1: Implement** — MIRROR `src/app/api/dashboard/followed/route.ts` exactly (read it), swapping the store call to `markItemCompleted` and the rate-limit bucket to `'dashboard-completed'`. Operator-gated, `isUuid(itemId)` validated, NOT in any public allowlist, `export const runtime = 'nodejs'`.
- [ ] **Step 2:** `npx tsc --noEmit` → 0; `npm run lint` → 0.
- [ ] **Step 3: Commit** — `git add src/app/api/dashboard/completed/route.ts && git commit -m "feat(#58): mark-completed route"`

---

## Task 5: Settings — `followUpDays` reader + control

**Files:** Create/Modify `src/lib/dashboard/inbox/settings.ts`; Create `src/app/api/dashboard/settings/route.ts`; Modify `src/app/inbox/settings/page.tsx`

- [ ] **Step 1: Failing test** — `src/lib/dashboard/inbox/settings.test.ts` (if `getFollowUpDays` reads I/O, test only the clamp via `clampFollowUpDays` already covered; add a parse test if you add a pure `parseFollowUpDays`). Otherwise this task is glue (tsc + review).

- [ ] **Step 2: Implement `getFollowUpDays`** (reads `app_settings` key `dashboard.followUpDays`, applies `clampFollowUpDays`; safe default 3 on any error):
```ts
import { getSupabaseServiceClient } from '@/lib/supabase';
import { clampFollowUpDays } from './lifecycle';
const KEY = 'dashboard.followUpDays';
export async function getFollowUpDays(): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 3;
  const { data, error } = await sb.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  if (error || !data) return 3;
  return clampFollowUpDays((data as { value?: unknown }).value);
}
export async function setFollowUpDays(days: number): Promise<void> {
  const sb = getSupabaseServiceClient(); if (!sb) return;
  await sb.from('app_settings').upsert({ key: KEY, value: clampFollowUpDays(days) }, { onConflict: 'key' });
}
```

- [ ] **Step 3: Route** `src/app/api/dashboard/settings/route.ts` — operator-gated `GET` → `{ followUpDays }`; `POST { followUpDays }` → `setFollowUpDays` (clamped). Mirror the dashboard route idiom.

- [ ] **Step 4: UI** — in `src/app/inbox/settings/page.tsx`, add a "Follow-up reminder" number input (days) that loads `GET` and saves `POST`. Match the page's existing control style. READ the file first.

- [ ] **Step 5:** `npx tsc --noEmit` → 0; `npm run lint` → 0.
- [ ] **Step 6: Commit** — `git add src/lib/dashboard/inbox/settings.ts src/app/api/dashboard/settings/route.ts src/app/inbox/settings/page.tsx && git commit -m "feat(#58): configurable follow-up-reminder days in inbox settings"`

---

## Task 6: "In the works" section + "Mark completed" action + page wiring

**Files:** Create `src/components/dashboard/inbox/InWorksSection.tsx`; Modify `src/app/inbox/page.tsx`, `src/components/dashboard/inbox/InboxList.tsx`

- [ ] **Step 1: `InWorksSection.tsx`** — props `{ awaiting: InWorksItem[]; handled: InWorksItem[]; followUpDays: number; nowMs: number }`. Render two labeled groups: **"Awaiting their reply"** and **"Handled"**. For each row: customer name (or "Unknown"), channel, preview, and the time-in-state via the existing `formatWaiting` helper (`@/lib/dashboard/inbox/notify`, pass `nowMs`). When `isStale(item.lastActivityAt, followUpDays, new Date(nowMs))`, show an amber **"Follow up — N days quiet"** badge (the store already orders stalest-first). Read `FollowedSection.tsx` for the visual idiom + tokens; this component REPLACES it.

- [ ] **Step 2: Page wiring** — in `src/app/inbox/page.tsx`: replace `listFollowedItems()` with `listInWorks()` + add `getFollowUpDays()` to the `Promise.all`; render `<InWorksSection awaiting={…} handled={…} followUpDays={…} nowMs={now.getTime()} />` where `FollowedSection` was; add a small link to `/inbox/activity` ("Activity log →") in the header. Delete the `FollowedSection` import (and the file if nothing else imports it).

- [ ] **Step 3: "Mark completed" action** — in `InboxList.tsx`, add a "Mark completed" button to the card actions (all non-completed cards) that calls the existing `act(item.id, '/api/dashboard/completed')` optimistic-removal helper (same mechanism as Handled/dismiss/followed). Keep existing buttons working; match the token style.

- [ ] **Step 4:** `npx tsc --noEmit` → 0; `npm run lint` → 0; `npx vitest run` (full suite green — UI is preview-verified).
- [ ] **Step 5: Commit** — `git add src/components/dashboard/inbox/InWorksSection.tsx src/app/inbox/page.tsx src/components/dashboard/inbox/InboxList.tsx && git commit -m "feat(#58): In-the-works section (2 groups + stale nudge) + Mark completed"`

---

## Task 7: Store — activity list, reverse, un-suppress

**Files:** Modify `src/lib/dashboard/inbox/store.ts`, `src/lib/dashboard/inbox/suppression.ts`

- [ ] **Step 1: `removeSuppressedSenders`** in `suppression.ts` (inverse of `addSuppressedSenders`):
```ts
export async function removeSuppressedSenders(values: (string | null | undefined)[]): Promise<void> {
  const drop = new Set(normalizeSuppressionValues(values));
  if (!drop.size) return;
  const sb = getSupabaseServiceClient(); if (!sb) return;
  const current = await getSuppressedSenders();
  const next = [...current].filter((v) => !drop.has(v));
  await sb.from('app_settings').upsert({ key: 'dashboard.suppressedSenders', value: next }, { onConflict: 'key' });
}
```
(Use the same key constant the file already defines — reuse it, don't duplicate the literal.)

- [ ] **Step 2: `listActivity`** in `store.ts` — paginated read of `dashboard_activity` newest-first, joined to the operator display name and the contact display name:
```ts
export type ActivityRow = {
  id: string; action: string; actor: string | null; actorName: string | null;
  itemId: string | null; customerName: string | null; at: string | null; reversible: boolean;
};
export async function listActivity(limit = 100): Promise<{ ok: true; rows: ActivityRow[] } | { ok: false; error: string }> { /* select id, action, actor, inbox_item_id, created_at, detail, inbox_items ( dashboard_contacts ( display_name ) ); map; reversible = action in {handled,followed,completed,dismissed} */ }
```
> Resolve `actorName` from the operator id via the existing operator-name lookup if one exists (grep for how `handled_by`/operator names are displayed elsewhere); else show the raw actor/email. Confirm the FK embed path `inbox_items ( dashboard_contacts ( display_name ) )` against the schema.

- [ ] **Step 3: `reverseItemState`** in `store.ts` — apply `inverseOf` + log a `reversed` activity row:
```ts
import { inverseOf, type ReverseAction } from './lifecycle';
import { removeSuppressedSenders } from './suppression';

export async function reverseItemState(activityId: string, operatorId: string, now: Date): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data: act } = await sb.from('dashboard_activity').select('action, inbox_item_id, detail').eq('id', activityId).maybeSingle();
  if (!act) return { ok: false, error: 'Activity entry not found' };
  const a = act as { action: string; inbox_item_id: string | null; detail: { from?: { status?: string; wasFollowed?: boolean } } | null };
  if (!a.inbox_item_id) return { ok: false, error: 'Entry has no item to reverse' };
  const reversible: ReverseAction[] = ['handled', 'followed', 'completed', 'dismissed'];
  if (!reversible.includes(a.action as ReverseAction)) return { ok: false, error: 'This entry cannot be reversed' };
  const t = inverseOf(a.action as ReverseAction, a.detail?.from as { status?: import('./types').InboxStatus } | undefined);
  const upd: Record<string, unknown> = { updated_at: now.toISOString() };
  if (t.status) upd.status = t.status;
  if (t.clearFollowed) upd.followed_up_at = null;
  const { error } = await sb.from('inbox_items').update(upd).eq('id', a.inbox_item_id);
  if (error) return { ok: false, error: error.message };
  if (t.unsuppress) {
    const { data: c } = await sb.from('inbox_items').select('dashboard_contacts ( primary_email, primary_phone )').eq('id', a.inbox_item_id).maybeSingle();
    const dc = (c as { dashboard_contacts?: { primary_email?: string | null; primary_phone?: string | null } } | null)?.dashboard_contacts;
    if (dc) await removeSuppressedSenders([dc.primary_email ?? null, dc.primary_phone ?? null]);
  }
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'reversed', inbox_item_id: a.inbox_item_id, detail: { reversed_action: a.action } });
  return { ok: true };
}
```

- [ ] **Step 4:** `npx tsc --noEmit` → 0; `npm run lint` → 0; `npx vitest run src/lib/dashboard/inbox/` (existing pass).
- [ ] **Step 5: Commit** — `git add src/lib/dashboard/inbox/store.ts src/lib/dashboard/inbox/suppression.ts && git commit -m "feat(#58): activity list + reverse-to-prior-state + un-suppress"`

---

## Task 8: Audit log view + Reverse route

**Files:** Create `src/app/api/dashboard/activity/reverse/route.ts`, `src/components/dashboard/inbox/ActivityLog.tsx`, `src/app/inbox/activity/page.tsx`

- [ ] **Step 1: Reverse route** — `POST /api/dashboard/activity/reverse` body `{ activityId }`. Mirror the dashboard route idiom (operator-gated, `isUuid(activityId)`, rate-limit `'dashboard-reverse'`), call `reverseItemState(activityId, operator.id, new Date())`, return `{ ok }` or the error.

- [ ] **Step 2: `ActivityLog.tsx`** (client) — props `{ initialRows: ActivityRow[] }`. Render a newest-first list: **when · who · action · customer**. Each `reversible` row gets a **"Reverse"** button → `POST /api/dashboard/activity/reverse { activityId: row.id }`; on `ok`, mark the row "reversed" inline (optimistic) and disable the button; on error show it inline. Match the existing client-fetch/optimistic idiom in `InboxList.tsx`.

- [ ] **Step 3: `activity/page.tsx`** (server) — operator-gated; `listActivity()`; render `<OperatorShell active="inbox">` with a heading "Activity / Audit log" and `<ActivityLog initialRows={…} />` (mirror `src/app/inbox/page.tsx`'s shell + not-provisioned fallback).

- [ ] **Step 4:** `npx tsc --noEmit` → 0; `npm run lint` → 0; `npx vitest run` (full suite green).
- [ ] **Step 5: Commit** — `git add src/app/api/dashboard/activity/reverse/route.ts src/components/dashboard/inbox/ActivityLog.tsx src/app/inbox/activity/page.tsx && git commit -m "feat(#58): audit-log view + per-entry Reverse"`

---

## Final verification
- [ ] `npx tsc --noEmit` (0) · `npm run lint` (0 errors) · `npx vitest run` (all pass, incl. new `lifecycle` + `reducer` completed tests).
- [ ] Adversarial review (customer-state machine + reverse + un-suppress + the new migration): focus on (a) can an item land in the WRONG bucket or two buckets at once; (b) does Reverse ever restore a wrong state or fail to un-suppress; (c) completed-reopen vs same-message re-ingest; (d) the stale flag threshold boundary + settings clamp; (e) any board that leaks a completed/dismissed item.
- [ ] Preview check: handled item shows under In-the-works→Handled and goes amber after the configured days; Mark completed drops it off + into Completed (N); the activity log lists actions and Reverse restores state (un-"Not a lead" un-hides the sender's next message); settings days change moves the amber threshold.

## Spec coverage self-check
- In-the-works (two groups, stale nudge) → Tasks 1,3,6. New Completed state + reopen → Tasks 2,3,4,6. Configurable threshold → Tasks 1,5,6. Audit log + reverse (+un-suppress) → Tasks 1,3,7,8. Handled-stays-visible → Tasks 3,6 (no handled→hidden path remains). Migration applied before merge → Task 2 note.
