// src/lib/inventory/materialsProjection.ts
// PER-UNIT MATERIALS PROJECTOR (#82 Slice 2a). Pure function: a design Scene +
// the inventory `bindings` → the per-unit material lines ({sku, qty}) for wreaths
// (base + bow + decoration fee), garland, spritzers (spritzer + pole), and
// mini-light wraps. A parallel of src/lib/design/projectScene.ts (which turns the
// same items into PRICING inputs), but reading the bindings instead.
//
// Roofline materials (Slice 2b): c9 roofline runs project C9 bulbs (by color) +
// clips (by the run's roofFeature, via clipRules) + socket wire (standard, or
// magnetic on metal roofs). Footage is derived from the scene GEOMETRY (run length
// ÷ the yardstick's px/ft) — the only source available in the materials-view
// context (the quote's billed footage is a separate concern, flagged in design
// spec §10). Standalone bows have no binding concept yet → not projected here.
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
  WIRE_C9_KEY, WIRE_MAGNETIC_KEY,
} from './concepts';
import { projectClips } from './clipRules';
import { resolveInstalls, offeredFromBindings } from './resolveInstalls';

export type MaterialCategory =
  | 'wreath' | 'wreath-bow' | 'wreath-fee'
  | 'garland' | 'garland-bow' | 'garland-fee'
  | 'spritzer' | 'spritzer-pole'
  | 'mini'
  | 'bulb' | 'clip' | 'wire';

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

export function projectMaterials(
  scene: Scene,
  bindings: Bindings,
  clipRules: ClipRules = {},
  // #92 — the customer's whole-house color choice (resolved palette ids), or null
  // = as-designed. Drives which mini/spritzer SKU each item resolves to.
  colorChoice: string[] | null = null,
): MaterialLine[] {
  const out: MaterialLine[] = [];
  const items = Array.isArray(scene?.items) ? scene.items : [];
  const b = bindings ?? {};

  // #92 — per mini/spritzer item: a real pattern STRAND (one SKU) or a SOLID color
  // (round-robin of the OFFERED colors). Both this projection and the portal render
  // consume the same resolver so the order and the picture can't disagree.
  const installs = resolveInstalls(items, colorChoice, offeredFromBindings(b));

  const push = (sceneItemId: string, category: MaterialCategory, conceptKey: string, qty: number, label: string) => {
    if (qty <= 0) return;
    out.push({ sku: skuOf(b, conceptKey), qty, category, conceptKey, label, sceneItemId });
  };

  for (const item of items) {
    if (!isIncluded(item)) continue;
    // #13 linked twins: a render-only depiction of an item on another photo —
    // the CANONICAL item pulls materials; twins never do (same pattern as the
    // groupId member skips below).
    if (item.linkedToId) continue;

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
      const decision = installs.get(item.id);
      if (decision?.kind === 'strand') {
        // A matched pattern with a spritzer strand for this size → order it directly.
        out.push({ sku: decision.sku, qty: 1, category: 'spritzer', conceptKey: spritzerKey(decision.patternId, size), label: `${size}" ${decision.patternId} spritzer`, sceneItemId: item.id });
      } else {
        const paletteId = decision?.kind === 'solid' ? decision.colorId : (item.colorPattern?.[0] ?? DEFAULT_PALETTE);
        push(item.id, 'spritzer', spritzerKey(paletteId, size), 1, `${size}" ${colorLabel(paletteId)} spritzer`);
      }
      push(item.id, 'spritzer-pole', spritzerPoleKey(size), 1, `${size}" spritzer pole`);
      continue;
    }

    // Roofline run (Slice 2b): a c9 strand on a roofline surface → C9 bulbs (by
    // color) + clips (by physical roofFeature). Footage from the scene geometry.
    if (isStrand(item) && item.bulbType === 'c9' && ROOFLINE_SURFACES.has(item.surface ?? '')) {
      const feet = strandFeet(item, scene);
      if (feet > 0) {
        const pattern = item.colorPattern?.length ? item.colorPattern : [DEFAULT_PALETTE];
        // Jason's ruling (2026-08-20, row 248 follow-up): the drawn spacingIn is
        // DESIGN-ONLY aesthetics — crews install every real job at the standard
        // 12" C9 spacing regardless of what the operator drew. Ordering off the
        // drawn value under- or over-bought bulbs whenever a run was drawn at a
        // non-12 spacing (24" drawn = half the bulbs the job actually uses), so
        // the projection deliberately ignores item.spacingIn here.
        const C9_INSTALL_SPACING_IN = 12;
        const bulbCount = Math.round((feet * 12) / C9_INSTALL_SPACING_IN);
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
        // Socket wire — one foot per roofline foot. Metal roofs take MAGNETIC wire
        // (and no clips); everything else takes standard C9 socket wire.
        const isMetal = item.roofFeature === 'metal';
        const wireFt = Math.ceil(feet);
        push(
          item.id,
          'wire',
          isMetal ? WIRE_MAGNETIC_KEY : WIRE_C9_KEY,
          wireFt,
          `${isMetal ? 'Magnetic' : 'C9'} socket wire × ${wireFt} ft`,
        );
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
      const decision = installs.get(item.id);
      if (decision?.kind === 'strand') {
        // A matched pattern → order N strings of its mini strand directly.
        out.push({ sku: decision.sku, qty: stringCount, category: 'mini', conceptKey: miniKey(decision.patternId), label: `${decision.patternId} mini (${surface}) × ${stringCount}`, sceneItemId: item.id });
      } else {
        const colorId = decision?.kind === 'solid' ? decision.colorId : paletteId;
        const label = colorLabel(colorId);
        push(item.id, 'mini', miniKey(label), stringCount, `${label} mini (${surface}) × ${stringCount}`);
      }
      continue;
    }

    // roofline strands / bows / text / custom / pole / unmapped → not projected here.
  }

  return out;
}

// Aggregate to orderable {sku, qty} totals: sum by sku, drop unbound (null), sort.
// WT-22(c): also drop a LOCKED (sold-out) sku — it must never be counted as
// orderable demand, however it was projected. `lockedSkus` is optional so
// existing callers that don't care about locks are unaffected.
export function aggregateMaterials(lines: MaterialLine[], lockedSkus?: Set<string>): { sku: string; qty: number }[] {
  const sums = new Map<string, number>();
  for (const l of lines) {
    if (!l.sku) continue;
    if (lockedSkus?.has(l.sku)) continue;
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
//
// WT-22(c) / WT-23: `lockedSkus` / `hiddenSkus` are the catalog's operator
// overrides (locked = sold-out, hidden = the sku's effective category is
// hidden), pre-computed by the caller from listCatalog() + getHiddenCategories()
// (catalog.ts's own comment: "the Slice 2 materials engine must compute the same
// effective category to honor hides"). A LOCKED material still needs a job —
// it's flagged (`locked: true`) rather than dropped, so staff see it needs
// manual sourcing instead of the demand silently vanishing. A HIDDEN-category
// sku means the operator no longer uses it at all, so it's dropped entirely —
// same treatment as the picker/search views (skuSearch.ts).
export type MaterialRow = { sku: string; name: string; qty: number; onHand: number | null; short: boolean; locked: boolean };
export type UnboundConcept = { conceptKey: string; label: string; qty: number };
export type MaterialsView = { materials: MaterialRow[]; unbound: UnboundConcept[]; totalLines: number };

export function buildMaterialsView(
  lines: MaterialLine[],
  nameOf: (sku: string) => string | undefined,
  onHandOf: (sku: string) => number | null,
  lockedSkus: Set<string> = new Set(),
  hiddenSkus: Set<string> = new Set(),
): MaterialsView {
  const materials: MaterialRow[] = aggregateMaterials(lines)
    .filter((a) => !hiddenSkus.has(a.sku))
    .map((a) => {
      const onHand = onHandOf(a.sku);
      return {
        sku: a.sku,
        name: nameOf(a.sku) ?? '(not in catalog)',
        qty: a.qty,
        onHand,
        short: onHand !== null && onHand < a.qty,
        locked: lockedSkus.has(a.sku),
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
