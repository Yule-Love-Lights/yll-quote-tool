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
// String values are only valid for the `sku` field; all other fields must be numbers.
export function normalizeClipRules(v: unknown): ClipRules | null {
  if (!isPlainObject(v)) return null;
  const out: ClipRules = {};
  for (const [feature, rule] of Object.entries(v)) {
    if (!isPlainObject(rule)) continue;
    const clean: ClipRule = {};
    for (const [rk, rv] of Object.entries(rule)) {
      if (rk === 'sku' && typeof rv === 'string' && rv.trim()) clean[rk] = rv.trim();
      else if (rk !== 'sku' && typeof rv === 'number' && Number.isFinite(rv)) clean[rk] = rv;
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
