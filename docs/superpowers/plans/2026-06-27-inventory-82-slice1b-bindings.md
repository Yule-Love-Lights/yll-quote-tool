# Inventory #82 — Slice 1b: Bindings + Overrides — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let staff connect the design/quote tool's vocabulary to real Thunder SKUs (bindings + clip rules), and curate the catalog (hide unused categories, lock sold-out items) — the bridge that makes the materials engine (Slice 2) possible.

**Architecture:** All under `/inventory` (Naldo's area — NOT `/settings`, which is Jason's). Bindings/clipRules live in the existing `app_settings` table under new keys (`bindings`, `clipRules`) via a **parallel** `src/lib/inventory/bindings.ts` (no edits to Jason's `appSettings.ts`). Category-hide + item-lock persist on `inventory_catalog` (the `yll_category`/`locked` columns from 1a). UI mirrors the #32 Settings pattern ('use client' page + `useEffect` fetch + `save()` PUT).

**Tech Stack:** Next.js App Router (`runtime='nodejs'`), Supabase service client, TypeScript, Vitest. No new deps. No migration (1a's table + `app_settings` already exist).

**Sub-slices (each its own PR):**
- **1b-i — Bindings data layer + API** (this plan, detailed below). Pure backend; foundation.
- **1b-ii — Binding editor UI** (`/inventory/bindings`). Outlined; needs UX answers.
- **1b-iii — Catalog overrides UI** (`/inventory/overrides`: category show/hide + item lock). Outlined.

---

## SLICE 1b-i — Bindings data layer + API (build now)

### File Structure
- `src/lib/inventory/bindings.ts` — **Create.** `InventoryBindings` types, pure validators (`normalizeBindings`, `normalizeClipRules`), `getInventoryBindings()` / `putInventoryBindings()` (read/write the `bindings`+`clipRules` `app_settings` keys via the service client). Mirrors `src/lib/appSettings.ts` but separate.
- `src/lib/inventory/bindings.test.ts` — **Create.** Vitest unit tests for the pure validators.
- `src/app/api/inventory/bindings/route.ts` — **Create.** `GET` (current bindings) + `PUT` (validate→save). Mirrors `src/app/api/settings/route.ts`.

No migration (reuses the `app_settings` table from #32).

### Task 1: Bindings data layer + validators (TDD)

**Files:**
- Test: `src/lib/inventory/bindings.test.ts`
- Create: `src/lib/inventory/bindings.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/bindings.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeBindings, normalizeClipRules } from './bindings';

describe('normalizeBindings', () => {
  it('keeps string SKU values and trims them', () => {
    expect(normalizeBindings({ 'bulb:warm-white:c9': ' 20009-SPK ' })).toEqual({
      'bulb:warm-white:c9': '20009-SPK',
    });
  });

  it('keeps bundle (object) values with trimmed string SKUs', () => {
    expect(normalizeBindings({ 'spritzer:24': { spritzerSku: '23099', stakeMetalSku: ' 14355 ' } })).toEqual({
      'spritzer:24': { spritzerSku: '23099', stakeMetalSku: '14355' },
    });
  });

  it('drops empty strings, non-string/non-object values, and empty bundles', () => {
    expect(normalizeBindings({ a: '', b: 5, c: null, d: {}, e: { x: '' }, f: '14147' })).toEqual({
      f: '14147',
    });
  });

  it('returns null for a non-object input', () => {
    expect(normalizeBindings(null)).toBeNull();
    expect(normalizeBindings('x')).toBeNull();
    expect(normalizeBindings([1, 2])).toBeNull();
  });
});

describe('normalizeClipRules', () => {
  it('keeps a rule object with a string sku and numeric spacing', () => {
    expect(normalizeClipRules({ gutter: { sku: '14147', perFt: 1 } })).toEqual({
      gutter: { sku: '14147', perFt: 1 },
    });
  });

  it('drops non-object rules, empty rules, and bad field values', () => {
    expect(
      normalizeClipRules({ gutter: { sku: '14147', perFt: 'x' }, peak: 'nope', ridge: {} }),
    ).toEqual({ gutter: { sku: '14147' } });
  });

  it('returns null for a non-object input', () => {
    expect(normalizeClipRules(42)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx vitest run src/lib/inventory/bindings.test.ts`
Expected: FAIL — `Cannot find module './bindings'`.

- [ ] **Step 3: Write the data layer**

```ts
// src/lib/inventory/bindings.ts
// Inventory bindings + clip rules (#82 Slice 1b). Stored in the existing
// app_settings table under the keys `bindings` and `clipRules` — a PARALLEL of
// src/lib/appSettings.ts (which owns colors/render/defaults), deliberately NOT
// edited so the two domains stay decoupled. Service-role only.
//
// `bindings` maps a design-concept key → a Thunder SKU, or → a small bundle
// object (e.g. a spritzer → {spritzerSku, stakeMetalSku}). The exact concept-key
// vocabulary is owned by the binding UI (1b-ii) + the materials engine (Slice 2);
// this layer stores/validates the generic shape so it never has to change as the
// vocabulary grows.

import { getSupabaseServiceClient } from '../supabase';

export type BindingValue = string | Record<string, string>;
export type Bindings = Record<string, BindingValue>;
export type ClipRule = Record<string, string | number>; // e.g. { sku, perFt }
export type ClipRules = Record<string, ClipRule>;        // roof-feature → rule

export type InventoryBindings = { bindings: Bindings; clipRules: ClipRules };

export const EMPTY_INVENTORY_BINDINGS: InventoryBindings = { bindings: {}, clipRules: {} };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// concept-key → SKU string, or → {field: sku} bundle. Drops empties/garbage.
export function normalizeBindings(v: unknown): Bindings | null {
  if (!isPlainObject(v)) return null;
  const out: Bindings = {};
  for (const [key, val] of Object.entries(v)) {
    if (typeof val === 'string') {
      const t = val.trim();
      if (t) out[key] = t;
    } else if (isPlainObject(val)) {
      const inner: Record<string, string> = {};
      for (const [ik, iv] of Object.entries(val)) {
        if (typeof iv === 'string' && iv.trim()) inner[ik] = iv.trim();
      }
      if (Object.keys(inner).length > 0) out[key] = inner;
    }
    // anything else (number/null/array) is dropped
  }
  return out;
}

// roof-feature → { sku: string, perFt?: number, ... }. Drops bad fields/rules.
export function normalizeClipRules(v: unknown): ClipRules | null {
  if (!isPlainObject(v)) return null;
  const out: ClipRules = {};
  for (const [feature, rule] of Object.entries(v)) {
    if (!isPlainObject(rule)) continue;
    const clean: ClipRule = {};
    for (const [rk, rv] of Object.entries(rule)) {
      if (typeof rv === 'string' && rv.trim()) clean[rk] = rv.trim();
      else if (typeof rv === 'number' && Number.isFinite(rv)) clean[rk] = rv;
    }
    if (Object.keys(clean).length > 0) out[feature] = clean;
  }
  return out;
}

export async function getInventoryBindings(): Promise<InventoryBindings> {
  const sb = getSupabaseServiceClient();
  if (!sb) return EMPTY_INVENTORY_BINDINGS;
  const { data, error } = await sb
    .from('app_settings')
    .select('key, value')
    .in('key', ['bindings', 'clipRules']);
  if (error) {
    console.error('[bindings] read failed:', error.message);
    return EMPTY_INVENTORY_BINDINGS;
  }
  const map = new Map<string, unknown>((data ?? []).map((r) => [r.key as string, r.value]));
  return {
    bindings: normalizeBindings(map.get('bindings')) ?? {},
    clipRules: normalizeClipRules(map.get('clipRules')) ?? {},
  };
}

// Upsert only the provided keys (each validated; malformed → skipped).
export async function putInventoryBindings(
  patch: Partial<InventoryBindings>,
): Promise<InventoryBindings> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const rows: { key: string; value: unknown }[] = [];
  if (patch.bindings !== undefined) {
    const clean = normalizeBindings(patch.bindings);
    if (clean) rows.push({ key: 'bindings', value: clean });
  }
  if (patch.clipRules !== undefined) {
    const clean = normalizeClipRules(patch.clipRules);
    if (clean) rows.push({ key: 'clipRules', value: clean });
  }
  if (rows.length > 0) {
    const { error } = await sb.from('app_settings').upsert(rows, { onConflict: 'key' });
    if (error) {
      console.error('[bindings] write failed:', error.message);
      throw new Error(error.message);
    }
  }
  return getInventoryBindings();
}
```

- [ ] **Step 4: Run the test, verify it PASSES** (7 tests)

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx vitest run src/lib/inventory/bindings.test.ts`
Then `npx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/bindings.ts src/lib/inventory/bindings.test.ts
git commit -m "feat(#82): inventory bindings data layer + validators (Slice 1b-i)"
```

### Task 2: Bindings API route

**Files:**
- Create: `src/app/api/inventory/bindings/route.ts`

- [ ] **Step 1: Write the route**

```ts
// src/app/api/inventory/bindings/route.ts
// Inventory bindings API (#82 Slice 1b). GET returns current bindings+clipRules;
// PUT validates then saves the provided keys. Service-role only — mirrors
// src/app/api/settings/route.ts. Validates BEFORE write (rejects malformed 400).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getInventoryBindings,
  putInventoryBindings,
  normalizeBindings,
  normalizeClipRules,
} from '@/lib/inventory/bindings';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await getInventoryBindings());
  } catch (err) {
    console.error('[api/inventory/bindings] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load bindings' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }
  const { bindings, clipRules } = body as Record<string, unknown>;
  if (bindings === undefined && clipRules === undefined) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }
  if (bindings !== undefined && normalizeBindings(bindings) === null) {
    return NextResponse.json({ error: 'Invalid bindings' }, { status: 400 });
  }
  if (clipRules !== undefined && normalizeClipRules(clipRules) === null) {
    return NextResponse.json({ error: 'Invalid clipRules' }, { status: 400 });
  }
  try {
    const result = await putInventoryBindings({
      bindings: bindings as never,
      clipRules: clipRules as never,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/inventory/bindings] PUT failed:', err);
    return NextResponse.json({ error: 'Failed to save bindings' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Gates + commit**

```bash
npx tsc --noEmit
npm run lint
git add src/app/api/inventory/bindings/route.ts
git commit -m "feat(#82): inventory bindings GET/PUT API route (Slice 1b-i)"
```

### Task 3: Full gate suite (verify the slice)
- [ ] Run `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx tsc --noEmit && npm run lint && npx vitest run`. Expected: tsc clean · lint 0 errors · all tests pass (incl. the 7 new binding tests). The route is auto-gated by the #81 middleware (not in the public allowlist).

### 1b-i Self-Review
- **Spec coverage:** bindings + clipRules storage (spec §5.2) ✓; service-role read/write ✓; validate-before-write ✓; no appSettings.ts edit ✓; no migration (reuses app_settings) ✓.
- **Type consistency:** `normalizeBindings`/`normalizeClipRules`/`getInventoryBindings`/`putInventoryBindings` names match across data layer, tests, and route. `InventoryBindings = { bindings, clipRules }` is the GET/PUT contract.

---

## SLICE 1b-ii — Binding editor UI (outline — needs UX answers)
`/inventory/bindings` page ('use client', `<OperatorShell active="inventory">` + a new `InventorySubNav`), mirroring `src/app/settings/page.tsx`: `useEffect` loads `/api/inventory/bindings` + `/api/inventory/catalog`; tabs per design-concept group (bulb colors, clips/roof-features, wreath, garland, spritzer, mini/tree); each row maps a concept-key → a **SKU picker** populated from the catalog; `save()` PUTs to `/api/inventory/bindings`. Reuse `src/components/settings/SettingsField.tsx` + `DefaultsTabPanel.tsx` patterns.
- **⚠️ UX to confirm with Naldo:** (1) SKU picker = a plain `<select>` (simple) **or** a searchable type-ahead (831 items)? (2) group/label the concept-keys how Naldo expects to see them.

## SLICE 1b-iii — Catalog overrides UI (outline)
`/inventory/overrides` page: (a) **category show/hide** toggles (list distinct catalog categories with a visible/hidden checkbox → persists to a `hiddenCategories` app_settings key or a per-category flag); (b) **item lock** list (catalog rows with a sold-out `locked` toggle → PATCH `inventory_catalog.locked`); optionally edit `yll_category`. Needs a small `PATCH /api/inventory/catalog` (update locked/yll_category by sku) — a 1b-iii task.
- **⚠️ UX to confirm:** item-lock list = paginated, searchable, or full 831-row table (virtualized)?

> Related: design spec `docs/superpowers/specs/2026-06-27-inventory-82-design.md`; Slice 1a (catalog) merged in PR #174.
