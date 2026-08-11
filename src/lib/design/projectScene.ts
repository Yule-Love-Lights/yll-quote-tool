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
//   • Anything unmapped (text, custom, pole, permanent, bistro, or a strand
//     with no recognized `surface`) renders but produces no line item (§2).
//     (Standalone BOWS used to be on that list — they project as of #28.)
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

import type { Scene, MiniBilling } from './sceneTypes';
import { isStrand, isWreath, isGarland, isSpritzer, isBow, isMiniArea, isMiniGroup } from './sceneTypes';
import type {
  MiniLightItem,
  Spritzer,
  Wreath,
  GarlandItem as PriceGarland,
  BowLineInput,
  QuoteInputs,
} from '@/lib/pricing/pricingEngine';
import type { BistroLine } from '@/lib/event/types';
import type { ServiceType } from '@/lib/serviceType';
import { pxPerFoot } from '@/components/design/editor-core/yardstick-scale';

export type ProjectedCategory = 'mini' | 'spritzer' | 'wreath' | 'garland' | 'bow';

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
// `recommended` (#12) rides along from the source scene item so the portal can
// pre-select + label staff-advised items. Optional/additive — undefined unless
// staff flagged the scene item.
// `needsReview` (audit fix, Finding #38): true when a billed spec field was
// undefined and the projection fell back to a DEFAULT_* value, so the UI can
// surface a "defaulted — confirm size/tier" cue. Optional/additive.
export type ProjectedLineItem =
  | { id: string; category: 'mini'; sceneItemIds: string[]; input: MiniLightItem; recommended?: boolean; needsReview?: boolean }
  | { id: string; category: 'spritzer'; sceneItemIds: string[]; input: Spritzer; recommended?: boolean; needsReview?: boolean }
  | { id: string; category: 'wreath'; sceneItemIds: string[]; input: Wreath; recommended?: boolean; needsReview?: boolean }
  | { id: string; category: 'garland'; sceneItemIds: string[]; input: PriceGarland; recommended?: boolean; needsReview?: boolean }
  | { id: string; category: 'bow'; sceneItemIds: string[]; input: BowLineInput; recommended?: boolean; needsReview?: boolean };

export type Projection = {
  // Ready to drop into QuoteInputs. The builder adds roofline footage, takedown,
  // rushFee, discount around these.
  miniLightItems: MiniLightItem[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: PriceGarland[];
  bows: BowLineInput[];
  // Bistro runs (event #96 / permanent_bistro #117) — footage-priced from drawn
  // bulbType='bistro' strands. applyProjectionToInputs applies this to
  // inputs.event.bistro or inputs.permanentBistro.bistro depending on the
  // vertical (see its `serviceType` param); the holiday/permanent engines
  // ignore it either way.
  bistro: BistroLine[];
  // The linkage-carrying view. The arrays above are derived from this (same
  // order), so the Nth entry of a category here lines up with the Nth engine
  // line item for that category.
  items: ProjectedLineItem[];
  // Audit fix (Finding #103): true when the scene contains ANY item that maps to
  // a per-unit category REGARDLESS of its `included` flag. Distinguishes a true
  // legacy/roofline-only design (false → manual fallback) from an all-excluded
  // design (true, but items empty → REPLACE with empties, dropping stale arrays).
  hasProjectableItems: boolean;
};

function isIncluded(item: { included?: boolean }): boolean {
  return item.included !== false; // default true
}

// The mini-light surfaces that project to a priced mini unit. Railing prices
// like a bush (canopy/standard rate, no wrap style) — see calculateMiniLights.
type MiniSurface = 'bush' | 'tree' | 'column' | 'railing' | 'curtain';
function asMiniSurface(s: unknown): MiniSurface | null {
  return s === 'bush' || s === 'tree' || s === 'column' || s === 'railing' || s === 'curtain' ? s : null;
}

// Audit fix (Finding #103): does this scene item map to a per-unit category,
// IGNORING its `included` flag? Mirrors the per-category branches in projectScene
// but without the include/exclude gate, so an all-excluded design still registers
// as "has projectable items" (and thus replaces rather than falls back).
function isProjectableItem(item: Scene['items'][number]): boolean {
  // #13 linked twins are render-only depictions — never projectable.
  if (item.linkedToId) return false;
  if (isStrand(item)) return !item.groupId && asMiniSurface(item.surface) !== null;
  if (isMiniArea(item)) return asMiniSurface(item.surface) !== null;
  if (isMiniGroup(item)) return asMiniSurface(item.surface) !== null;
  if (isSpritzer(item)) return true;
  if (isWreath(item)) return true;
  if (isGarland(item)) return true;
  if (isBow(item)) return true;
  return false;
}

// Bistro run length in FEET (event, #96) — mirrors materialsProjection's
// strandFeet: pixel polyline length ÷ the run's yardstick px/ft. Kept inline so
// projectScene stays a pure lib (no Konva). Bistro is footage-priced and keyed on
// bulbType='bistro' (no mini surface), so drawn bistro flows into the event price.
function polylineLengthPx(points: number[] | undefined): number {
  if (!Array.isArray(points)) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 2; i += 2) {
    total += Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
  }
  return total;
}
function bistroFeet(strand: { points?: number[]; yardstickId?: string | null }, scene: Scene): number {
  const lengthPx = polylineLengthPx(strand.points);
  if (!(lengthPx > 0)) return 0;
  const ys = (scene.yardsticks ?? []).find((y) => y.id === strand.yardstickId) ?? null;
  const ppf = pxPerFoot(ys);
  return ppf > 0 ? lengthPx / ppf : 0;
}

// One priced mini unit, shared across all three authoring paths (strand wrap,
// area fill, grouped railing) so they price identically (#27 A2).
function miniInput(type: MiniSurface, billing: MiniBilling): MiniLightItem {
  return {
    type,
    wrapStyle: billing.wrapStyle ?? 'canopy',
    stringCount: Math.max(1, Math.round(billing.stringCount ?? 1)),
  };
}

export function projectScene(scene: Scene): Projection {
  const items: ProjectedLineItem[] = [];
  const bistro: BistroLine[] = [];
  const sceneItems = Array.isArray(scene?.items) ? scene.items : [];
  // #227 defensive guard: the id set of strand items still IN the scene, used
  // below to skip a miniGroup that has been fully orphaned (every member
  // strand deleted, none surviving). This is belt-and-braces — the editor-core
  // fix (pruneOrphanedMiniGroups) is meant to delete such a group the moment
  // its last member goes, so a healthy scene never reaches this branch — but
  // projectScene is on the pricing path, so it gets its own guard too.
  const liveStrandIds = new Set(sceneItems.filter(isStrand).map((i) => i.id));

  for (const item of sceneItems) {
    if (!isIncluded(item)) continue;
    // #13 linked twins: a render-only depiction of an item on another photo —
    // the CANONICAL item bills; twins never project (same pattern as grouped
    // strands below).
    if (item.linkedToId) continue;

    if (isStrand(item)) {
      // A grouped strand (a railing member) is priced via its MiniGroupItem —
      // skip it here so the unit isn't double-counted (#27 A2).
      if (item.groupId) continue;
      // Bistro strands (event, #96) — footage-priced, keyed on bulbType (bistro has
      // no mini surface). Drawn bistro flows into the event price via inputs.event.
      if (item.bulbType === 'bistro') {
        const footage = bistroFeet(item, scene);
        if (footage > 0) bistro.push({ footage, id: `bistro-${item.id}`, sceneItemIds: [item.id] });
        continue;
      }
      // Strands disambiguate by `surface`: bush/tree/column/railing = a mini-light
      // wrap (projected); santas-roofline/gingerbread/winter-wonderland = roofline
      // (measurement-driven, NOT projected); no surface = unmapped.
      const s = asMiniSurface(item.surface);
      if (s) {
        items.push({ id: `mini-${item.id}`, category: 'mini', sceneItemIds: [item.id], input: miniInput(s, item), recommended: item.recommended });
      }
      continue;
    }

    // A2: a mini-light AREA fill → one mini unit (hides as its own item).
    if (isMiniArea(item)) {
      const s = asMiniSurface(item.surface);
      if (s) {
        items.push({ id: `mini-${item.id}`, category: 'mini', sceneItemIds: [item.id], input: miniInput(s, item), recommended: item.recommended });
      }
      continue;
    }

    // A2: a grouped railing → one mini unit. The members are what render, so the
    // portal hides/shows them as a unit (sceneItemIds = the member ids).
    if (isMiniGroup(item)) {
      // #227: FULLY orphaned (had members, none survive) → never bill it. A
      // PARTIALLY orphaned group (at least one member still alive) bills
      // normally, unchanged — same as a zero-member group (never this bug).
      const isFullyOrphaned =
        item.memberIds.length > 0 && !item.memberIds.some((id) => liveStrandIds.has(id));
      if (isFullyOrphaned) continue;
      const s = asMiniSurface(item.surface);
      if (s) {
        const sceneItemIds = item.memberIds.length > 0 ? [...item.memberIds] : [item.id];
        items.push({ id: `mini-${item.id}`, category: 'mini', sceneItemIds, input: miniInput(s, item), recommended: item.recommended });
      }
      continue;
    }

    if (isSpritzer(item)) {
      // Audit fix (Finding #38): flag a defaulted billed size so the UI can cue
      // staff that no size was set (priced at DEFAULT_SPRITZER_SIZE).
      const needsReview = item.quoteSize === undefined;
      items.push({
        id: `spritzer-${item.id}`,
        category: 'spritzer',
        sceneItemIds: [item.id],
        input: { size: item.quoteSize ?? DEFAULT_SPRITZER_SIZE, quantity: 1 },
        recommended: item.recommended,
        needsReview,
      });
      continue;
    }

    if (isWreath(item)) {
      // Audit fix (Finding #38): flag when size OR tier defaulted.
      const needsReview = item.quoteSize === undefined || item.tier === undefined;
      items.push({
        id: `wreath-${item.id}`,
        category: 'wreath',
        sceneItemIds: [item.id],
        input: {
          size: item.quoteSize ?? DEFAULT_WREATH_SIZE,
          tier: item.tier ?? DEFAULT_WREATH_TIER,
          quantity: 1,
        },
        recommended: item.recommended,
        needsReview,
      });
      continue;
    }

    if (isGarland(item)) {
      const sections = Math.max(1, Math.round(item.quoteSections ?? 1));
      // Audit fix (Finding #38): flag when length OR tier defaulted.
      const needsReview = item.quoteLength === undefined || item.tier === undefined;
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
        recommended: item.recommended,
        needsReview,
      });
      continue;
    }

    // Standalone bow (#28) — per-instance like everything else: one drawn bow =
    // one "Bow" line item = one toggle. No tag needed (a bow is always a bow);
    // flat price each (drawn size is visual-only; rate TBD by Naldo, $0 today).
    if (isBow(item)) {
      items.push({ id: `bow-${item.id}`, category: 'bow', sceneItemIds: [item.id], input: { quantity: 1 }, recommended: item.recommended });
      continue;
    }

    // text / custom / pole + any unmapped item → renders, no line item.
  }

  return {
    miniLightItems: items.filter((i) => i.category === 'mini').map((i) => i.input as MiniLightItem),
    spritzers: items.filter((i) => i.category === 'spritzer').map((i) => i.input as Spritzer),
    wreaths: items.filter((i) => i.category === 'wreath').map((i) => i.input as Wreath),
    garland: items.filter((i) => i.category === 'garland').map((i) => i.input as PriceGarland),
    bows: items.filter((i) => i.category === 'bow').map((i) => i.input as BowLineInput),
    bistro,
    items,
    // Audit fix (Finding #103): scan ALL items (not just included ones) so an
    // all-excluded design is still recognized as design-driven.
    hasProjectableItems: sceneItems.some(isProjectableItem),
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
export function applyProjectionToInputs(inputs: QuoteInputs, scene: Scene, serviceType?: ServiceType): QuoteInputs {
  const p = projectScene(scene);
  // Bistro's TARGET block depends on the vertical: permanent_bistro prices from
  // inputs.permanentBistro.bistro (calculatePermanentBistro); every other
  // vertical (event, holiday) keeps the original inputs.event.bistro target.
  // Bistro strands are footage-priced identically either way — only the block
  // they land in differs, so a permanent_bistro quote must NEVER get an
  // inputs.event block created/touched.
  // #117 satellite migration: the /api/quote route no longer calls
  // applyProjectionToInputs at all for permanent_bistro (the route's design-
  // projection gate is `!isPermanent && !isPermanentBistro`) — bistro footage
  // bills from the client-sent satellite polylines, not the design's street
  // scene. This isBistroVertical branch is now dead code for that vertical;
  // event still routes bistro through here, so it stays.
  const isBistroVertical = serviceType === 'permanent_bistro';
  // Audit fix (Finding #103): only fall back to the request's manual per-unit
  // arrays for a TRUE legacy/roofline-only design (no projectable items at all).
  // A design where staff excluded EVERY per-unit item has hasProjectableItems
  // true but items empty — it must fall through and REPLACE the arrays with
  // empties, so the excluded items aren't silently resurrected from stale input.
  //
  // Fix #4 (holiday manual items wiped, commit 23ee261): a scene with NO
  // projectable per-unit items but a drawn bistro run must NOT fall through to
  // the REPLACE path below — bistro has no per-unit representation to conflict
  // with, so it must never be the reason manual miniLightItems/spritzers/
  // wreaths/garland/bows get overwritten with empty arrays. Preserve the manual
  // arrays here and only layer `event.bistro` (or `permanentBistro.bistro`) on
  // top.
  if (p.items.length === 0 && !p.hasProjectableItems) {
    if (p.bistro.length === 0) return inputs;
    return isBistroVertical
      ? { ...inputs, permanentBistro: { ...inputs.permanentBistro, bistro: p.bistro } }
      : { ...inputs, event: { ...inputs.event, bistro: p.bistro } };
  }
  // #104: thread each projected line's stable id + scene item ids onto the priced
  // input (same order as p.miniLightItems etc.), so calculateQuote can emit them on
  // the LineItem and the override/scene-link can key by identity, not list position.
  // A category-narrowing filter keeps `i.input` correctly typed per category.
  const forCategory = <C extends ProjectedCategory>(category: C) =>
    p.items.filter((i): i is Extract<ProjectedLineItem, { category: C }> => i.category === category);
  return {
    ...inputs,
    miniLightItems: forCategory('mini').map((i) => ({ ...i.input, id: i.id, sceneItemIds: i.sceneItemIds })),
    spritzers: forCategory('spritzer').map((i) => ({ ...i.input, id: i.id, sceneItemIds: i.sceneItemIds })),
    wreaths: forCategory('wreath').map((i) => ({ ...i.input, id: i.id, sceneItemIds: i.sceneItemIds })),
    garland: forCategory('garland').map((i) => ({ ...i.input, id: i.id, sceneItemIds: i.sceneItemIds })),
    bows: forCategory('bow').map((i) => ({ ...i.input, id: i.id, sceneItemIds: i.sceneItemIds })),
    // Bistro (#96/#117): drawn bistro runs drive the vertical's own bistro block
    // (design is master, like minis), preserving any operator-typed fields
    // (event's barrels/dates, permanentBistro's poles). Only set when there IS
    // bistro or an existing target block, so quotes without bistro/event/
    // permanentBistro data stay clean — and a permanent_bistro quote never gets
    // an inputs.event block.
    ...(isBistroVertical
      ? p.bistro.length > 0 || inputs.permanentBistro
        ? { permanentBistro: { ...inputs.permanentBistro, bistro: p.bistro } }
        : {}
      : p.bistro.length > 0 || inputs.event
        ? { event: { ...inputs.event, bistro: p.bistro } }
        : {}),
  };
}
