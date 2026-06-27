# Inventory #82 — Slice 1c: On-Hand stock table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the `/inventory` Stock stub with the warehouse on-hand stock table — a curated list of stocked SKUs (qty · reorder point · location), inline instant-save. Spec: `docs/superpowers/specs/2026-06-27-inventory-82-slice1c-onhand.md`.

**Architecture:** New `inventory_on_hand` table (sku PK) + `onHand.ts` data layer + `/api/inventory/on-hand` (GET/PUT/DELETE) + the `/inventory` Stock page (a thin server wrapper around a new client `OnHandStock` component). Reuses `SkuPicker` + `searchCatalog` + the overrides instant-save pattern. Naldo's area, zero relay.

**Tech Stack:** Next.js App Router, Supabase service client, TypeScript, Vitest, Tailwind. No new deps.

**Worktree/branch:** `C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory`, branch `naldo/inventory-1c-onhand` (off current master).

---

### Task 1: Migration

**Files:** Create `migrations/2026-06-27-inventory-on-hand.sql`

- [ ] **Step 1: Write the migration**

```sql
-- =====================================================================
-- inventory_on_hand — curated warehouse stock list (#82 Slice 1c).
-- One row per stocked SKU. `sku` logically refs inventory_catalog.sku (the app
-- only adds SKUs picked from the catalog). RLS-disabled to match inventory_catalog;
-- reuses the inventory_set_updated_at() trigger fn from the catalog migration.
-- Idempotent; safe to re-run. Paste into the Supabase SQL Editor and Run.
-- =====================================================================
create table if not exists inventory_on_hand (
  sku              text primary key,
  on_hand_qty      integer not null default 0,
  reorder_point    integer not null default 0,
  storage_location text,
  updated_at       timestamptz not null default now()
);

alter table inventory_on_hand disable row level security;

drop trigger if exists inventory_on_hand_updated_at_trigger on inventory_on_hand;
create trigger inventory_on_hand_updated_at_trigger
  before update on inventory_on_hand
  for each row execute function inventory_set_updated_at();
```

- [ ] **Step 2: Commit** (migration applied to prod separately via the SQL editor by the controller)

```bash
git add migrations/2026-06-27-inventory-on-hand.sql
git commit -m "feat(#82): inventory_on_hand migration (Slice 1c)"
```

---

### Task 2: Data layer (TDD)

**Files:** Test `src/lib/inventory/onHand.test.ts` · Create `src/lib/inventory/onHand.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/onHand.test.ts
import { describe, it, expect } from 'vitest';
import { toQty } from './onHand';

describe('toQty', () => {
  it('clamps to a non-negative integer', () => {
    expect(toQty(5)).toBe(5);
    expect(toQty('12')).toBe(12);
    expect(toQty(3.9)).toBe(3);
    expect(toQty(-4)).toBe(0);
    expect(toQty('abc')).toBe(0);
    expect(toQty(null)).toBe(0);
    expect(toQty(undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify FAIL** — `npx vitest run src/lib/inventory/onHand.test.ts` → `Cannot find module './onHand'`.

- [ ] **Step 3: Write the data layer**

```ts
// src/lib/inventory/onHand.ts
// Curated warehouse stock list (#82 Slice 1c). Service-role for writes; reads
// swallow to [] (mirrors catalog.ts). One row per stocked SKU.

import { getSupabaseServiceClient, getSupabaseClient } from '../supabase';

export type OnHandRow = {
  sku: string;
  on_hand_qty: number;
  reorder_point: number;
  storage_location: string | null;
};

const SELECT = 'sku, on_hand_qty, reorder_point, storage_location';

// Non-negative integer (counts + reorder points can't be negative/fractional).
export function toQty(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export async function listOnHand(): Promise<OnHandRow[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('inventory_on_hand')
    .select(SELECT)
    .order('sku', { ascending: true });
  if (error) {
    console.error('listOnHand error:', error);
    return [];
  }
  return (data ?? []) as OnHandRow[];
}

// Upsert one row by sku. Only provided fields are written; a bare { sku } adds a
// row at the DB defaults (qty 0) without clobbering an existing one.
export async function upsertOnHand(row: {
  sku: string;
  on_hand_qty?: number;
  reorder_point?: number;
  storage_location?: string | null;
}): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const payload: Record<string, unknown> = { sku: row.sku };
  if (row.on_hand_qty !== undefined) payload.on_hand_qty = toQty(row.on_hand_qty);
  if (row.reorder_point !== undefined) payload.reorder_point = toQty(row.reorder_point);
  if (row.storage_location !== undefined) {
    payload.storage_location =
      typeof row.storage_location === 'string' && row.storage_location.trim()
        ? row.storage_location.trim()
        : null;
  }
  const { error } = await sb.from('inventory_on_hand').upsert(payload, { onConflict: 'sku' });
  if (error) throw new Error(`upsertOnHand: ${error.message}`);
}

export async function deleteOnHand(sku: string): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const { error } = await sb.from('inventory_on_hand').delete().eq('sku', sku);
  if (error) throw new Error(`deleteOnHand: ${error.message}`);
}
```

- [ ] **Step 4: Run it, verify PASS** + `npx tsc --noEmit`. Commit.

```bash
git add src/lib/inventory/onHand.ts src/lib/inventory/onHand.test.ts
git commit -m "feat(#82): on-hand stock data layer (Slice 1c)"
```

---

### Task 3: API route

**Files:** Create `src/app/api/inventory/on-hand/route.ts`

- [ ] **Step 1: Write the route**

```ts
// src/app/api/inventory/on-hand/route.ts
// On-hand stock API (#82 Slice 1c). GET lists; PUT adds/edits one row (upsert by
// sku); DELETE removes from the list. Service-role only — mirrors the other
// /api/inventory routes.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { listOnHand, upsertOnHand, deleteOnHand } from '@/lib/inventory/onHand';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await listOnHand());
  } catch (err) {
    console.error('[api/inventory/on-hand] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load stock' }, { status: 500 });
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
  const { sku, on_hand_qty, reorder_point, storage_location } = (body ?? {}) as Record<string, unknown>;
  if (typeof sku !== 'string' || !sku.trim()) {
    return NextResponse.json({ error: 'Body must include a `sku` string' }, { status: 400 });
  }
  try {
    await upsertOnHand({
      sku: sku.trim(),
      on_hand_qty: on_hand_qty as number | undefined,
      reorder_point: reorder_point as number | undefined,
      storage_location: storage_location as string | null | undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/inventory/on-hand] PUT failed:', err);
    return NextResponse.json({ error: 'Failed to save stock row' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const sku = (body as Record<string, unknown>)?.sku;
  if (typeof sku !== 'string' || !sku.trim()) {
    return NextResponse.json({ error: 'Body must include a `sku` string' }, { status: 400 });
  }
  try {
    await deleteOnHand(sku.trim());
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/inventory/on-hand] DELETE failed:', err);
    return NextResponse.json({ error: 'Failed to remove stock row' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Gates + commit** — `npx tsc --noEmit && npm run lint`.

```bash
git add src/app/api/inventory/on-hand/route.ts
git commit -m "feat(#82): on-hand stock GET/PUT/DELETE API (Slice 1c)"
```

---

### Task 4: Stock page + OnHandStock component

**Files:** Create `src/components/inventory/OnHandStock.tsx` · Modify `src/app/inventory/page.tsx`

- [ ] **Step 1: Create `src/components/inventory/OnHandStock.tsx`**

```tsx
// src/components/inventory/OnHandStock.tsx
'use client';

// On-hand stock table (#82 Slice 1c): a curated list of stocked SKUs with an
// on-hand count, reorder point, and storage location. Add via the SKU picker;
// fields save inline on blur (optimistic; reload on error). Mirrors the overrides
// page's instant-save pattern.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import { SkuPicker } from '@/components/inventory/SkuPicker';
import type { CatalogItem } from '@/lib/inventory/catalog';
import type { OnHandRow } from '@/lib/inventory/onHand';

const effCat = (i: CatalogItem) => i.yll_category ?? i.category;
const isLow = (r: OnHandRow) => r.reorder_point > 0 && r.on_hand_qty <= r.reorder_point;
const clampInt = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

export function OnHandStock() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [rows, setRows] = useState<OnHandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [lowOnly, setLowOnly] = useState(false);

  const load = useCallback(async () => {
    const [oRes, cRes] = await Promise.all([
      fetch('/api/inventory/on-hand'),
      fetch('/api/inventory/catalog'),
    ]);
    if (oRes.ok) {
      const o = (await oRes.json()) as OnHandRow[];
      setRows(Array.isArray(o) ? o : []);
    }
    if (cRes.ok) {
      const c = (await cRes.json()) as CatalogItem[];
      setCatalog(Array.isArray(c) ? c : []);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch {
        // keep empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  const flash = (msg: string) => {
    setNote(msg);
    window.setTimeout(() => setNote(null), 1600);
  };

  const byId = useMemo(() => new Map(catalog.map((c) => [c.sku, c])), [catalog]);
  const stockedSkus = useMemo(() => new Set(rows.map((r) => r.sku)), [rows]);

  // PUT one or more fields; the optimistic local update is already applied. Reload on error.
  const persist = useCallback(
    async (sku: string, patch: Partial<OnHandRow>) => {
      try {
        const res = await fetch('/api/inventory/on-hand', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku, ...patch }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        flash('Saved.');
      } catch {
        flash('Save failed — reloading.');
        await load();
      }
    },
    [load],
  );

  const addItem = useCallback(
    async (sku: string) => {
      if (!sku) return;
      if (stockedSkus.has(sku)) {
        flash('Already in the list.');
        return;
      }
      setRows((rs) => [...rs, { sku, on_hand_qty: 0, reorder_point: 0, storage_location: null }]);
      await persist(sku, {});
    },
    [stockedSkus, persist],
  );

  const editLocal = (sku: string, patch: Partial<OnHandRow>) =>
    setRows((rs) => rs.map((r) => (r.sku === sku ? { ...r, ...patch } : r)));

  const remove = useCallback(
    async (sku: string) => {
      const prev = rows;
      setRows((rs) => rs.filter((r) => r.sku !== sku));
      try {
        const res = await fetch('/api/inventory/on-hand', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        flash('Removed.');
      } catch {
        setRows(prev);
        flash('Remove failed.');
      }
    },
    [rows],
  );

  const lowCount = useMemo(() => rows.filter(isLow).length, [rows]);
  const view = useMemo(() => {
    let list = lowOnly ? rows.filter(isLow) : rows;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const c = byId.get(r.sku);
        const name = (c?.name ?? '').toLowerCase();
        const cat = (c ? effCat(c) : '').toLowerCase();
        return r.sku.toLowerCase().includes(q) || name.includes(q) || cat.includes(q);
      });
    }
    return list;
  }, [rows, lowOnly, query, byId]);

  return (
    <OperatorShell active="inventory">
      <main className="max-w-4xl mx-auto">
        <InventorySubNav active="stock" />

        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">On-Hand Stock</h1>
            <p className="text-sm text-gray-500">
              What the warehouse has on hand. Add the SKUs you stock, then keep the counts current. Saves instantly.
            </p>
          </div>
          {note && <span role="status" className="text-sm text-gray-500">{note}</span>}
        </div>

        <div className="flex items-center gap-3 mb-5">
          <span className="text-sm text-gray-600 shrink-0">Add stocked item:</span>
          <SkuPicker
            catalog={catalog}
            value=""
            onChange={addItem}
            ariaLabel="Add a SKU to the stock list"
            placeholder="Search SKU or name to add…"
          />
        </div>

        <div className="flex items-center gap-3 mb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stocked items…"
            className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm"
            aria-label="Search stocked items"
          />
          <label className="flex items-center gap-1.5 text-sm text-gray-600 shrink-0">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="w-4 h-4" />
            Low stock only{lowCount > 0 ? ` (${lowCount})` : ''}
          </label>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 py-10 text-center">Loading stock…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-400 py-10 text-center">No stocked items yet — add one above.</p>
        ) : (
          <div className="border border-gray-100 rounded">
            <div className="flex items-center gap-3 px-3 py-2 text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
              <span className="w-24 shrink-0">SKU</span>
              <span className="flex-1">Item</span>
              <span className="w-20 text-center shrink-0">On hand</span>
              <span className="w-20 text-center shrink-0">Reorder</span>
              <span className="w-28 shrink-0">Location</span>
              <span className="w-14 shrink-0" />
            </div>
            {view.length === 0 ? (
              <p className="text-sm text-gray-400 px-3 py-6">No matches.</p>
            ) : (
              view.map((r) => {
                const c = byId.get(r.sku);
                const low = isLow(r);
                return (
                  <div key={r.sku} className={`flex items-center gap-3 px-3 py-2 border-b border-gray-100 ${low ? 'bg-amber-50' : ''}`}>
                    <span className="font-mono text-xs text-gray-500 w-24 shrink-0">{r.sku}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm text-gray-800" title={c?.name ?? ''}>
                        {c?.name ?? <span className="text-amber-600">⚠ not in catalog</span>}
                      </span>
                      <span className="block text-[11px] text-gray-400">
                        {c ? effCat(c) : ''}
                        {low && <span className="ml-2 text-amber-600 font-medium uppercase">Low</span>}
                      </span>
                    </span>
                    <input
                      type="number" min={0} aria-label={`${r.sku} on hand`}
                      value={r.on_hand_qty}
                      onChange={(e) => editLocal(r.sku, { on_hand_qty: clampInt(e.target.value) })}
                      onBlur={() => persist(r.sku, { on_hand_qty: r.on_hand_qty })}
                      className="w-20 border border-gray-300 rounded px-1.5 py-1 text-sm text-center shrink-0"
                    />
                    <input
                      type="number" min={0} aria-label={`${r.sku} reorder point`}
                      value={r.reorder_point}
                      onChange={(e) => editLocal(r.sku, { reorder_point: clampInt(e.target.value) })}
                      onBlur={() => persist(r.sku, { reorder_point: r.reorder_point })}
                      className="w-20 border border-gray-300 rounded px-1.5 py-1 text-sm text-center shrink-0"
                    />
                    <input
                      type="text" aria-label={`${r.sku} storage location`}
                      value={r.storage_location ?? ''}
                      onChange={(e) => editLocal(r.sku, { storage_location: e.target.value })}
                      onBlur={() => persist(r.sku, { storage_location: r.storage_location })}
                      placeholder="—"
                      className="w-28 border border-gray-300 rounded px-1.5 py-1 text-sm shrink-0"
                    />
                    <button
                      type="button"
                      onClick={() => remove(r.sku)}
                      className="w-14 text-xs text-gray-400 hover:text-red-600 shrink-0"
                      aria-label={`Remove ${r.sku}`}
                    >
                      Remove
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </main>
    </OperatorShell>
  );
}
```

- [ ] **Step 2: Replace `src/app/inventory/page.tsx`** with a thin server wrapper

```tsx
import { OnHandStock } from '@/components/inventory/OnHandStock';

export const metadata = { title: 'Inventory — Yule Love Lights' };

// The Inventory "Stock" page (#82 Slice 1c): the warehouse on-hand stock table.
// Thin server wrapper (keeps the page title) around the client table component.
export default function InventoryPage() {
  return <OnHandStock />;
}
```

- [ ] **Step 3: Gates** — `npx tsc --noEmit && npm run lint && npx vitest run`. Commit.

```bash
git add src/components/inventory/OnHandStock.tsx src/app/inventory/page.tsx
git commit -m "feat(#82): on-hand stock table page /inventory (Slice 1c)"
```

---

## Self-Review
- **Spec coverage:** curated list (add via picker) ✓; inline instant-save (blur) ✓; qty/reorder/location fields ✓; low-stock flag (reorder>0 && qty<=reorder) ✓; remove ✓; search + low-only filter ✓; migration sku-PK + RLS-disabled + reused trigger ✓; data layer mirrors catalog.ts ✓; API GET/PUT/DELETE service-role ✓; page = server wrapper + client component (keeps metadata) ✓.
- **Type consistency:** `OnHandRow`, `toQty`, `listOnHand`/`upsertOnHand`/`deleteOnHand`, `OnHandStock` match across data layer, route, test, and component. Reuses `CatalogItem`, `SkuPicker`.
- **Placeholders:** none.
