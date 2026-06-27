# Inventory #82 — Slice 1a: Supplier Catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import YLL's full Thunder Lighting supplier catalog into the app as the foundational `inventory_catalog` table, with a pure CSV parser, a data layer, and a GET/POST API route — so bindings (1b) and on-hand stock (1c) can reference real SKUs.

**Architecture:** A new `src/lib/inventory/` domain dir mirroring `src/lib/dashboard/`. A pure, fully-unit-tested CSV parser (`parseThunderCsv`) turns the Thunder sheet into rows; a thin Supabase data layer (`catalog.ts`, service-role, mirroring `src/lib/quotes.ts`) upserts/reads them; an API route (`/api/inventory/catalog`, mirroring `/api/settings`) lists and imports. Re-import preserves operator edits by writing only vendor-sourced columns (never `yll_category` / `locked`).

**Tech Stack:** Next.js (App Router, `runtime = 'nodejs'`), Supabase (`@supabase/supabase-js` service-role client), TypeScript, Vitest. No new dependencies (CSV parsing is hand-rolled to avoid editing the SHARED `package.json`).

**Prereqs for execution:** worktree `naldo/inventory` (outside OneDrive); run `npm install` once (per-worktree `node_modules`); `.env.local` has `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Gates: `npx tsc --noEmit` · `npm run lint` · `npm test`. PR-not-master; a human merges.

**Scope note:** This is Slice **1a** of the inventory Section. **1b** (binding settings page + `clipRules`/`bindings` keys + category toggles + item lock) and **1c** (on-hand table + `/inventory` UI) follow as their own plans. Catalog is first because bindings and on-hand both reference `inventory_catalog.sku`.

---

## File Structure

- `migrations/2026-06-27-inventory-catalog.sql` — **Create.** The `inventory_catalog` table (idempotent, RLS-off, `updated_at` trigger). Applied via the Supabase browser SQL editor (service-role can't run DDL).
- `src/lib/inventory/parseThunderCsv.ts` — **Create.** Pure parser: CSV text → `ParsedCatalogItem[]`. Hand-rolled quote-aware CSV splitting; skips header + section-divider/note rows; cleans `$`/whitespace/`xx`. The logic-heavy, fully-tested unit.
- `src/lib/inventory/parseThunderCsv.test.ts` — **Create.** Vitest unit tests for the parser.
- `src/lib/inventory/catalog.ts` — **Create.** Data layer: `CatalogItem` type, `listCatalog()`, `upsertCatalogItems()`. Mirrors `src/lib/quotes.ts` (service client, guard-null, swallow-to-[]).
- `src/app/api/inventory/catalog/route.ts` — **Create.** `GET` (list) + `POST` (import `{ csv }` → parse → upsert). Mirrors `src/app/api/settings/route.ts`.

No edits to any SHARED or editor-core file. The only DB change is one new table.

---

## Task 1: Migration — `inventory_catalog` table

**Files:**
- Create: `migrations/2026-06-27-inventory-catalog.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- =====================================================================
-- inventory_catalog — full supplier (Thunder Lighting) catalog (#82 Slice 1a).
-- Idempotent; safe to re-run. Paste into the Supabase SQL Editor and Run.
--
-- The raw vendor catalog, imported from Thunder's CSV. Vendor-sourced columns
-- (name, category, color, size, wholesale_cost, needs_adapter, bag_ct, case_ct)
-- are re-seeded on every import; OPERATOR columns are never touched by import:
--   yll_category → operator's re-grouping override (null = use vendor category)
--   locked       → operator's sold-out / unobtainable flag
--
-- Reached only via the service-role client (server API routes), so RLS is
-- disabled to match app_settings / designs / quotes.
-- =====================================================================

create table if not exists inventory_catalog (
  sku            text primary key,
  name           text not null,
  category       text not null default 'Uncategorized',
  yll_category   text,
  color          text,
  size           text,
  wholesale_cost numeric,
  needs_adapter  boolean not null default false,
  bag_ct         integer,
  case_ct        integer,
  locked         boolean not null default false,
  updated_at     timestamptz not null default now()
);

alter table inventory_catalog disable row level security;

-- Keep updated_at fresh on every write (mirrors app_settings).
create or replace function inventory_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists inventory_catalog_updated_at_trigger on inventory_catalog;
create trigger inventory_catalog_updated_at_trigger
  before update on inventory_catalog
  for each row execute function inventory_set_updated_at();
```

- [ ] **Step 2: Commit**

```bash
git add migrations/2026-06-27-inventory-catalog.sql
git commit -m "feat(#82): inventory_catalog table migration (Slice 1a)"
```

> The migration is **applied to live Supabase by a human** (browser SQL editor) — see Task 5. It is not run by code (the service role can't do DDL).

---

## Task 2: Pure CSV parser (TDD)

**Files:**
- Test: `src/lib/inventory/parseThunderCsv.test.ts`
- Create: `src/lib/inventory/parseThunderCsv.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/parseThunderCsv.test.ts
import { describe, it, expect } from 'vitest';
import { parseThunderCsv, type ParsedCatalogItem } from './parseThunderCsv';

// A trimmed slice of the real Thunder sheet: header, two section dividers, a
// normal bulb row, a hardware (clip) row, a quoted wreath row, and a trailing
// note row (no SKU).
const SAMPLE = [
  'SKU, Wholesale , Retail 26 ,ProductName, Category  , Wattage , Voltage ,Color,Spaceing / Size ,Adapter Needed,Bag CT,Case CT, BULk BUY  , Bulk Buy Qty  ,,',
  ',,,BULBS,,,,,,,,,,,,',
  ',,,Faceted C9 Bulbs ,,,,,,,,,,,,',
  '20009-SPK, $ 0.59 , $ 1.24 ,C9 Sun Warm White Faceted Spk,Bulb ,  0.80 ,120,Sun Warm White 2600K,C9 / E17,xx,25,500, $ 0.52 ,4000,,',
  '14147, $ 0.23 , $ 0.32 ,C9 Flex Clip- White,Hardware ,xx,xx,White ,xx,xx,100,800, $ 0.20 ,800,,',
  '23999, $ 4.29 , $ 5.99 ,C9 LED Glitzer RGBWW,RGB,xx,xx,Rgb,E17,YES,25,500,,,,',
  '50018-30, $ 52.99 , $ 73.99 ,"18"" Warm White Noble Wreath - HBL",Greenery ,0,120,Warm White ,"18""",xx,-2,6,,,,',
  ',,,,,,,,,,,,,,2026 Wholesale prices subject to change.',
].join('\n');

describe('parseThunderCsv', () => {
  it('skips the header, section dividers, and note rows (no SKU)', () => {
    const items = parseThunderCsv(SAMPLE);
    expect(items.map((i) => i.sku)).toEqual(['20009-SPK', '14147', '23999', '50018-30']);
  });

  it('parses a normal bulb row into clean fields', () => {
    const bulb = parseThunderCsv(SAMPLE).find((i) => i.sku === '20009-SPK') as ParsedCatalogItem;
    expect(bulb).toMatchObject({
      sku: '20009-SPK',
      name: 'C9 Sun Warm White Faceted Spk',
      category: 'Bulb',
      color: 'Sun Warm White 2600K',
      size: 'C9 / E17',
      wholesale_cost: 0.59,
      needs_adapter: false,
      bag_ct: 25,
      case_ct: 500,
    });
  });

  it('reads needs_adapter from YES vs xx', () => {
    const rgb = parseThunderCsv(SAMPLE).find((i) => i.sku === '23999')!;
    const clip = parseThunderCsv(SAMPLE).find((i) => i.sku === '14147')!;
    expect(rgb.needs_adapter).toBe(true);
    expect(clip.needs_adapter).toBe(false);
  });

  it('handles quoted fields with embedded inch-marks and commas', () => {
    const wreath = parseThunderCsv(SAMPLE).find((i) => i.sku === '50018-30')!;
    expect(wreath.name).toBe('18" Warm White Noble Wreath - HBL');
    expect(wreath.size).toBe('18"');
    expect(wreath.category).toBe('Greenery');
    expect(wreath.bag_ct).toBe(-2); // imported faithfully, operator fixes later
  });

  it('turns empty color/size into null', () => {
    const clip = parseThunderCsv(SAMPLE).find((i) => i.sku === '14147')!;
    expect(clip.size).toBeNull();   // "xx" in the size column → null
    expect(clip.color).toBe('White');
  });

  it('returns [] for empty input', () => {
    expect(parseThunderCsv('')).toEqual([]);
    expect(parseThunderCsv('SKU,Wholesale\n')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/inventory/parseThunderCsv.test.ts`
Expected: FAIL — `Cannot find module './parseThunderCsv'`.

- [ ] **Step 3: Write the parser**

```ts
// src/lib/inventory/parseThunderCsv.ts
// Pure parser for the Thunder Lighting wholesale CSV (#82 Slice 1a). No deps —
// the sheet quotes fields containing commas / inch-marks (e.g. "18"" Wreath"),
// so we hand-roll RFC4180-style quote-aware splitting.

export type ParsedCatalogItem = {
  sku: string;
  name: string;
  category: string;
  color: string | null;
  size: string | null;
  wholesale_cost: number | null;
  needs_adapter: boolean;
  bag_ct: number | null;
  case_ct: number | null;
};

// Column order in the Thunder sheet (0-based):
// 0 SKU · 1 Wholesale · 2 Retail · 3 ProductName · 4 Category · 5 Wattage ·
// 6 Voltage · 7 Color · 8 Spacing/Size · 9 Adapter Needed · 10 Bag CT · 11 Case CT
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped ""
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function text(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length ? t : null;
}

function money(v: string | undefined): number | null {
  const n = parseFloat((v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function int(v: string | undefined): number | null {
  const cleaned = (v ?? '').replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseThunderCsv(csv: string): ParsedCatalogItem[] {
  const lines = csv.split(/\r?\n/);
  const out: ParsedCatalogItem[] = [];
  // Start at 1 to skip the header row.
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const f = splitCsvLine(raw);
    const sku = (f[0] ?? '').trim();
    if (!sku) continue; // section-divider + note rows carry no SKU
    const name = (f[3] ?? '').trim();
    if (!name) continue; // skip malformed rows defensively
    const sizeRaw = (f[8] ?? '').trim();
    out.push({
      sku,
      name,
      category: (f[4] ?? '').trim() || 'Uncategorized',
      color: text(f[7]),
      size: sizeRaw.toLowerCase() === 'xx' ? null : text(sizeRaw),
      wholesale_cost: money(f[1]),
      needs_adapter: /^yes$/i.test((f[9] ?? '').trim()),
      bag_ct: int(f[10]),
      case_ct: int(f[11]),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/inventory/parseThunderCsv.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/parseThunderCsv.ts src/lib/inventory/parseThunderCsv.test.ts
git commit -m "feat(#82): Thunder catalog CSV parser + tests (Slice 1a)"
```

---

## Task 3: Catalog data layer

**Files:**
- Create: `src/lib/inventory/catalog.ts`

- [ ] **Step 1: Write the data layer**

```ts
// src/lib/inventory/catalog.ts
// Supabase data layer for the supplier catalog (#82 Slice 1a). Service-role
// only (admin/server), mirroring src/lib/quotes.ts. Reads swallow errors to []
// so the page renders before the migration lands; writes throw.

import { getSupabaseServiceClient, getSupabaseClient } from '../supabase';
import type { ParsedCatalogItem } from './parseThunderCsv';

export type CatalogItem = ParsedCatalogItem & {
  yll_category: string | null; // operator override (1b); null → use `category`
  locked: boolean;             // operator sold-out flag (1b/1c)
};

const SELECT =
  'sku, name, category, yll_category, color, size, wholesale_cost, needs_adapter, bag_ct, case_ct, locked';

export async function listCatalog(): Promise<CatalogItem[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('inventory_catalog')
    .select(SELECT)
    .order('category', { ascending: true })
    .order('name', { ascending: true });
  if (error) {
    console.error('listCatalog error:', error);
    return [];
  }
  return (data ?? []) as CatalogItem[];
}

// Upsert ONLY vendor-sourced columns (the ParsedCatalogItem shape). yll_category
// and locked are intentionally absent from the payload, so a yearly re-import
// re-seeds prices/names without clobbering operator regrouping or sold-out flags.
export async function upsertCatalogItems(items: ParsedCatalogItem[]): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  if (items.length === 0) return 0;
  const { error, count } = await sb
    .from('inventory_catalog')
    .upsert(items, { onConflict: 'sku', count: 'exact' });
  if (error) throw new Error(`upsertCatalogItems: ${error.message}`);
  return count ?? items.length;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). This is the verification for the data layer — it's a thin Supabase wrapper exercised end-to-end by Task 5's smoke test.

- [ ] **Step 3: Commit**

```bash
git add src/lib/inventory/catalog.ts
git commit -m "feat(#82): inventory catalog data layer (Slice 1a)"
```

---

## Task 4: API route — `GET`/`POST /api/inventory/catalog`

**Files:**
- Create: `src/app/api/inventory/catalog/route.ts`

- [ ] **Step 1: Write the route**

```ts
// src/app/api/inventory/catalog/route.ts
// Catalog API (#82 Slice 1a). GET lists the catalog; POST imports it from a raw
// Thunder CSV string. Service-role only — mirrors src/app/api/settings/route.ts.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { listCatalog, upsertCatalogItems } from '@/lib/inventory/catalog';
import { parseThunderCsv } from '@/lib/inventory/parseThunderCsv';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await listCatalog());
  } catch (err) {
    console.error('[api/inventory/catalog] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load catalog' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const csv = (body as Record<string, unknown>)?.csv;
  if (typeof csv !== 'string' || !csv.trim()) {
    return NextResponse.json({ error: 'Body must include a non-empty `csv` string' }, { status: 400 });
  }
  try {
    const items = parseThunderCsv(csv);
    const imported = await upsertCatalogItems(items);
    return NextResponse.json({ parsed: items.length, imported });
  } catch (err) {
    console.error('[api/inventory/catalog] POST failed:', err);
    return NextResponse.json({ error: 'Failed to import catalog' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS (lint may show the repo's baseline warnings only — no new errors).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/inventory/catalog/route.ts
git commit -m "feat(#82): catalog GET/POST API route (Slice 1a)"
```

---

## Task 5: Apply the migration + import the real catalog + verify

**Files:** none (ops + smoke test).

- [ ] **Step 1: Apply the migration to live Supabase**

A human (Naldo) or Claude (Chrome extension) pastes `migrations/2026-06-27-inventory-catalog.sql` into the Supabase **SQL Editor** and runs it. Verify the table exists:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'inventory_catalog' order by ordinal_position;
```
Expected: the 12 columns from Task 1.

- [ ] **Step 2: Run the full gate suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: tsc clean · lint 0 new errors · all tests pass (incl. the 6 new parser tests).

- [ ] **Step 3: Import the real Thunder catalog (smoke test)**

Start the dev server (`npm run dev`), then POST the real CSV (Node 18+ has global `fetch`):

```bash
node -e "const fs=require('fs');const csv=fs.readFileSync(process.argv[1],'utf8');fetch('http://localhost:3000/api/inventory/catalog',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({csv})}).then(r=>r.json()).then(console.log)" "C:/Users/ebhdh/Downloads/2026 Thunder Lighting Spply Wholesale Price list.xlsx - Sheet1.csv"
```
Expected: `{ parsed: <N>, imported: <N> }` with N in the hundreds.

- [ ] **Step 4: Verify the catalog reads back**

```bash
curl http://localhost:3000/api/inventory/catalog
```
Expected: a JSON array; spot-check that `20009-SPK` (warm-white bulb), `14147` (Flex Clip), and `14159` (Ridge Clip) are present with their categories and bag/case counts. Confirm in Supabase that `locked` defaults to `false` and `yll_category` is `null`.

- [ ] **Step 5: (No code commit)** Record the import result. If `parsed` ≠ `imported`, investigate (likely a duplicate SKU in the sheet — the upsert dedups on `sku`, which is expected).

---

## Self-Review

**Spec coverage (Slice 1a = catalog):** `inventory_catalog` table ✓ (Task 1); full Thunder import via CSV parser ✓ (Tasks 2, 4, 5); editable category preserved across re-import via `yll_category` + vendor `category` split ✓ (Tasks 1, 3); `locked` sold-out flag column present (set by 1b/1c) ✓; data layer + API ✓ (Tasks 3, 4). Bindings (1b) and on-hand (1c) are explicitly out of this plan and will reference `inventory_catalog.sku`.

**Placeholder scan:** none — every code step has complete, runnable code; every run step has an exact command + expected output.

**Type consistency:** `ParsedCatalogItem` (parser, Task 2) is the upsert payload shape (Task 3 `upsertCatalogItems`) and is extended by `CatalogItem` (Task 3) with `yll_category` + `locked`. `parseThunderCsv` / `listCatalog` / `upsertCatalogItems` names match across Tasks 2–4 and the route (Task 4). The migration columns (Task 1) match the `CatalogItem` fields + `updated_at`.

---

## Follow-on plans (not in this plan)
- **Slice 1b — Binding settings:** new Settings sub-page editing `app_settings` `bindings` + `clipRules` keys (concept→SKU, category show/hide toggles, item lock), validators in `src/lib/appSettings.ts`, reuse `/api/settings`. Adds a "Import catalog" upload that POSTs to the Task 4 route.
- **Slice 1c — On-Hand stock:** `inventory_on_hand` table + `src/lib/inventory/onHand.ts` + `/inventory` page (replaces the stub) with qty/reorder/storage + manual salvage adjustments.
