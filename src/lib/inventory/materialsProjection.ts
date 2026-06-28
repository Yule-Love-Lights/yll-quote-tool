// src/lib/inventory/materialsProjection.ts
// PER-UNIT MATERIALS PROJECTOR (#82 Slice 2a). Pure function: a design Scene +
// the inventory `bindings` → the per-unit material lines ({sku, qty}) for wreaths
// (base + bow + decoration fee), garland, spritzers (spritzer + pole), and
// mini-light wraps. A parallel of src/lib/design/projectScene.ts (which turns the
// same items into PRICING inputs), but reading the bindings instead.
//
// Roofline materials (Slice 2b): c9 roofline runs now project C9 bulbs (by color)
// + clips (by the run's roofFeature, via clipRules). Footage is derived from the
// scene GEOMETRY (run length ÷ the yardstick's px/ft) — the only source available
// in the materials-view context (the quote's billed footage is a separate concern,
// flagged in the design spec §10). Socket WIRE has no binding concept yet →
// deferred (a fast follow-up). Standalone bows have no binding concept → not here.
//
// Reuses the binding key-builders from concepts.ts so the projector and the
// binding editor can never disagree on key format. No Supabase / React — callers
// pass the scene + bindings.

import type {
  Scene,
  StrandItem,
  Tier,
  QuoteWreathSize,
  QuoteGarlandLength,
  QuoteSpritzerSize,
} from '@/lib/design/sceneTypes';
import { isWreath, isGarland, isSpritzer, isStrand, isMiniArea, isMiniGroup } from '@/lib/design/sceneTypes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';
import { pxPerFoot } from '@/components/design/editor-core/yardstick-scale';
import type { Bindings, ClipRules } from './bindings';
import {
  wreathBaseKey, wreathBowKey, wreathFeeKey,
  garlandBaseKey, GARLAND_BOW_KEY, GARLAND_FEE_KEY,
  spritzerKey, spritzerPoleKey, miniKey,
  bulbC9Key, clipKey, CLIP_FEATURES,
} from './concepts';
import { projectClips } from './clipRules';

export type MaterialCategory =
  | 'wreath' | 'wreath-bow' | 'wreath-fee'
  | 'garland' | 'garland-bow' | 'garland-fee'
  | 'spritzer' | 'spritzer-pole'
  | 'mini'
  | 'bulb' | 'clip';

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

// ── roofline (Slice 2b) helpers ──────────────────────────────────────────────
const ROOFLINE_SURFACES = new Set(['santas-roofline', 'gingerbread', 'winter-wonderland', 'stake-lighting']);
const CLIP_FEATURE_LABEL = new Map(CLIP_FEATURES.map((f) => [f.id, f.label]));

// Polyline length in photo pixels (mirrors editor-core strandLengthPx; kept inline
// so this stays a pure lib with no Konva import).
function polylineLengthPx(points: number[] | undefined): number {
  if (!Array.isArray(points)) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 2; i += 2) {
    total += Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
  }
  return total;
}

// Run length in FEET from the scene geometry: pixel length ÷ the run's yardstick
// px/ft (pxPerFoot falls back to 50 when the run references no yardstick).
function strandFeet(strand: StrandItem, scene: Scene): number {
  const lengthPx = polylineLengthPx(strand.points);
  if (!(lengthPx > 0)) return 0;
  const ys = (scene.yardsticks ?? []).find((y) => y.id === strand.yardstickId) ?? null;
  const ppf = pxPerFoot(ys);
  return ppf > 0 ? lengthPx / ppf : 0;
}

export function projectMaterials(scene: Scene, bindings: Bindings, clipRules: ClipRules = {}): MaterialLine[] {
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
      // A bow ships with EVERY wreath (Naldo) — both tiers. Only the decoration
      // fee (ornaments/ribbon labor) gates on Decorated.
      push(item.id, 'wreath-bow', wreathBowKey(size), 1, `${sl} wreath bow`);
      if (tier === 'fullDecor') {
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

    // Roofline run (Slice 2b): a c9 strand on a roofline surface → C9 bulbs (by
    // color) + clips (by physical roofFeature). Footage from the scene geometry.
    if (isStrand(item) && item.bulbType === 'c9' && ROOFLINE_SURFACES.has(item.surface ?? '')) {
      const feet = strandFeet(item, scene);
      if (feet > 0) {
        const pattern = item.colorPattern?.length ? item.colorPattern : [DEFAULT_PALETTE];
        const spacing = item.spacingIn && item.spacingIn > 0 ? item.spacingIn : 12;
        const bulbCount = Math.round((feet * 12) / spacing);
        if (bulbCount > 0) {
          // Split the run's bulbs across its distinct pattern colors (a single-color
          // roofline is the common case → one line).
          const counts = new Map<string, number>();
          for (const c of pattern) counts.set(c, (counts.get(c) ?? 0) + 1);
          for (const [paletteId, occ] of counts) {
            const qty = Math.round((bulbCount * occ) / pattern.length);
            push(item.id, 'bulb', bulbC9Key(paletteId), qty, `${colorLabel(paletteId)} C9 bulb × ${qty}`);
          }
        }
        // Clips come from the clip-rules config (NOT the bindings map), keyed by the
        // physical feature; metal/unset → no clip line.
        const clip = projectClips(item.roofFeature, feet, clipRules);
        if (clip) {
          const feat = item.roofFeature as string;
          out.push({
            sku: clip.sku,
            qty: clip.qty,
            category: 'clip',
            conceptKey: clipKey(feat),
            label: `${CLIP_FEATURE_LABEL.get(feat) ?? feat} clip × ${clip.qty}`,
            sceneItemId: item.id,
          });
        }
      }
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

// ── view assembly (#82 Slice 2d) ─────────────────────────────────────────────
// Join the projected lines with catalog names + on-hand stock into the display
// shape the materials view + the Slice-3 job pull list consume. Pure: the caller
// supplies the lookups (nameOf, onHandOf — onHandOf returns null when a SKU isn't
// stocked, NOT 0). `short` only when stocked AND below the needed quantity.
export type MaterialRow = { sku: string; name: string; qty: number; onHand: number | null; short: boolean };
export type UnboundConcept = { conceptKey: string; label: string; qty: number };
export type MaterialsView = { materials: MaterialRow[]; unbound: UnboundConcept[]; totalLines: number };

export function buildMaterialsView(
  lines: MaterialLine[],
  nameOf: (sku: string) => string | undefined,
  onHandOf: (sku: string) => number | null,
): MaterialsView {
  const materials: MaterialRow[] = aggregateMaterials(lines).map((a) => {
    const onHand = onHandOf(a.sku);
    return {
      sku: a.sku,
      name: nameOf(a.sku) ?? '(not in catalog)',
      qty: a.qty,
      onHand,
      short: onHand !== null && onHand < a.qty,
    };
  });
  // Unbound concepts: group the null-sku lines by conceptKey (summed qty).
  const unboundMap = new Map<string, UnboundConcept>();
  for (const l of lines) {
    if (l.sku) continue;
    const cur = unboundMap.get(l.conceptKey);
    if (cur) cur.qty += l.qty;
    else unboundMap.set(l.conceptKey, { conceptKey: l.conceptKey, label: l.label, qty: l.qty });
  }
  const unbound = [...unboundMap.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { materials, unbound, totalLines: lines.length };
}
