// PROJECTION — design Scene → per-unit pricing inputs (data contract §5/§7).
//
// The design scene is the MASTER LIST for per-unit items (mini-light wraps,
// spritzers, wreaths, garland). This pure function turns those scene items into
// the typed `QuoteInputs` slices the pricing engine already knows how to price.
// It does NOT price anything itself — pricing stays in `pricingEngine`
// (`BUSINESS_RULES`). This module only reads the staff-set quantities/specs +
// builds the linkage.
//
// VISUAL vs BILLED (Jason, S5): a drawn item's on-canvas size is VISUAL ONLY —
// staff pick whatever looks best on the photo. The REAL billed spec lives in
// separate staff-set fields (`quoteSize` / `quoteLength` / `quoteSections` /
// `stringCount`), so the projection reads those, never the visual `sizeIn`.
// Sensible defaults apply when a field is unset (so nothing is ever unpriced).
//
// Two things stay OUT of the projection (by design — data contract §7):
//   • Roofline (Santa's / Gingerbread / Winter Wonderland) is MEASUREMENT-driven
//     (footage × rate). Roofline scene strands are visual + toggle binding only.
//   • Anything unmapped (text, custom, bow, pole, permanent, bistro, or a strand
//     with no recognized `surface`) renders but produces no line item (§2).
//
// LINKAGE ("live from design" model): every projected line item carries the
// scene-item id(s) it controls and a stable `id`. The portal re-derives this at
// read time so toggling a line item hides exactly the drawn item(s) it maps to,
// and editing the design changes the projected line items automatically.
//
// GRANULARITY: per-instance — one drawn item = one line item = one toggle
// (Jason, S5). Matches mini-lights + the live picture↔toggle 1:1 intent. (This
// refines data-contract §5's "grouped by size/tier" wording, which predates the
// "live from design" decision.)

import type { Scene } from './sceneTypes';
import { isStrand, isWreath, isGarland, isSpritzer } from './sceneTypes';
import type {
  MiniLightItem,
  Spritzer,
  Wreath,
  GarlandItem as PriceGarland,
  QuoteInputs,
} from '@/lib/pricing/pricingEngine';

export type ProjectedCategory = 'mini' | 'spritzer' | 'wreath' | 'garland';

// Default billed specs when staff haven't set them (per Jason S5). The editor
// seeds these on creation too; these are the projection's safety net so an
// untagged item still prices instead of crashing/zeroing.
const DEFAULT_SPRITZER_SIZE = '24' as const;
const DEFAULT_WREATH_SIZE = '36noble' as const;
const DEFAULT_WREATH_TIER = 'bow' as const; // with bow, no decor
const DEFAULT_GARLAND_LENGTH = '9ft' as const;
const DEFAULT_GARLAND_TIER = 'fullDecor' as const; // no bow, with decor

// One projected line item + the scene item(s) it controls. `input` is the exact
// shape the pricing engine consumes for that category (quantity is per-instance:
// 1, except garland where it's the staff-set section count).
export type ProjectedLineItem =
  | { id: string; category: 'mini'; sceneItemIds: string[]; input: MiniLightItem }
  | { id: string; category: 'spritzer'; sceneItemIds: string[]; input: Spritzer }
  | { id: string; category: 'wreath'; sceneItemIds: string[]; input: Wreath }
  | { id: string; category: 'garland'; sceneItemIds: string[]; input: PriceGarland };

export type Projection = {
  // Ready to drop into QuoteInputs. The builder adds roofline footage, takedown,
  // rushFee, discount around these.
  miniLightItems: MiniLightItem[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: PriceGarland[];
  // The linkage-carrying view. The arrays above are derived from this (same
  // order), so the Nth entry of a category here lines up with the Nth engine
  // line item for that category.
  items: ProjectedLineItem[];
};

function isIncluded(item: { included?: boolean }): boolean {
  return item.included !== false; // default true
}

export function projectScene(scene: Scene): Projection {
  const items: ProjectedLineItem[] = [];
  const sceneItems = Array.isArray(scene?.items) ? scene.items : [];

  for (const item of sceneItems) {
    if (!isIncluded(item)) continue;

    if (isStrand(item)) {
      // Strands disambiguate by `surface`: bush/tree/column = a mini-light wrap
      // (projected); santas-roofline/gingerbread/winter-wonderland = roofline
      // (measurement-driven, NOT projected); no surface = unmapped.
      const s = item.surface;
      if (s === 'bush' || s === 'tree' || s === 'column') {
        const stringCount = Math.max(1, Math.round(item.stringCount ?? 1));
        items.push({
          id: `mini-${item.id}`,
          category: 'mini',
          sceneItemIds: [item.id],
          input: { type: s, wrapStyle: item.wrapStyle ?? 'canopy', stringCount },
        });
      }
      continue;
    }

    if (isSpritzer(item)) {
      items.push({
        id: `spritzer-${item.id}`,
        category: 'spritzer',
        sceneItemIds: [item.id],
        input: { size: item.quoteSize ?? DEFAULT_SPRITZER_SIZE, quantity: 1 },
      });
      continue;
    }

    if (isWreath(item)) {
      items.push({
        id: `wreath-${item.id}`,
        category: 'wreath',
        sceneItemIds: [item.id],
        input: {
          size: item.quoteSize ?? DEFAULT_WREATH_SIZE,
          tier: item.tier ?? DEFAULT_WREATH_TIER,
          quantity: 1,
        },
      });
      continue;
    }

    if (isGarland(item)) {
      const sections = Math.max(1, Math.round(item.quoteSections ?? 1));
      items.push({
        id: `garland-${item.id}`,
        category: 'garland',
        sceneItemIds: [item.id],
        input: {
          length: item.quoteLength ?? DEFAULT_GARLAND_LENGTH,
          type: 'noble',
          tier: item.tier ?? DEFAULT_GARLAND_TIER,
          quantity: sections,
        },
      });
      continue;
    }

    // bow / text / custom / pole + any unmapped item → renders, no line item.
  }

  return {
    miniLightItems: items.filter((i) => i.category === 'mini').map((i) => i.input as MiniLightItem),
    spritzers: items.filter((i) => i.category === 'spritzer').map((i) => i.input as Spritzer),
    wreaths: items.filter((i) => i.category === 'wreath').map((i) => i.input as Wreath),
    garland: items.filter((i) => i.category === 'garland').map((i) => i.input as PriceGarland),
    items,
  };
}

// Merge a design's projection INTO a quote's inputs for pricing (#27 sub-step C).
//
// The design is the master list for per-unit items, so when its scene has any
// projectable per-unit item we REPLACE the inputs' per-unit arrays with the
// projection. Everything else (roofline footage — measurement-driven — plus
// takedown/rush/discount/customLineItems) passes through untouched.
//
// Fallback (Jason S5, decision 2a + the pre-A1 transition): if the scene has NO
// projectable per-unit items, return the inputs UNCHANGED so the builder's manual
// per-unit entry still drives the quote. This keeps no-design / legacy quotes
// working today and means design-driven pricing activates cleanly the moment
// staff start tagging items (once the editor's binding UI lands).
export function applyProjectionToInputs(inputs: QuoteInputs, scene: Scene): QuoteInputs {
  const p = projectScene(scene);
  if (p.items.length === 0) return inputs;
  return {
    ...inputs,
    miniLightItems: p.miniLightItems,
    spritzers: p.spritzers,
    wreaths: p.wreaths,
    garland: p.garland,
  };
}
