# Inventory #82 — Slice 1b-ii + 1b-iii: Binding editor UI + Catalog overrides UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two config screens that turn the merged 1b backend (bindings/clipRules data layer + catalog table) into something staff can actually use — `/inventory/bindings` (map each design concept → a Thunder SKU, plus roof-feature clip rules) and `/inventory/overrides` (hide unused categories + lock sold-out items).

**Architecture:** All under `/inventory` (Naldo's area — NOT `/settings`). Two separate PRs that share a new `InventorySubNav` + a searchable SKU combobox. The binding editor uses an **explicit Save** (a bounded config map → mirrors the #32 Settings page). The overrides page uses **instant-save** per toggle (an 831-row paginated list can't have one global Save). Bindings/clipRules persist in `app_settings` via the existing `getInventoryBindings`/`putInventoryBindings` (1b-i). Category-hide persists in `app_settings` under a new `hiddenCategories` key (a fn in `catalog.ts`, per the brief); per-item lock + regroup persist on `inventory_catalog` via a new `PATCH /api/inventory/catalog`.

**Tech Stack:** Next.js App Router (`'use client'` pages + `runtime='nodejs'` routes), Supabase service client, TypeScript, Vitest, Tailwind. No new deps.

**Concept vocabulary (locked, from spec §4/§6 + `sceneTypes.ts` + `colors.ts`):**

| Group | Key format | Value | Rows |
|---|---|---|---|
| Bulb colors | `bulb:<paletteId>:<bulbType>` | SKU string | 12 colors × 4 bulb types = 48 |
| Clip rules | (clipRules) `<feature>` → `{sku, perFt}` | SKU + clips/ft | 7 features |
| Wreath | `wreath:<QuoteWreathSize>:<Tier>` | SKU string | 6 × 2 = 12 |
| Garland | `garland:<QuoteGarlandLength>:<Tier>` | SKU string | 2 × 2 = 4 |
| Spritzer | `spritzer:<QuoteSpritzerSize>` | `{spritzerSku, stakeMetalSku}` bundle | 3 |
| Mini surfaces | `mini:<surface>:<wrapStyle>` | SKU string | 4 × 2 = 8 |

Palette ids: `warm-white, cool-white, cool-white-faceted, black, red, green, blue, orange, yellow, pink, purple, teal` (`DEFAULT_COLORS`). Bulb types: `c9, mini, permanent, bistro`. Wreath sizes: `24/30/36/48/60/72 noble`. Garland: `4.5ft/9ft`. Spritzer: `16/24/32`. Tiers: `bow` (Non-decorated) / `fullDecor` (Decorated). Mini surfaces: `tree/bush/column/railing`. Wrap: `canopy/trunk`. Clip features: `gutter/peak/side/ridge/pathway/flat/metal`.

**Branches:** 1b-ii on `naldo/inventory-1b-ii` (already created off `origin/master`). 1b-iii on `naldo/inventory-1b-iii`, branched off the 1b-ii tip (it reuses `InventorySubNav` + `searchCatalog`). A human merges each; AI never self-merges.

**Worktree:** `C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory` (outside OneDrive; has node_modules + .env.local pointing at prod Supabase, so the 831-SKU catalog is live for the picker).

---

# SLICE 1b-ii — Binding editor UI (PR #1)

### File Structure
- `src/lib/inventory/concepts.ts` — **Create.** Pure vocabulary + key builders + row generators. No React/Supabase deps. The single source of truth the UI (here) and the materials engine (Slice 2) both read.
- `src/lib/inventory/concepts.test.ts` — **Create.** Unit tests for the key builders + row counts.
- `src/lib/inventory/skuSearch.ts` — **Create.** Pure `searchCatalog(items, query, limit)` — filters the catalog by sku/name/category. Reused by the picker (1b-ii) and the overrides item list (1b-iii).
- `src/lib/inventory/skuSearch.test.ts` — **Create.** Unit tests.
- `src/components/inventory/SkuPicker.tsx` — **Create.** Searchable type-ahead combobox over the catalog; warns on locked/missing SKUs.
- `src/components/inventory/InventorySubNav.tsx` — **Create.** Sub-nav (Stock · Bindings) mirroring `SettingsSubNav`.
- `src/app/inventory/bindings/page.tsx` — **Create.** The binding editor page.
- `src/app/inventory/page.tsx` — **Modify.** Render `<InventorySubNav active="stock" />` above the existing "Coming soon" stub.

No migration. No backend change (reuses 1b-i `/api/inventory/bindings` + 1a `/api/inventory/catalog`).

---

### Task 1: Concept vocabulary module (TDD)

**Files:**
- Test: `src/lib/inventory/concepts.test.ts`
- Create: `src/lib/inventory/concepts.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/concepts.test.ts
import { describe, it, expect } from 'vitest';
import {
  bulbKey, wreathKey, garlandKey, spritzerKey, miniKey,
  bulbRows, wreathRows, garlandRows, miniRows, spritzerRows,
  CLIP_FEATURES,
} from './concepts';

describe('concept key builders', () => {
  it('builds namespaced keys', () => {
    expect(bulbKey('warm-white', 'c9')).toBe('bulb:warm-white:c9');
    expect(wreathKey('24noble', 'fullDecor')).toBe('wreath:24noble:fullDecor');
    expect(garlandKey('9ft', 'bow')).toBe('garland:9ft:bow');
    expect(spritzerKey('24')).toBe('spritzer:24');
    expect(miniKey('tree', 'canopy')).toBe('mini:tree:canopy');
  });
});

describe('concept row generators', () => {
  it('produces the full cartesian set per group', () => {
    expect(bulbRows()).toHaveLength(48); // 12 colors × 4 bulb types
    expect(wreathRows()).toHaveLength(12); // 6 sizes × 2 tiers
    expect(garlandRows()).toHaveLength(4); // 2 lengths × 2 tiers
    expect(miniRows()).toHaveLength(8); // 4 surfaces × 2 wraps
    expect(spritzerRows()).toHaveLength(3); // 3 sizes
    expect(CLIP_FEATURES).toHaveLength(7);
  });

  it('rows carry the right key + a human label', () => {
    const warmC9 = bulbRows().find((r) => r.key === 'bulb:warm-white:c9');
    expect(warmC9?.label).toBe('Warm White');
    const w = wreathRows().find((r) => r.key === 'wreath:24noble:bow');
    expect(w?.label).toContain('24');
    const s = spritzerRows()[0];
    expect(s.fields.map((f) => f.id)).toEqual(['spritzerSku', 'stakeMetalSku']);
  });
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx vitest run src/lib/inventory/concepts.test.ts`
Expected: FAIL — `Cannot find module './concepts'`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/inventory/concepts.ts
// The design-concept VOCABULARY the binding editor (#82 Slice 1b-ii) renders and
// the materials engine (Slice 2) will read. Pure data + key builders — no React,
// no Supabase. Each "concept" is one billable design attribute that maps to a
// real Thunder SKU (or a small bundle of SKUs). The binding map (app_settings
// `bindings`) is keyed by these strings; keeping the builders here the single
// source of truth means the UI and the engine never disagree on key format.

import type {
  BulbType,
  Tier,
  WrapStyle,
  QuoteWreathSize,
  QuoteGarlandLength,
  QuoteSpritzerSize,
} from '@/lib/design/sceneTypes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';

export type ConceptRow = { key: string; label: string };
export type BundleField = { id: string; label: string };
export type ConceptBundleRow = { key: string; label: string; fields: BundleField[] };

// ── bulb colors: paletteId × bulbType → one SKU ──────────────────────────────
export const BULB_TYPES: { id: BulbType; label: string }[] = [
  { id: 'c9', label: 'C9' },
  { id: 'mini', label: 'Mini' },
  { id: 'permanent', label: 'Permanent' },
  { id: 'bistro', label: 'Bistro' },
];
export const bulbKey = (paletteId: string, bulbType: BulbType) => `bulb:${paletteId}:${bulbType}`;
// Returns one group per bulb type so the UI can render a labelled section each.
export function bulbGroups(): { type: { id: BulbType; label: string }; rows: ConceptRow[] }[] {
  return BULB_TYPES.map((type) => ({
    type,
    rows: DEFAULT_COLORS.map((c) => ({ key: bulbKey(c.id, type.id), label: c.label })),
  }));
}
export const bulbRows = (): ConceptRow[] => bulbGroups().flatMap((g) => g.rows);

// ── tiers (shared by wreath + garland) ───────────────────────────────────────
export const TIERS: { id: Tier; label: string }[] = [
  { id: 'bow', label: 'Non-decorated' },
  { id: 'fullDecor', label: 'Decorated' },
];

// ── wreaths: size × tier → one SKU ───────────────────────────────────────────
export const WREATH_SIZES: QuoteWreathSize[] = [
  '24noble', '30noble', '36noble', '48noble', '60noble', '72noble',
];
export const wreathKey = (size: QuoteWreathSize, tier: Tier) => `wreath:${size}:${tier}`;
const sizeLabel = (s: string) => s.replace('noble', '″ Noble');
export function wreathRows(): ConceptRow[] {
  return WREATH_SIZES.flatMap((size) =>
    TIERS.map((t) => ({ key: wreathKey(size, t.id), label: `${sizeLabel(size)} — ${t.label}` })),
  );
}

// ── garland: length × tier → one SKU ─────────────────────────────────────────
export const GARLAND_LENGTHS: QuoteGarlandLength[] = ['4.5ft', '9ft'];
export const garlandKey = (length: QuoteGarlandLength, tier: Tier) => `garland:${length}:${tier}`;
export function garlandRows(): ConceptRow[] {
  return GARLAND_LENGTHS.flatMap((len) =>
    TIERS.map((t) => ({ key: garlandKey(len, t.id), label: `${len} section — ${t.label}` })),
  );
}

// ── spritzer: size → { spritzerSku, stakeMetalSku } bundle ───────────────────
export const SPRITZER_SIZES: QuoteSpritzerSize[] = ['16', '24', '32'];
export const spritzerKey = (size: QuoteSpritzerSize) => `spritzer:${size}`;
export const SPRITZER_BUNDLE_FIELDS: BundleField[] = [
  { id: 'spritzerSku', label: 'Spritzer' },
  { id: 'stakeMetalSku', label: 'Stake (metal pole)' },
];
export function spritzerRows(): ConceptBundleRow[] {
  return SPRITZER_SIZES.map((size) => ({
    key: spritzerKey(size),
    label: `${size}″ spritzer`,
    fields: SPRITZER_BUNDLE_FIELDS,
  }));
}

// ── mini surfaces: surface × wrapStyle → one SKU ─────────────────────────────
export const MINI_SURFACES: { id: string; label: string }[] = [
  { id: 'tree', label: 'Tree' },
  { id: 'bush', label: 'Bush' },
  { id: 'column', label: 'Column' },
  { id: 'railing', label: 'Railing' },
];
export const WRAP_STYLES: { id: WrapStyle; label: string }[] = [
  { id: 'canopy', label: 'Canopy' },
  { id: 'trunk', label: 'Trunk' },
];
export const miniKey = (surface: string, wrap: WrapStyle) => `mini:${surface}:${wrap}`;
export function miniRows(): ConceptRow[] {
  return MINI_SURFACES.flatMap((s) =>
    WRAP_STYLES.map((w) => ({ key: miniKey(s.id, w.id), label: `${s.label} — ${w.label}` })),
  );
}

// ── clip rules: roof feature → { sku, perFt } (app_settings `clipRules`) ─────
// Hints encode the spec §4 terminology traps so staff bind the right SKU.
export const CLIP_FEATURES: { id: string; label: string; hint: string }[] = [
  { id: 'gutter', label: 'Gutterline', hint: 'C9 Flex Clip — Naldo’s "tuff clip" (14147 W / 14347 B). NOT the "C9 Tuff Tab" 14148.' },
  { id: 'peak', label: 'Peak (front gable, no gutter)', hint: 'Shingle Tab (14145 W / 14345 B).' },
  { id: 'side', label: 'Side (shingles)', hint: 'Shingle Tab (14145 / 14345).' },
  { id: 'ridge', label: 'Ridge (horizontal apex)', hint: 'C9 Peak / Ridge Clip (14159 W / 14859 Brown).' },
  { id: 'pathway', label: 'Pathway / stake-lighting', hint: 'Pathway Ground Stake (14343 B / 14443 Grn). NOT the spritzer’s Stake Metal.' },
  { id: 'flat', label: 'Flat / commercial', hint: 'Parapet Clip + Shingle Tab (both).' },
  { id: 'metal', label: 'Metal roof', hint: 'Magnetic socket wire — no clip; flag for staff review.' },
];
```

- [ ] **Step 4: Run the test, verify it PASSES** (2 describes / 3 its)

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx vitest run src/lib/inventory/concepts.test.ts`
Then `npx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/concepts.ts src/lib/inventory/concepts.test.ts
git commit -m "feat(#82): inventory binding concept vocabulary (Slice 1b-ii)"
```

---

### Task 2: Catalog search helper (TDD)

**Files:**
- Test: `src/lib/inventory/skuSearch.test.ts`
- Create: `src/lib/inventory/skuSearch.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/skuSearch.test.ts
import { describe, it, expect } from 'vitest';
import { searchCatalog } from './skuSearch';
import type { CatalogItem } from './catalog';

const item = (over: Partial<CatalogItem>): CatalogItem => ({
  sku: '0', name: 'x', category: 'Cat', yll_category: null, color: null, size: null,
  wholesale_cost: null, needs_adapter: false, bag_ct: null, case_ct: null, locked: false,
  ...over,
});

const CATALOG: CatalogItem[] = [
  item({ sku: '20009-SPK', name: 'C9 Warm White', category: 'Bulbs' }),
  item({ sku: '14147', name: 'C9 Flex Clip White', category: 'Hardware' }),
  item({ sku: '14148', name: 'C9 Tuff Tab', category: 'Hardware' }),
];

describe('searchCatalog', () => {
  it('returns the first `limit` items for an empty query', () => {
    expect(searchCatalog(CATALOG, '', 2)).toHaveLength(2);
    expect(searchCatalog(CATALOG, '   ', 2)).toHaveLength(2);
  });
  it('matches sku, name, or category, case-insensitively', () => {
    expect(searchCatalog(CATALOG, '14147').map((i) => i.sku)).toEqual(['14147']);
    expect(searchCatalog(CATALOG, 'warm white').map((i) => i.sku)).toEqual(['20009-SPK']);
    expect(searchCatalog(CATALOG, 'HARDWARE').map((i) => i.sku)).toEqual(['14147', '14148']);
  });
  it('respects the result limit', () => {
    expect(searchCatalog(CATALOG, 'c9', 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx vitest run src/lib/inventory/skuSearch.test.ts`
Expected: FAIL — `Cannot find module './skuSearch'`.

- [ ] **Step 3: Write the helper**

```ts
// src/lib/inventory/skuSearch.ts
// Pure catalog filter for the SKU picker (1b-ii) + the overrides item list
// (1b-iii). Matches the query against sku, product name, and effective category
// (yll_category override else vendor category), case-insensitive. Empty query →
// the first `limit` items (so the picker shows something on focus).

import type { CatalogItem } from './catalog';

export function searchCatalog(items: CatalogItem[], query: string, limit = 50): CatalogItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const out: CatalogItem[] = [];
  for (const it of items) {
    const cat = (it.yll_category ?? it.category).toLowerCase();
    if (it.sku.toLowerCase().includes(q) || it.name.toLowerCase().includes(q) || cat.includes(q)) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test, verify it PASSES** (3 its)

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx vitest run src/lib/inventory/skuSearch.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/skuSearch.ts src/lib/inventory/skuSearch.test.ts
git commit -m "feat(#82): catalog search helper for the SKU picker (Slice 1b-ii)"
```

---

### Task 3: SkuPicker combobox + InventorySubNav

**Files:**
- Create: `src/components/inventory/SkuPicker.tsx`
- Create: `src/components/inventory/InventorySubNav.tsx`

- [ ] **Step 1: Write `SkuPicker.tsx`**

```tsx
// src/components/inventory/SkuPicker.tsx
'use client';

// Searchable type-ahead SKU picker (#82 Slice 1b-ii, Naldo's locked choice over a
// plain <select> — the catalog is ~831 items). Shows the chosen item as a chip
// (sku + name) with warnings when the bound SKU is locked (sold-out) or no longer
// in the catalog. Click the chip to re-pick; the × clears the binding.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItem } from '@/lib/inventory/catalog';
import { searchCatalog } from '@/lib/inventory/skuSearch';

export function SkuPicker({
  catalog,
  value,
  onChange,
  ariaLabel,
  placeholder = 'Search SKU or name…',
}: {
  catalog: CatalogItem[];
  value: string;
  onChange: (sku: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(catalog.map((c) => [c.sku, c])), [catalog]);
  const selected = value ? byId.get(value) : undefined;
  const results = useMemo(
    () => (editing ? searchCatalog(catalog, query, 50) : []),
    [editing, query, catalog],
  );

  // Focus the search input when entering edit mode (avoids the autoFocus a11y rule).
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setEditing(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editing]);

  const pick = (sku: string) => {
    onChange(sku);
    setQuery('');
    setEditing(false);
  };

  const showChip = value && !editing;

  return (
    <div className="relative w-72" ref={boxRef}>
      {showChip ? (
        <div className="w-full flex items-center gap-2 border border-gray-300 rounded px-2 py-1 text-sm bg-white">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 flex items-center gap-2 min-w-0 text-left hover:opacity-80"
            aria-label={ariaLabel ? `${ariaLabel}: ${value} — change` : 'Change SKU'}
          >
            <span className="font-mono text-xs text-gray-500 shrink-0">{value}</span>
            <span className="flex-1 truncate text-gray-800" title={selected?.name ?? ''}>
              {selected ? selected.name : <span className="text-amber-600">⚠ not in catalog</span>}
            </span>
            {selected?.locked && (
              <span className="text-[10px] uppercase tracking-wide text-amber-600 shrink-0" title="Sold-out / locked">
                locked
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => pick('')}
            className="text-gray-400 hover:text-red-600 shrink-0"
            aria-label="Clear SKU"
          >
            ×
          </button>
        </div>
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setEditing(true)}
          placeholder={placeholder}
          aria-label={ariaLabel ?? 'SKU picker'}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
        />
      )}

      {editing && (
        <ul className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded border border-gray-200 bg-white shadow-lg text-sm">
          {results.length === 0 ? (
            <li className="px-2 py-2 text-gray-400">No matches</li>
          ) : (
            results.map((item) => (
              <li key={item.sku}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(item.sku)}
                  className="w-full text-left px-2 py-1.5 hover:bg-green-50 flex items-center gap-2"
                >
                  <span className="font-mono text-xs text-gray-500 shrink-0">{item.sku}</span>
                  <span className="flex-1 truncate text-gray-800">{item.name}</span>
                  {item.locked && <span className="text-[10px] uppercase text-amber-600 shrink-0">locked</span>}
                  <span className="text-[10px] text-gray-400 shrink-0">{item.yll_category ?? item.category}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `InventorySubNav.tsx`**

```tsx
// src/components/inventory/InventorySubNav.tsx
import Link from 'next/link';

// Sub-navigation for the Inventory area (#82). Mirrors SettingsSubNav. "Stock" is
// the existing /inventory stub (on-hand, later slice); "Bindings" + "Overrides"
// are the Slice 1b config screens. The Overrides item is added in 1b-iii.
const ITEMS = [
  { label: 'Stock', href: '/inventory', key: 'stock' as const },
  { label: 'Bindings', href: '/inventory/bindings', key: 'bindings' as const },
];

export type InventoryTab = 'stock' | 'bindings' | 'overrides';

export function InventorySubNav({ active }: { active: InventoryTab }) {
  return (
    <div className="flex gap-1 mb-5 border-b" style={{ borderColor: 'var(--op-border)' }}>
      {ITEMS.map((item) => {
        const on = item.key === active;
        return (
          <Link
            key={item.key}
            href={item.href}
            className="px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
            style={
              on
                ? { borderColor: 'var(--brand-evergreen)', color: 'var(--op-text)' }
                : { borderColor: 'transparent', color: 'var(--op-text-dim)' }
            }
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Gate (no runtime test — visual QA covers rendering)**

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx tsc --noEmit && npm run lint`
Expected: tsc clean · lint 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/SkuPicker.tsx src/components/inventory/InventorySubNav.tsx
git commit -m "feat(#82): SKU picker combobox + InventorySubNav (Slice 1b-ii)"
```

---

### Task 4: Binding editor page + add sub-nav to the stub

**Files:**
- Create: `src/app/inventory/bindings/page.tsx`
- Modify: `src/app/inventory/page.tsx`

- [ ] **Step 1: Write `src/app/inventory/bindings/page.tsx`**

```tsx
// src/app/inventory/bindings/page.tsx
'use client';

// Binding editor (#82 Slice 1b-ii): map each billable design concept → a real
// Thunder SKU, plus roof-feature clip rules. Mirrors the #32 Settings page
// (client page + useEffect load + a single explicit Save → PUT). The concept
// vocabulary + key format come from src/lib/inventory/concepts.ts so the UI and
// the Slice 2 materials engine agree. Loads the catalog for the SKU picker.

import { useCallback, useEffect, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import { SkuPicker } from '@/components/inventory/SkuPicker';
import type { CatalogItem } from '@/lib/inventory/catalog';
import type { Bindings, ClipRules, InventoryBindings } from '@/lib/inventory/bindings';
import {
  bulbGroups, wreathRows, garlandRows, miniRows, spritzerRows, CLIP_FEATURES,
} from '@/lib/inventory/concepts';

type Status = 'idle' | 'saving' | 'saved' | 'error';
const TABS = [
  { id: 'bulbs', label: 'Bulb colors' },
  { id: 'clips', label: 'Clips / roof' },
  { id: 'wreaths', label: 'Wreaths' },
  { id: 'garland', label: 'Garland' },
  { id: 'spritzers', label: 'Spritzers' },
  { id: 'mini', label: 'Mini wraps' },
] as const;

const strVal = (b: Bindings, key: string) => (typeof b[key] === 'string' ? (b[key] as string) : '');

export default function BindingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('bulbs');
  const [bindings, setBindings] = useState<Bindings>({});
  const [clipRules, setClipRules] = useState<ClipRules>({});
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [bRes, cRes] = await Promise.all([
          fetch('/api/inventory/bindings'),
          fetch('/api/inventory/catalog'),
        ]);
        if (bRes.ok) {
          const b = (await bRes.json()) as InventoryBindings;
          if (!cancelled) {
            setBindings(b.bindings ?? {});
            setClipRules(b.clipRules ?? {});
          }
        }
        if (cRes.ok) {
          const c = (await cRes.json()) as CatalogItem[];
          if (!cancelled) setCatalog(Array.isArray(c) ? c : []);
        }
      } catch {
        // keep empty state; staff can still save
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── mutators (empty value ⇒ delete the key, matching normalizeBindings) ──
  const setBinding = (key: string, sku: string) =>
    setBindings((b) => {
      const n = { ...b };
      if (sku) n[key] = sku;
      else delete n[key];
      return n;
    });

  const setBundleField = (key: string, field: string, sku: string) =>
    setBindings((b) => {
      const cur: Record<string, string> =
        typeof b[key] === 'object' ? { ...(b[key] as Record<string, string>) } : {};
      if (sku) cur[field] = sku;
      else delete cur[field];
      const n = { ...b };
      if (Object.keys(cur).length) n[key] = cur;
      else delete n[key];
      return n;
    });

  const setClipSku = (feature: string, sku: string) =>
    setClipRules((cr) => {
      const cur = { ...(cr[feature] ?? {}) };
      if (sku) cur.sku = sku;
      else delete cur.sku;
      const n = { ...cr };
      if (Object.keys(cur).length) n[feature] = cur;
      else delete n[feature];
      return n;
    });

  const setClipPerFt = (feature: string, raw: string) =>
    setClipRules((cr) => {
      const cur = { ...(cr[feature] ?? {}) };
      const num = Number(raw);
      if (raw.trim() !== '' && Number.isFinite(num)) cur.perFt = num;
      else delete cur.perFt;
      const n = { ...cr };
      if (Object.keys(cur).length) n[feature] = cur;
      else delete n[feature];
      return n;
    });

  const save = useCallback(async () => {
    setStatus('saving');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/inventory/bindings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindings, clipRules }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const saved = (await res.json()) as InventoryBindings;
      setBindings(saved.bindings ?? {});
      setClipRules(saved.clipRules ?? {});
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1800);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Save failed');
    }
  }, [bindings, clipRules]);

  return (
    <OperatorShell active="inventory">
      <main className="max-w-3xl mx-auto">
        <InventorySubNav active="bindings" />

        <div className="mb-5">
          <h1 className="text-xl font-semibold text-gray-900">Bindings</h1>
          <p className="text-sm text-gray-500">
            Connect each design concept to the real Thunder SKU it orders. Empty = unbound (no SKU
            ordered for it yet).
          </p>
        </div>

        <div className="flex gap-1 border-b border-gray-200 mb-5 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
                tab === t.id
                  ? 'border-green-600 text-green-700'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 py-10 text-center">Loading bindings…</p>
        ) : (
          <>
            {tab === 'bulbs' &&
              bulbGroups().map((g) => (
                <section key={g.type.id} className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">{g.type.label} bulbs</h2>
                  {g.rows.map((row) => (
                    <Row key={row.key} label={row.label}>
                      <SkuPicker
                        catalog={catalog}
                        value={strVal(bindings, row.key)}
                        onChange={(sku) => setBinding(row.key, sku)}
                        ariaLabel={`${row.label} ${g.type.label} SKU`}
                      />
                    </Row>
                  ))}
                </section>
              ))}

            {tab === 'clips' && (
              <section>
                <p className="text-xs text-gray-400 mb-3">
                  Hard rules: no window lighting, no C7 clips. Spritzer stakes are NOT clips.
                </p>
                {CLIP_FEATURES.map((f) => {
                  const rule = clipRules[f.id] ?? {};
                  const sku = typeof rule.sku === 'string' ? rule.sku : '';
                  const perFt = typeof rule.perFt === 'number' ? String(rule.perFt) : '';
                  return (
                    <Row key={f.id} label={f.label} hint={f.hint}>
                      <div className="flex items-center gap-2">
                        <SkuPicker
                          catalog={catalog}
                          value={sku}
                          onChange={(s) => setClipSku(f.id, s)}
                          ariaLabel={`${f.label} clip SKU`}
                        />
                        <label className="flex items-center gap-1 text-xs text-gray-500">
                          clips/ft
                          <input
                            type="number"
                            min={0}
                            step={0.05}
                            value={perFt}
                            onChange={(e) => setClipPerFt(f.id, e.target.value)}
                            className="w-16 border border-gray-300 rounded px-1.5 py-1 text-sm"
                            aria-label={`${f.label} clips per foot`}
                          />
                        </label>
                      </div>
                    </Row>
                  );
                })}
              </section>
            )}

            {tab === 'wreaths' && (
              <section>
                {wreathRows().map((row) => (
                  <Row key={row.key} label={row.label}>
                    <SkuPicker catalog={catalog} value={strVal(bindings, row.key)} onChange={(s) => setBinding(row.key, s)} ariaLabel={`${row.label} SKU`} />
                  </Row>
                ))}
              </section>
            )}

            {tab === 'garland' && (
              <section>
                {garlandRows().map((row) => (
                  <Row key={row.key} label={row.label}>
                    <SkuPicker catalog={catalog} value={strVal(bindings, row.key)} onChange={(s) => setBinding(row.key, s)} ariaLabel={`${row.label} SKU`} />
                  </Row>
                ))}
              </section>
            )}

            {tab === 'spritzers' && (
              <section>
                <p className="text-xs text-gray-400 mb-3">
                  Each spritzer binds two SKUs — the spritzer itself + its metal stake pole.
                </p>
                {spritzerRows().map((row) => {
                  const bundle =
                    typeof bindings[row.key] === 'object' ? (bindings[row.key] as Record<string, string>) : {};
                  return (
                    <Row key={row.key} label={row.label}>
                      <div className="flex flex-col gap-1.5">
                        {row.fields.map((f) => (
                          <label key={f.id} className="flex items-center gap-2 text-xs text-gray-500">
                            <span className="w-28 text-right">{f.label}</span>
                            <SkuPicker
                              catalog={catalog}
                              value={bundle[f.id] ?? ''}
                              onChange={(s) => setBundleField(row.key, f.id, s)}
                              ariaLabel={`${row.label} ${f.label} SKU`}
                            />
                          </label>
                        ))}
                      </div>
                    </Row>
                  );
                })}
              </section>
            )}

            {tab === 'mini' && (
              <section>
                {miniRows().map((row) => (
                  <Row key={row.key} label={row.label}>
                    <SkuPicker catalog={catalog} value={strVal(bindings, row.key)} onChange={(s) => setBinding(row.key, s)} ariaLabel={`${row.label} SKU`} />
                  </Row>
                ))}
              </section>
            )}

            <div className="flex items-center gap-3 mt-6 sticky bottom-0 bg-[var(--op-bg)] py-3">
              <button
                type="button"
                onClick={save}
                className="text-sm font-semibold text-white bg-green-600 hover:bg-green-700 rounded-md px-4 py-1.5"
              >
                Save bindings
              </button>
              {status !== 'idle' && (
                <span
                  role="status"
                  className={`text-sm ${
                    status === 'error' ? 'text-red-600' : status === 'saved' ? 'text-green-700' : 'text-gray-500'
                  }`}
                >
                  {status === 'saving' && 'Saving…'}
                  {status === 'saved' && 'Saved.'}
                  {status === 'error' && `Save failed: ${errorMsg}`}
                </span>
              )}
            </div>
          </>
        )}
      </main>
    </OperatorShell>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-gray-100">
      <div className="min-w-0">
        <div className="text-sm text-gray-700">{label}</div>
        {hint && <div className="text-[11px] text-gray-400 max-w-md">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Add the sub-nav to the existing stub** — `src/app/inventory/page.tsx`

Replace the import block + the opening of the returned content so the sub-nav renders above "Coming soon". Change:

```tsx
import { OperatorShell } from '@/components/OperatorShell';
```
to:
```tsx
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
```

and change:
```tsx
    <OperatorShell active="inventory">
      <div className="max-w-3xl mx-auto w-full">
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
          Inventory
        </p>
```
to:
```tsx
    <OperatorShell active="inventory">
      <div className="max-w-3xl mx-auto w-full">
        <InventorySubNav active="stock" />
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
          Inventory
        </p>
```

- [ ] **Step 3: Gates**

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx tsc --noEmit && npm run lint && npx vitest run`
Expected: tsc clean · lint 0 errors · all tests pass (incl. the new concepts + skuSearch tests).

- [ ] **Step 4: Commit**

```bash
git add src/app/inventory/bindings/page.tsx src/app/inventory/page.tsx
git commit -m "feat(#82): binding editor page /inventory/bindings (Slice 1b-ii)"
```

---

### Task 5: Visual QA (1b-ii) — Naldo reviews

- [ ] **Step 1: Start the dev server** (from the worktree, prod-backed catalog)

```bash
cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory"
unset ANTHROPIC_API_KEY
npx next dev -p 3001
```

- [ ] **Step 2: Screenshot each tab** at `http://localhost:3001/inventory/bindings` via the dev server (webapp-testing / Chrome). Verify:
  - Sub-nav shows Stock · Bindings; Bindings is active.
  - Bulb tab: 4 sections (C9/Mini/Permanent/Bistro), 12 colors each; the SKU picker filters the live 831-item catalog as you type; picking shows `sku — name` chip; locked SKUs show a "locked" warning.
  - Clips tab: 7 features with hints; SKU picker + clips/ft number input.
  - Wreaths (12) / Garland (4) / Spritzers (3, two pickers each) / Mini (8) render.
  - Save → "Saved."; reload preserves the bindings (round-trips through `/api/inventory/bindings`).
  - `/inventory` stub shows the sub-nav.

- [ ] **Step 3: Hand Naldo the URL + test steps** (`http://localhost:3001/inventory/bindings`) and wait for his go before the PR.

---

### Task 6: Bring 1b-ii branch current + open PR

- [ ] **Step 1:** `git fetch origin` and, if `origin/master` advanced past the branch base, merge it in and re-run the gates on the updated branch.

```bash
cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory"
git fetch origin
git merge origin/master   # resolve any conflicts
npx tsc --noEmit && npm run lint && npx vitest run
```

- [ ] **Step 2:** Push + open the PR (do NOT merge — Naldo merges on his go).

```bash
git push -u origin naldo/inventory-1b-ii
gh pr create --fill --base master --head naldo/inventory-1b-ii
```

PR body should note: Naldo's area (zero relay); reuses 1b-i `/api/inventory/bindings` + 1a catalog GET; auto-gated by #81 middleware (not added to the allowlist).

---

# SLICE 1b-iii — Catalog overrides UI (PR #2, branched off 1b-ii)

> Branch: `git checkout -b naldo/inventory-1b-iii` **off the 1b-ii tip** (it reuses `InventorySubNav` + `searchCatalog`). If 1b-ii merges first, rebase onto fresh `origin/master` instead.

### File Structure
- `src/lib/inventory/catalog.ts` — **Modify.** Add `toCatalogUpsertRow` (makes the import column-set explicit), `updateCatalogItem`, `normalizeHiddenCategories`, `getHiddenCategories`, `setHiddenCategories`.
- `src/lib/inventory/catalog.test.ts` — **Create.** Pin the `upsertCatalogItems` column set (carry-forward) + test `normalizeHiddenCategories`.
- `src/app/api/inventory/catalog/route.ts` — **Modify.** Add `PATCH` (per-item `{sku, locked?, yll_category?}`).
- `src/app/api/inventory/categories/route.ts` — **Create.** `GET`/`PUT` the `hiddenCategories` list.
- `src/components/inventory/InventorySubNav.tsx` — **Modify.** Add the Overrides item.
- `src/app/inventory/overrides/page.tsx` — **Create.** Category show/hide + per-item lock (searchable + paginated; instant-save).

No migration (table + app_settings already exist).

---

### Task 7: Catalog data-layer additions (TDD) + pin the import column set

**Files:**
- Test: `src/lib/inventory/catalog.test.ts`
- Modify: `src/lib/inventory/catalog.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/catalog.test.ts
import { describe, it, expect } from 'vitest';
import { toCatalogUpsertRow, normalizeHiddenCategories } from './catalog';
import type { ParsedCatalogItem } from './parseThunderCsv';

const SAMPLE: ParsedCatalogItem = {
  sku: '14147', name: 'C9 Flex Clip White', category: 'Hardware', color: 'White',
  size: null, wholesale_cost: 0.18, needs_adapter: false, bag_ct: 100, case_ct: 800,
};

describe('toCatalogUpsertRow', () => {
  // CARRY-FORWARD: re-import must NEVER write the operator-owned columns
  // (locked / yll_category), or a yearly re-import would clobber overrides.
  it('writes exactly the vendor columns — no locked / yll_category', () => {
    expect(Object.keys(toCatalogUpsertRow(SAMPLE)).sort()).toEqual(
      ['bag_ct', 'case_ct', 'category', 'color', 'name', 'needs_adapter', 'size', 'sku', 'wholesale_cost'].sort(),
    );
  });
  it('drops any stray operator fields a caller passes in', () => {
    const dirty = { ...SAMPLE, locked: true, yll_category: 'Clips' } as ParsedCatalogItem;
    const row = toCatalogUpsertRow(dirty) as Record<string, unknown>;
    expect(row.locked).toBeUndefined();
    expect(row.yll_category).toBeUndefined();
  });
});

describe('normalizeHiddenCategories', () => {
  it('keeps non-empty trimmed strings, de-duped', () => {
    expect(normalizeHiddenCategories(['Bulbs', ' Bulbs ', 'Wire', ''])).toEqual(['Bulbs', 'Wire']);
  });
  it('returns [] for non-array / garbage input', () => {
    expect(normalizeHiddenCategories(null)).toEqual([]);
    expect(normalizeHiddenCategories('x')).toEqual([]);
    expect(normalizeHiddenCategories([1, 2, {}])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx vitest run src/lib/inventory/catalog.test.ts`
Expected: FAIL — `toCatalogUpsertRow`/`normalizeHiddenCategories` not exported.

- [ ] **Step 3: Edit `src/lib/inventory/catalog.ts`**

Add the import of the app_settings helper at the top (after the existing imports):

```ts
import { getSupabaseServiceClient, getSupabaseClient } from '../supabase';
import type { ParsedCatalogItem } from './parseThunderCsv';
```
(unchanged — shown for context). Then change `upsertCatalogItems` to map through an explicit row builder, and append the new functions. Replace the existing `upsertCatalogItems` body:

```ts
// Pure: the EXACT column set an import upsert writes. yll_category + locked are
// deliberately excluded so a yearly re-import re-seeds prices/names without
// clobbering operator regrouping or sold-out flags. Pinned by catalog.test.ts.
export function toCatalogUpsertRow(item: ParsedCatalogItem): ParsedCatalogItem {
  return {
    sku: item.sku,
    name: item.name,
    category: item.category,
    color: item.color,
    size: item.size,
    wholesale_cost: item.wholesale_cost,
    needs_adapter: item.needs_adapter,
    bag_ct: item.bag_ct,
    case_ct: item.case_ct,
  };
}

// Upsert ONLY vendor-sourced columns (see toCatalogUpsertRow).
export async function upsertCatalogItems(items: ParsedCatalogItem[]): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  if (items.length === 0) return 0;
  const rows = items.map(toCatalogUpsertRow);
  const { error, count } = await sb
    .from('inventory_catalog')
    .upsert(rows, { onConflict: 'sku', count: 'exact' });
  if (error) throw new Error(`upsertCatalogItems: ${error.message}`);
  return count ?? rows.length;
}

// ── operator overrides (1b-iii) ──────────────────────────────────────────────

// Update one catalog row's operator-owned fields (sold-out lock + regroup).
export async function updateCatalogItem(
  sku: string,
  patch: { locked?: boolean; yll_category?: string | null },
): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const update: Record<string, unknown> = {};
  if (typeof patch.locked === 'boolean') update.locked = patch.locked;
  // yll_category: a string regroups; null clears back to the vendor category.
  if (patch.yll_category !== undefined) {
    update.yll_category =
      typeof patch.yll_category === 'string' && patch.yll_category.trim()
        ? patch.yll_category.trim()
        : null;
  }
  if (Object.keys(update).length === 0) return;
  const { error } = await sb.from('inventory_catalog').update(update).eq('sku', sku);
  if (error) throw new Error(`updateCatalogItem: ${error.message}`);
}

// Category show/hide list (Q6.3) — an app_settings key, parallel to bindings.
export function normalizeHiddenCategories(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) seen.add(x.trim());
  }
  return [...seen];
}

export async function getHiddenCategories(): Promise<string[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('app_settings')
    .select('value')
    .eq('key', 'hiddenCategories')
    .maybeSingle();
  if (error) {
    console.error('getHiddenCategories error:', error);
    return [];
  }
  return normalizeHiddenCategories(data?.value);
}

export async function setHiddenCategories(cats: string[]): Promise<string[]> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const value = normalizeHiddenCategories(cats);
  const { error } = await sb
    .from('app_settings')
    .upsert({ key: 'hiddenCategories', value }, { onConflict: 'key' });
  if (error) throw new Error(`setHiddenCategories: ${error.message}`);
  return value;
}
```

> Note: delete the OLD `upsertCatalogItems` definition (lines 35-44 of the current file) — it is replaced above. `getSupabaseClient` is already imported.

- [ ] **Step 4: Run the test, verify it PASSES** + gates

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx vitest run src/lib/inventory/catalog.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/catalog.ts src/lib/inventory/catalog.test.ts
git commit -m "feat(#82): catalog override data layer + pin import column set (Slice 1b-iii)"
```

---

### Task 8: PATCH catalog route + categories route

**Files:**
- Modify: `src/app/api/inventory/catalog/route.ts`
- Create: `src/app/api/inventory/categories/route.ts`

- [ ] **Step 1: Add `PATCH` to `src/app/api/inventory/catalog/route.ts`**

Add `updateCatalogItem` to the existing import from `@/lib/inventory/catalog`:

```ts
import { listCatalog, upsertCatalogItems, updateCatalogItem } from '@/lib/inventory/catalog';
```

Append the handler:

```ts
export async function PATCH(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { sku, locked, yll_category } = (body ?? {}) as Record<string, unknown>;
  if (typeof sku !== 'string' || !sku.trim()) {
    return NextResponse.json({ error: 'Body must include a `sku` string' }, { status: 400 });
  }
  if (locked !== undefined && typeof locked !== 'boolean') {
    return NextResponse.json({ error: '`locked` must be a boolean' }, { status: 400 });
  }
  if (yll_category !== undefined && yll_category !== null && typeof yll_category !== 'string') {
    return NextResponse.json({ error: '`yll_category` must be a string or null' }, { status: 400 });
  }
  if (locked === undefined && yll_category === undefined) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }
  try {
    await updateCatalogItem(sku.trim(), {
      locked: locked as boolean | undefined,
      yll_category: yll_category as string | null | undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/inventory/catalog] PATCH failed:', err);
    return NextResponse.json({ error: 'Failed to update catalog item' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create `src/app/api/inventory/categories/route.ts`**

```ts
// src/app/api/inventory/categories/route.ts
// Category show/hide list (#82 Slice 1b-iii). GET returns the hidden-category
// names; PUT replaces them. Stored in app_settings under `hiddenCategories`.
// Service-role only — mirrors src/app/api/inventory/bindings/route.ts.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { getHiddenCategories, setHiddenCategories, normalizeHiddenCategories } from '@/lib/inventory/catalog';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json({ hiddenCategories: await getHiddenCategories() });
  } catch (err) {
    console.error('[api/inventory/categories] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load categories' }, { status: 500 });
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
  const hidden = (body as Record<string, unknown>)?.hiddenCategories;
  if (!Array.isArray(hidden)) {
    return NextResponse.json({ error: '`hiddenCategories` must be an array' }, { status: 400 });
  }
  try {
    const saved = await setHiddenCategories(normalizeHiddenCategories(hidden));
    return NextResponse.json({ hiddenCategories: saved });
  } catch (err) {
    console.error('[api/inventory/categories] PUT failed:', err);
    return NextResponse.json({ error: 'Failed to save categories' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Gates**

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx tsc --noEmit && npm run lint`

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/catalog/route.ts src/app/api/inventory/categories/route.ts
git commit -m "feat(#82): PATCH catalog item + categories show/hide API (Slice 1b-iii)"
```

---

### Task 9: Overrides page + sub-nav item

**Files:**
- Modify: `src/components/inventory/InventorySubNav.tsx`
- Create: `src/app/inventory/overrides/page.tsx`

- [ ] **Step 1: Add the Overrides item to `InventorySubNav.tsx`**

Change the `ITEMS` array to:

```tsx
const ITEMS = [
  { label: 'Stock', href: '/inventory', key: 'stock' as const },
  { label: 'Bindings', href: '/inventory/bindings', key: 'bindings' as const },
  { label: 'Overrides', href: '/inventory/overrides', key: 'overrides' as const },
];
```

- [ ] **Step 2: Create `src/app/inventory/overrides/page.tsx`**

```tsx
// src/app/inventory/overrides/page.tsx
'use client';

// Catalog overrides (#82 Slice 1b-iii): hide categories the materials engine
// shouldn't use, and lock sold-out items so the engine won't order them. The
// item list is searchable + paginated (Naldo's locked choice — 831 SKUs). Unlike
// the binding editor, this page saves INSTANTLY per toggle (a paginated list has
// no single Save), via PATCH /api/inventory/catalog + PUT /api/inventory/categories.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import type { CatalogItem } from '@/lib/inventory/catalog';
import { searchCatalog } from '@/lib/inventory/skuSearch';

const PAGE_SIZE = 25;
const effCat = (it: CatalogItem) => it.yll_category ?? it.category;

export default function OverridesPage() {
  const [tab, setTab] = useState<'categories' | 'items'>('categories');
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [cRes, hRes] = await Promise.all([
          fetch('/api/inventory/catalog'),
          fetch('/api/inventory/categories'),
        ]);
        if (cRes.ok) {
          const c = (await cRes.json()) as CatalogItem[];
          if (!cancelled) setCatalog(Array.isArray(c) ? c : []);
        }
        if (hRes.ok) {
          const h = (await hRes.json()) as { hiddenCategories?: string[] };
          if (!cancelled) setHidden(h.hiddenCategories ?? []);
        }
      } catch {
        // keep empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const flash = (msg: string) => {
    setNote(msg);
    window.setTimeout(() => setNote(null), 1600);
  };

  // ── category show/hide (instant PUT) ──
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of catalog) counts.set(effCat(it), (counts.get(effCat(it)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog]);

  const toggleCategory = useCallback(
    async (cat: string, visible: boolean) => {
      const next = visible ? hidden.filter((c) => c !== cat) : [...hidden, cat];
      const prev = hidden;
      setHidden(next); // optimistic
      try {
        const res = await fetch('/api/inventory/categories', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hiddenCategories: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved = (await res.json()) as { hiddenCategories?: string[] };
        setHidden(saved.hiddenCategories ?? next);
        flash('Saved.');
      } catch {
        setHidden(prev); // revert
        flash('Save failed.');
      }
    },
    [hidden],
  );

  // ── per-item lock (instant PATCH) ──
  const patchItem = useCallback(
    async (sku: string, patch: { locked?: boolean; yll_category?: string | null }) => {
      const prev = catalog;
      setCatalog((cs) => cs.map((c) => (c.sku === sku ? { ...c, ...patch } : c)));
      try {
        const res = await fetch('/api/inventory/catalog', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku, ...patch }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        flash('Saved.');
      } catch {
        setCatalog(prev); // revert
        flash('Save failed.');
      }
    },
    [catalog],
  );

  return (
    <OperatorShell active="inventory">
      <main className="max-w-4xl mx-auto">
        <InventorySubNav active="overrides" />

        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Overrides</h1>
            <p className="text-sm text-gray-500">Hide unused categories and lock sold-out items. Saves instantly.</p>
          </div>
          {note && <span role="status" className="text-sm text-gray-500">{note}</span>}
        </div>

        <div className="flex gap-1 border-b border-gray-200 mb-5">
          {(['categories', 'items'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 capitalize ${
                tab === t ? 'border-green-600 text-green-700' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 py-10 text-center">Loading catalog…</p>
        ) : tab === 'categories' ? (
          <CategoriesTab categories={categories} hidden={hidden} onToggle={toggleCategory} />
        ) : (
          <ItemsTab catalog={catalog} onPatch={patchItem} />
        )}
      </main>
    </OperatorShell>
  );
}

function CategoriesTab({
  categories,
  hidden,
  onToggle,
}: {
  categories: [string, number][];
  hidden: string[];
  onToggle: (cat: string, visible: boolean) => void;
}) {
  const hiddenSet = new Set(hidden);
  if (categories.length === 0) {
    return <p className="text-sm text-gray-400 py-6">No catalog imported yet.</p>;
  }
  return (
    <div className="space-y-1">
      {categories.map(([cat, count]) => {
        const visible = !hiddenSet.has(cat);
        return (
          <label
            key={cat}
            className="flex items-center justify-between gap-4 py-2 px-2 border border-gray-100 rounded hover:bg-gray-50"
          >
            <span className="text-sm text-gray-700">
              {cat} <span className="text-xs text-gray-400">({count})</span>
            </span>
            <span className="flex items-center gap-2 text-xs text-gray-500">
              {visible ? 'Visible' : 'Hidden'}
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => onToggle(cat, e.target.checked)}
                className="w-4 h-4"
                aria-label={`${cat} visible`}
              />
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ItemsTab({
  catalog,
  onPatch,
}: {
  catalog: CatalogItem[];
  onPatch: (sku: string, patch: { locked?: boolean; yll_category?: string | null }) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => searchCatalog(catalog, query, catalog.length), [catalog, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clamped = Math.min(page, pages - 1);
  const slice = filtered.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          placeholder="Search SKU, name, or category…"
          className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm"
          aria-label="Search catalog"
        />
        <span className="text-xs text-gray-400 shrink-0">{filtered.length} items</span>
      </div>

      <div className="border border-gray-100 rounded divide-y divide-gray-100">
        {slice.length === 0 ? (
          <p className="text-sm text-gray-400 px-3 py-6">No matches.</p>
        ) : (
          slice.map((it) => (
            <div key={it.sku} className="flex items-center gap-3 px-3 py-2">
              <span className="font-mono text-xs text-gray-500 w-24 shrink-0">{it.sku}</span>
              <span className="flex-1 truncate text-sm text-gray-800" title={it.name}>{it.name}</span>
              <span className="text-[11px] text-gray-400 w-28 truncate shrink-0">{it.yll_category ?? it.category}</span>
              <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                <input
                  type="checkbox"
                  checked={it.locked}
                  onChange={(e) => onPatch(it.sku, { locked: e.target.checked })}
                  className="w-4 h-4"
                  aria-label={`Lock ${it.sku}`}
                />
                {it.locked ? <span className="text-amber-600">Sold out</span> : 'Available'}
              </label>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between mt-3 text-sm text-gray-500">
        <button
          type="button"
          disabled={clamped <= 0}
          onClick={() => setPage(clamped - 1)}
          className="px-3 py-1 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
        >
          ← Prev
        </button>
        <span>Page {clamped + 1} of {pages}</span>
        <button
          type="button"
          disabled={clamped >= pages - 1}
          onClick={() => setPage(clamped + 1)}
          className="px-3 py-1 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Gates**

Run: `cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory" && npx tsc --noEmit && npm run lint && npx vitest run`
Expected: tsc clean · lint 0 · all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/InventorySubNav.tsx src/app/inventory/overrides/page.tsx
git commit -m "feat(#82): catalog overrides page /inventory/overrides (Slice 1b-iii)"
```

---

### Task 10: Visual QA (1b-iii) — Naldo reviews

- [ ] **Step 1:** Dev server running (`npx next dev -p 3001`, ANTHROPIC_API_KEY unset). Screenshot `http://localhost:3001/inventory/overrides`. Verify:
  - Sub-nav now shows Stock · Bindings · Overrides; Overrides active.
  - Categories tab: distinct catalog categories with counts + a Visible checkbox; toggling flips Visible/Hidden and persists (reload keeps it).
  - Items tab: search filters the 831-item list; pagination (25/page) Prev/Next + "Page X of Y"; locking an item shows "Sold out" + persists (reload keeps it); the same SKU shows "locked" in the binding picker (1b-ii cross-check).
- [ ] **Step 2:** Hand Naldo the URL + steps; wait for his go.

---

### Task 11: Bring 1b-iii current + open PR

- [ ] **Step 1:** `git fetch origin`; if `origin/master` advanced (e.g. 1b-ii merged), bring the branch current (rebase onto `origin/master` or merge it) and re-run gates.

```bash
cd "C:/Users/ebhdh/.config/superpowers/worktrees/yll-quote-tool/inventory"
git fetch origin
git merge origin/master   # resolve conflicts (likely none — disjoint files)
npx tsc --noEmit && npm run lint && npx vitest run
```

- [ ] **Step 2:** Push + open PR (do NOT merge).

```bash
git push -u origin naldo/inventory-1b-iii
gh pr create --fill --base master --head naldo/inventory-1b-iii
```

---

## Self-Review

**Spec coverage (spec §3 Q6.3 + the brief):**
- Binding editor with a searchable type-ahead SKU picker mapping each design concept → SKU ✓ (Tasks 1–4; `SkuPicker` + full vocabulary in `concepts.ts`).
- Clip rules (roof-feature → clip SKU + perFt) ✓ (Clips tab; persists to `clipRules`).
- Concept vocabulary: bulb colors × bulbType ✓; clip features ✓; wreath size×tier ✓; garland length×tier ✓; spritzer size→bundle ✓; mini surface×wrapStyle ✓.
- Category show/hide toggles ✓ (Task 9 Categories tab + `hiddenCategories` app_settings key).
- Per-item sold-out lock, searchable + paginated ✓ (Task 9 Items tab).
- New `PATCH /api/inventory/catalog` (locked + yll_category by sku) + a fn in `catalog.ts` ✓ (Tasks 7–8).
- Mirrors the #32 Settings UI (client page + useEffect + Save) ✓; does NOT edit `appSettings.ts` ✓; all under `/inventory` not `/settings` ✓.
- CARRY-FORWARD: unit test pinning `upsertCatalogItems`' column set ✓ (Task 7 `toCatalogUpsertRow` + `catalog.test.ts`).
- #81 middleware default-deny auto-gates `/inventory` — no allowlist edit ✓.

**Placeholder scan:** No TBD/TODO/"handle errors" — every step has complete code or an exact command.

**Type consistency:** `CatalogItem` (from `catalog.ts`), `Bindings`/`ClipRules`/`InventoryBindings` (from `bindings.ts`), `searchCatalog`, `toCatalogUpsertRow`, `updateCatalogItem`, `getHiddenCategories`/`setHiddenCategories`/`normalizeHiddenCategories` names match across data layer, routes, tests, and pages. Concept key builders (`bulbKey`/`wreathKey`/`garlandKey`/`spritzerKey`/`miniKey`) + row generators (`bulbGroups`/`wreathRows`/`garlandRows`/`miniRows`/`spritzerRows`) match between `concepts.ts`, its test, and the bindings page. The binding-value contract (`string | Record<string,string>`) is honored: bulbs/wreath/garland/mini write strings; spritzer writes a bundle object; clips write `{sku, perFt}` into `clipRules` (not `bindings`). Empty-value-deletes matches `normalizeBindings`/`normalizeClipRules` (clearing a row drops the key).

> Related: design spec `docs/superpowers/specs/2026-06-27-inventory-82-design.md`; 1b backend plan `docs/superpowers/plans/2026-06-27-inventory-82-slice1b-bindings.md` (1b-i, merged PR #177).
