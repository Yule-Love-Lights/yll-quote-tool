// src/lib/inventory/resolveInstalls.ts
// #92 — the shared "what we'll actually install" resolver. Given a design's
// mini/spritzer items + the customer's effective color choice + which solid colors
// are OFFERED (from the live bindings), it decides, per item, EITHER a real pattern
// STRAND (rendered intermixed / ordered as one SKU) OR a single SOLID color
// (rendered solid / ordered via the per-color binding). Both the portal render and
// the materials projection consume this, so the picture the customer sees and the
// strands staff order can never disagree.
//
// Rules (docs/superpowers/specs/2026-06-28-light-patterns-design.md → "Revised design"):
//  - Match the effective color SET to a known pattern (order-ignored).
//  - Pattern with a strand for this product (+ size, for spritzers) → the strand.
//  - Otherwise → ROUND-ROBIN the OFFERED colors across the items, one solid each.
//  - A whole-house pick (choice != null) spreads across items; as-designed
//    (choice == null) reads each item's own authored colors (no shuffle — a
//    single-color item's 1-element candidate list always yields its own color).
//  - C9 roofline / wreaths / etc. are not colorable patterns here — ignored.
//
// Pure: callers pass the resolved color choice + the offered-color predicates
// (offeredFromBindings). No Supabase / React.

import type { SceneItem, QuoteSpritzerSize } from '@/lib/design/sceneTypes';
import { isStrand, isSpritzer, isMiniArea, isMiniGroup } from '@/lib/design/sceneTypes';
import type { Bindings } from './bindings';
import { matchPattern } from './patternSkus';
import { miniKey, spritzerKey } from './concepts';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';
import {
  resolveSchemeColorIds,
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEMES,
  type ColorScheme,
} from '@/lib/design/colorSchemes';

const DEFAULT_COLOR_ID = 'warm-white';
const DEFAULT_SPRITZER_SIZE: QuoteSpritzerSize = '24';
const MINI_SURFACES = new Set(['bush', 'tree', 'column', 'railing']);

// Palette id → catalog color label (cool-white → "Pure White"), matching the
// catalog-color-keyed mini bindings (mirrors materialsProjection's colorLabel).
const colorLabel = (paletteId: string) => DEFAULT_COLORS.find((c) => c.id === paletteId)?.label ?? paletteId;

// Which SOLID colors are offered per product type, derived from the live bindings:
// a color is offered for minis if `mini:<label>` is bound, for spritzers if
// `spritzer:<paletteId>:<size>` is bound (per size). Pattern STRANDS are carried by
// patternSkus (per-size for spritzers), not by this solid-color predicate.
export type OfferedColors = {
  miniHas: (paletteId: string) => boolean;
  spritzerHas: (paletteId: string, size: QuoteSpritzerSize) => boolean;
};

// WT-22(a): a bound-but-LOCKED (sold-out) sku is treated as NOT bound, so it's
// never "offered" — detectUnfulfillable flags the design item and the portal
// color picker / round-robin never selects it. `lockedSkus` is the set of
// catalog skus with `locked: true` (the caller reads the catalog); omitting it
// preserves the old "bound = offered" behavior.
const bound = (b: Bindings, key: string, lockedSkus?: Set<string>) => {
  const v = b[key];
  return typeof v === 'string' && v.length > 0 && !lockedSkus?.has(v);
};

export function offeredFromBindings(bindings: Bindings | null | undefined, lockedSkus?: Set<string>): OfferedColors {
  const b = bindings ?? {};
  return {
    miniHas: (id) => bound(b, miniKey(colorLabel(id)), lockedSkus),
    spritzerHas: (id, size) => bound(b, spritzerKey(id, size), lockedSkus),
  };
}

// The offered solids as plain arrays per type — the serializable shape a client
// (the builder / "From your design") fetches, then rebuilds into OfferedColors via
// offeredFromLists. Built server-side from the bindings.
export type OfferedColorLists = { mini: string[]; spritzer: Partial<Record<QuoteSpritzerSize, string[]>> };

const PALETTE_IDS = DEFAULT_COLORS.filter((c) => c.id !== 'black').map((c) => c.id);
const SPRITZER_SIZES: QuoteSpritzerSize[] = ['16', '24', '32'];

export function offeredColorLists(bindings: Bindings | null | undefined, lockedSkus?: Set<string>): OfferedColorLists {
  const o = offeredFromBindings(bindings, lockedSkus);
  return {
    mini: PALETTE_IDS.filter((id) => o.miniHas(id)),
    spritzer: Object.fromEntries(SPRITZER_SIZES.map((s) => [s, PALETTE_IDS.filter((id) => o.spritzerHas(id, s))])),
  };
}

// Rebuild OfferedColors predicates from the serialized lists (client-side).
export function offeredFromLists(lists: OfferedColorLists | null | undefined): OfferedColors {
  const mini = new Set(lists?.mini ?? []);
  const spritzer = lists?.spritzer ?? {};
  return {
    miniHas: (id) => mini.has(id),
    spritzerHas: (id, size) => (spritzer[size] ?? []).includes(id),
  };
}

// Whether the offered-colors are positively KNOWN — loaded AND a real catalog, not
// an unconfigured/empty/failed fetch. The fulfillability gate keys on this so a
// missing/empty/errored offered set fails OPEN (never falsely blocks Send) instead
// of flagging every item as "we can't supply it". A configured catalog always offers
// the solid mini colors, so an empty mini list means "unknown", not "we stock none".
export function offeredIsKnown(lists: OfferedColorLists | null | undefined): boolean {
  return !!lists && Array.isArray(lists.mini) && lists.mini.length > 0;
}

export type InstallDecision =
  // Order this strand SKU directly; render the pattern intermixed (colorIds).
  | { kind: 'strand'; sku: string; colorIds: string[]; patternId: string }
  // Render a single color; order it via the per-color binding (miniKey/spritzerKey).
  | { kind: 'solid'; colorId: string };

// The customer's effective whole-house color choice as resolved palette ids, or
// null = as-designed. Read from the frozen approval snapshot's customerSelection:
// a 'custom' (Build-your-own) scheme → its color ids; a named scheme → the scheme's
// ids; 'as-designed'/unknown/empty-custom → null.
export function resolveColorChoice(
  colorSchemeId: string | null | undefined,
  customPattern: string[] | null | undefined,
  schemes: ColorScheme[] = DEFAULT_COLOR_SCHEMES,
): string[] | null {
  if (colorSchemeId === CUSTOM_SCHEME_ID) {
    const cp = Array.isArray(customPattern) ? customPattern.filter((c) => typeof c === 'string') : [];
    return cp.length > 0 ? cp : null;
  }
  return resolveSchemeColorIds(colorSchemeId, schemes) ?? null;
}

// Pull the color choice out of a raw approval_snapshot jsonb (untyped). Returns null
// for a missing/un-approved snapshot → as-designed.
export function colorChoiceFromSnapshot(snapshot: unknown): string[] | null {
  const sel = (
    snapshot as {
      customerSelection?: { colorSchemeId?: unknown; customPattern?: unknown; colorIds?: unknown };
    } | null
  )?.customerSelection;
  if (!sel) return null;
  // #101: prefer the colorIds FROZEN at approve-time — resolved against the swatch
  // list the customer actually saw, so a later scheme edit can't shift a historical
  // order's materials (picture = order). Older snapshots have no frozen colorIds →
  // re-resolve the id against the BUILT-IN defaults (tolerant, unchanged behavior).
  if ('colorIds' in sel) {
    const frozen = sel.colorIds;
    if (frozen === null) return null;
    if (Array.isArray(frozen)) {
      const ids = frozen.filter((c): c is string => typeof c === 'string');
      return ids.length > 0 ? ids : null;
    }
  }
  const schemeId = typeof sel.colorSchemeId === 'string' ? sel.colorSchemeId : null;
  const customPattern = Array.isArray(sel.customPattern)
    ? sel.customPattern.filter((c): c is string => typeof c === 'string')
    : null;
  return resolveColorChoice(schemeId, customPattern);
}

type Colorable = { id: string; type: 'mini' | 'spritzer'; colors: string[]; size: QuoteSpritzerSize };

// Classify the colorable mini/spritzer items in scene order. Skips everything else:
// c9 roofline & unmapped strands, group-member strands (projected via their group),
// wreaths, garland, bows, text, custom, poles.
function colorables(items: SceneItem[]): Colorable[] {
  const out: Colorable[] = [];
  for (const item of items ?? []) {
    if (item.included === false) continue;
    if (isSpritzer(item)) {
      out.push({ id: item.id, type: 'spritzer', colors: item.colorPattern ?? [], size: item.quoteSize ?? DEFAULT_SPRITZER_SIZE });
    } else if (isStrand(item)) {
      if (item.groupId) continue; // projected via its MiniGroupItem
      if (!MINI_SURFACES.has(item.surface ?? '')) continue; // roofline / unmapped
      out.push({ id: item.id, type: 'mini', colors: item.colorPattern ?? [], size: DEFAULT_SPRITZER_SIZE });
    } else if (isMiniArea(item)) {
      if (!MINI_SURFACES.has(item.surface ?? '')) continue;
      out.push({ id: item.id, type: 'mini', colors: item.colorPattern ?? [], size: DEFAULT_SPRITZER_SIZE });
    } else if (isMiniGroup(item)) {
      out.push({ id: item.id, type: 'mini', colors: [], size: DEFAULT_SPRITZER_SIZE }); // members carry colors; bills as default
    }
  }
  return out;
}

/**
 * Resolve every colorable item to its install decision.
 * @param items   the full scene items (minis/spritzers are picked out; rest ignored)
 * @param choice  the customer's whole-house override color ids, or null = as-designed
 * @param offered which solid colors are offered per product type (from the bindings)
 */
export function resolveInstalls(
  items: SceneItem[],
  choice: string[] | null,
  offered: OfferedColors,
): Map<string, InstallDecision> {
  const result = new Map<string, InstallDecision>();
  const list = colorables(items);

  // Per-type round-robin cursor for the solid path (separate cycles per product type).
  const cursor: Record<'mini' | 'spritzer', number> = { mini: 0, spritzer: 0 };
  // A whole-house override matches once; as-designed matches per item below.
  const wholeHousePattern = choice ? matchPattern(choice) : null;

  for (const it of list) {
    const effective = choice ?? it.colors;
    const pattern = choice ? wholeHousePattern : matchPattern(it.colors);
    const has = (id: string) => (it.type === 'mini' ? offered.miniHas(id) : offered.spritzerHas(id, it.size));

    // 1. Strand path — a matched pattern with a strand for this product (+ size).
    if (pattern) {
      const strandSku = it.type === 'mini' ? pattern.miniSku : pattern.spritzerSku?.[it.size];
      if (strandSku) {
        result.set(it.id, { kind: 'strand', sku: strandSku, colorIds: pattern.colorSet, patternId: pattern.id });
        continue;
      }
    }

    // 2. Solid path — round-robin the OFFERED chosen colors across items of this type.
    const candidates = [...new Set(effective)].filter(has);
    if (candidates.length > 0) {
      // A whole-house override round-robins across items; as-designed (choice null)
      // is deterministic per item — each keeps its first offered authored color
      // (≈ the pre-#92 colorPattern[0]), so two identical items don't drift apart.
      const idx = choice ? cursor[it.type]++ : 0;
      result.set(it.id, { kind: 'solid', colorId: candidates[idx % candidates.length] });
      continue;
    }

    // 3. Fallback — none of the chosen colors are offered for this item → fall back
    // to its as-designed color (offered if possible; the operator gate guarantees a
    // sent design's as-designed colors are fulfillable).
    const authored = [...new Set(it.colors)];
    const fallback = authored.find(has) ?? it.colors[0] ?? DEFAULT_COLOR_ID;
    result.set(it.id, { kind: 'solid', colorId: fallback });
  }

  return result;
}

// #92 — the per-item RENDER colors for a whole-house override (consumed by the
// portal renderer). Each colorable item → its strand's colors (intermixed) or its
// single solid color; C9 roofline / other light strands get the full choice cycle
// (multi-color is installable there). A mini-group's decision propagates to its
// member strands (they render individually). null choice (as-designed) → null = no
// override (render the authored colors). Mirrors resolveInstalls so the picture the
// customer sees matches the strands staff order.
export function buildRenderColorMap(
  items: SceneItem[],
  choice: string[] | null,
  offered: OfferedColors,
): Map<string, string[]> | null {
  if (!choice || choice.length === 0) return null;
  const list = items ?? [];
  const installs = resolveInstalls(list, choice, offered);
  // Propagate each mini-group's decision to its member strands.
  const decisionById = new Map(installs);
  for (const item of list) {
    if (isMiniGroup(item)) {
      const d = installs.get(item.id);
      if (d) for (const mid of item.memberIds ?? []) decisionById.set(mid, d);
    }
  }
  const map = new Map<string, string[]>();
  for (const item of list) {
    if (!(isStrand(item) || isSpritzer(item) || isMiniArea(item))) continue; // only light items recolor
    const d = decisionById.get(item.id);
    if (d) map.set(item.id, d.kind === 'strand' ? d.colorIds : [d.colorId]);
    else map.set(item.id, choice); // roofline c9 / unclassified strand → full cycle
  }
  return map;
}
