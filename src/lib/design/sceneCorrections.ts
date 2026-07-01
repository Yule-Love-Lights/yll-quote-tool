// #52 — pure scene-correction helpers for editing a saved training example's
// detections: mini strand counts (bush/tree/column), spritzer size, wreath
// size + tier, garland length + tier — all the fields that feed the few-shot.
// Client-safe: imports ONLY sceneTypes (no designs/sharp), so the training-
// examples review page (a client component) can use them without dragging the
// server-only trainingExamples → designs → sharp chain into the browser bundle.

import {
  isStrand,
  isMiniArea,
  isMiniGroup,
  isSpritzer,
  isWreath,
  isGarland,
  type Scene,
  type SceneItem,
  type QuoteSpritzerSize,
  type QuoteWreathSize,
  type QuoteGarlandLength,
  type Tier,
} from './sceneTypes';

export type MiniSurface = 'bush' | 'tree' | 'column' | 'railing' | 'curtain';
const MINI_SURFACES: MiniSurface[] = ['bush', 'tree', 'column', 'railing', 'curtain'];
// Upper bound on a corrected strand count — generous enough to never trip a real
// wrap, low enough that a crafted value can't poison a few-shot label.
const MAX_STRING_COUNT = 500;

export const SPRITZER_SIZES: QuoteSpritzerSize[] = ['16', '24', '32'];
export const WREATH_SIZES: QuoteWreathSize[] = ['24noble', '30noble', '36noble', '48noble', '60noble', '72noble'];
export const GARLAND_LENGTHS: QuoteGarlandLength[] = ['4.5ft', '9ft'];
export const TIERS: Tier[] = ['bow', 'fullDecor'];

// One correctable detection, with its current values. `kind` drives which
// control the editor shows.
export type EditableItem =
  | { id: string; kind: 'mini'; surface: MiniSurface; stringCount: number }
  | { id: string; kind: 'spritzer'; quoteSize: QuoteSpritzerSize }
  | { id: string; kind: 'wreath'; quoteSize: QuoteWreathSize; tier: Tier }
  | { id: string; kind: 'garland'; quoteLength: QuoteGarlandLength; tier: Tier };

// A per-item correction the editor sends back. All optional; only the fields
// valid for the item's kind are applied.
export type ItemCorrection = {
  stringCount?: number;
  quoteSize?: string;
  tier?: string;
  quoteLength?: string;
};

// Mini-light items whose strand count staff can correct: ungrouped mini strands,
// mini-area fills, and mini GROUPS (railing/curtain — the group holds the billed
// count, so we edit the group, not its member strands). bush/tree/column feed the
// analyzer few-shot today; railing/curtain are stored for future AI training
// (the analyzer has no detection vocabulary for them yet — #52 forward-looking).
function isEditableMini(item: SceneItem): boolean {
  const surface = item.surface;
  if (!MINI_SURFACES.includes(surface as MiniSurface)) return false;
  if (isStrand(item)) return item.bulbType === 'mini' && !item.groupId;
  if (isMiniGroup(item)) return true; // grouped railing/curtain — edit the group's count
  return isMiniArea(item);
}

export function editableItems(scene: Scene): EditableItem[] {
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  const out: EditableItem[] = [];
  for (const item of items) {
    if (isEditableMini(item)) {
      out.push({
        id: item.id,
        kind: 'mini',
        surface: item.surface as MiniSurface,
        stringCount: Math.max(1, Math.round((item as { stringCount?: number }).stringCount ?? 1)),
      });
    } else if (isSpritzer(item)) {
      out.push({ id: item.id, kind: 'spritzer', quoteSize: item.quoteSize ?? '24' });
    } else if (isWreath(item)) {
      out.push({ id: item.id, kind: 'wreath', quoteSize: item.quoteSize ?? '36noble', tier: item.tier ?? 'bow' });
    } else if (isGarland(item)) {
      out.push({ id: item.id, kind: 'garland', quoteLength: item.quoteLength ?? '9ft', tier: item.tier ?? 'fullDecor' });
    }
  }
  return out;
}

// Apply per-item corrections to a scene, changing ONLY the addressed items' valid
// fields (per kind, with the value validated against the allowed set); every
// other item — and any invalid field — is preserved verbatim.
export function applyItemCorrections(
  scene: Scene,
  corrections: Record<string, ItemCorrection>,
): Scene {
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  return {
    ...scene,
    items: items.map((item) => {
      const c = corrections[item.id];
      if (!c) return item;
      if (isEditableMini(item) && typeof c.stringCount === 'number') {
        // Clamp to a sane range — a crafted huge count would otherwise poison a
        // few-shot label. Mirrors seedFromAnalysis's REASONABLE_MAX_STRINGS guard.
        return { ...item, stringCount: Math.min(MAX_STRING_COUNT, Math.max(1, Math.round(c.stringCount))) };
      }
      if (isSpritzer(item) && SPRITZER_SIZES.includes(c.quoteSize as QuoteSpritzerSize)) {
        return { ...item, quoteSize: c.quoteSize as QuoteSpritzerSize };
      }
      if (isWreath(item)) {
        const patch: Partial<{ quoteSize: QuoteWreathSize; tier: Tier }> = {};
        if (WREATH_SIZES.includes(c.quoteSize as QuoteWreathSize)) patch.quoteSize = c.quoteSize as QuoteWreathSize;
        if (TIERS.includes(c.tier as Tier)) patch.tier = c.tier as Tier;
        return Object.keys(patch).length ? { ...item, ...patch } : item;
      }
      if (isGarland(item)) {
        const patch: Partial<{ quoteLength: QuoteGarlandLength; tier: Tier }> = {};
        if (GARLAND_LENGTHS.includes(c.quoteLength as QuoteGarlandLength)) patch.quoteLength = c.quoteLength as QuoteGarlandLength;
        if (TIERS.includes(c.tier as Tier)) patch.tier = c.tier as Tier;
        return Object.keys(patch).length ? { ...item, ...patch } : item;
      }
      return item;
    }),
  };
}
