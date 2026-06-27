// src/lib/inventory/materialsProjection.ts
// PER-UNIT MATERIALS PROJECTOR (#82 Slice 2a). Pure function: a design Scene +
// the inventory `bindings` → the per-unit material lines ({sku, qty}) for wreaths
// (base + bow + decoration fee), garland, spritzers (spritzer + pole), and
// mini-light wraps. A parallel of src/lib/design/projectScene.ts (which turns the
// same items into PRICING inputs), but reading the bindings instead.
//
// Roofline materials (bulbs / wire / clips) are Slice 2b — they're footage-driven
// and clips need the NET-NEW roof-feature tag (a shared scene/editor-core change).
// Standalone bows have no binding concept yet → not projected here.
//
// Reuses the binding key-builders from concepts.ts so the projector and the
// binding editor can never disagree on key format. No Supabase / React — callers
// pass the scene + bindings.

import type {
  Scene,
  Tier,
  QuoteWreathSize,
  QuoteGarlandLength,
  QuoteSpritzerSize,
} from '@/lib/design/sceneTypes';
import { isWreath, isGarland, isSpritzer, isStrand, isMiniArea, isMiniGroup } from '@/lib/design/sceneTypes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';
import type { Bindings } from './bindings';
import {
  wreathBaseKey, wreathBowKey, wreathFeeKey,
  garlandBaseKey, GARLAND_BOW_KEY, GARLAND_FEE_KEY,
  spritzerKey, spritzerPoleKey, miniKey,
} from './concepts';

export type MaterialCategory =
  | 'wreath' | 'wreath-bow' | 'wreath-fee'
  | 'garland' | 'garland-bow' | 'garland-fee'
  | 'spritzer' | 'spritzer-pole'
  | 'mini';

export type MaterialLine = {
  sku: string | null; // null = the concept has no SKU bound yet
  qty: number;
  category: MaterialCategory;
  conceptKey: string;
  label: string;
  sceneItemId: string;
};

// Same defaults as projectScene, so materials match what gets priced.
const DEFAULT_WREATH_SIZE: QuoteWreathSize = '36noble';
const DEFAULT_WREATH_TIER: Tier = 'bow';
const DEFAULT_GARLAND_LENGTH: QuoteGarlandLength = '9ft';
const DEFAULT_GARLAND_TIER: Tier = 'fullDecor';
const DEFAULT_SPRITZER_SIZE: QuoteSpritzerSize = '24';
const DEFAULT_PALETTE = 'warm-white';

const isIncluded = (i: { included?: boolean }) => i.included !== false;
const skuOf = (b: Bindings, key: string) => (typeof b[key] === 'string' ? (b[key] as string) : null);
const sizeLabel = (s: string) => s.replace('noble', '" Noble');
// Palette id → catalog color label (e.g. cool-white → "Pure White"), so it matches
// the catalog-color-keyed mini bindings.
const colorLabel = (paletteId: string) => DEFAULT_COLORS.find((c) => c.id === paletteId)?.label ?? paletteId;

type MiniSurface = 'bush' | 'tree' | 'column' | 'railing';
const asMiniSurface = (s: unknown): MiniSurface | null =>
  s === 'bush' || s === 'tree' || s === 'column' || s === 'railing' ? s : null;
const intAtLeast1 = (n: unknown) => Math.max(1, Math.round(typeof n === 'number' && Number.isFinite(n) ? n : 1));

export function projectMaterials(scene: Scene, bindings: Bindings): MaterialLine[] {
  const out: MaterialLine[] = [];
  const items = Array.isArray(scene?.items) ? scene.items : [];
  const b = bindings ?? {};

  const push = (sceneItemId: string, category: MaterialCategory, conceptKey: string, qty: number, label: string) => {
    if (qty <= 0) return;
    out.push({ sku: skuOf(b, conceptKey), qty, category, conceptKey, label, sceneItemId });
  };

  for (const item of items) {
    if (!isIncluded(item)) continue;

    if (isWreath(item)) {
      const size = item.quoteSize ?? DEFAULT_WREATH_SIZE;
      const tier: Tier = item.tier ?? DEFAULT_WREATH_TIER;
      const sl = sizeLabel(size);
      push(item.id, 'wreath', wreathBaseKey(size), 1, `${sl} wreath`);
      if (tier === 'fullDecor') {
        push(item.id, 'wreath-bow', wreathBowKey(size), 1, `${sl} wreath bow`);
        push(item.id, 'wreath-fee', wreathFeeKey(size), 1, `${sl} wreath decoration`);
      }
      continue;
    }

    if (isGarland(item)) {
      const length = item.quoteLength ?? DEFAULT_GARLAND_LENGTH;
      const tier: Tier = item.tier ?? DEFAULT_GARLAND_TIER;
      const sections = intAtLeast1(item.quoteSections);
      push(item.id, 'garland', garlandBaseKey(length), sections, `${length} garland × ${sections}`);
      if (tier === 'fullDecor') {
        push(item.id, 'garland-bow', GARLAND_BOW_KEY, 1, 'garland bow');
        push(item.id, 'garland-fee', GARLAND_FEE_KEY, 1, 'garland decoration');
      }
      continue;
    }

    if (isSpritzer(item)) {
      const size = item.quoteSize ?? DEFAULT_SPRITZER_SIZE;
      const paletteId = item.colorPattern?.[0] ?? DEFAULT_PALETTE;
      push(item.id, 'spritzer', spritzerKey(paletteId, size), 1, `${size}" ${colorLabel(paletteId)} spritzer`);
      push(item.id, 'spritzer-pole', spritzerPoleKey(size), 1, `${size}" spritzer pole`);
      continue;
    }

    // Mini-light wrap — strand (skip group members), area fill, or grouped railing.
    let surface: MiniSurface | null = null;
    let stringCount = 1;
    let paletteId = DEFAULT_PALETTE;
    if (isStrand(item)) {
      if (item.groupId) continue; // projected via its MiniGroupItem
      surface = asMiniSurface(item.surface);
      stringCount = intAtLeast1(item.stringCount);
      paletteId = item.colorPattern?.[0] ?? DEFAULT_PALETTE;
    } else if (isMiniArea(item)) {
      surface = asMiniSurface(item.surface);
      stringCount = intAtLeast1(item.stringCount);
      paletteId = item.colorPattern?.[0] ?? DEFAULT_PALETTE;
    } else if (isMiniGroup(item)) {
      surface = asMiniSurface(item.surface);
      stringCount = intAtLeast1(item.stringCount);
    }
    if (surface) {
      const label = colorLabel(paletteId);
      push(item.id, 'mini', miniKey(label), stringCount, `${label} mini (${surface}) × ${stringCount}`);
      continue;
    }

    // roofline strands / bows / text / custom / pole / unmapped → not projected here.
  }

  return out;
}

// Aggregate to orderable {sku, qty} totals: sum by sku, drop unbound (null), sort.
export function aggregateMaterials(lines: MaterialLine[]): { sku: string; qty: number }[] {
  const sums = new Map<string, number>();
  for (const l of lines) {
    if (!l.sku) continue;
    sums.set(l.sku, (sums.get(l.sku) ?? 0) + l.qty);
  }
  return [...sums.entries()]
    .map(([sku, qty]) => ({ sku, qty }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}
