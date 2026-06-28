// src/lib/inventory/concepts.ts
// The design-concept VOCABULARY the binding editor (#82 Slice 1b-ii) renders and
// the materials engine (Slice 2) will read. Pure data + key builders — no React,
// no Supabase. Each concept maps to a real Thunder/YLL SKU.
//
// Mini-light rows are the exception: they're derived from the LIVE catalog at
// render time (the catalog carries far more mini colors than the 12-color design
// palette), so this module only provides the key builder + category name for them.

import type {
  QuoteWreathSize,
  QuoteGarlandLength,
  QuoteSpritzerSize,
} from '@/lib/design/sceneTypes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';

export type ConceptRow = { key: string; label: string; hint?: string };

// ── bulb colors: C9 (every palette color) + Bistro (warm white only) ─────────
// Mini + Permanent removed: mini lights have their own section; permanent lighting
// is a future feature (see the ledger #82 follow-up).
//
// Physical-product palette = the design palette minus Black. There is no black
// bulb or spritzer product (#82, Naldo), so Black isn't offered as something to
// bind. It stays in DEFAULT_COLORS (the shared editor-core palette uses it for
// unlit/off strands) — we just filter it out of the orderable product rows.
export const PRODUCT_COLORS = DEFAULT_COLORS.filter((c) => c.id !== 'black');
export const bulbC9Key = (paletteId: string) => `bulb:${paletteId}:c9`;
export const BISTRO_KEY = 'bulb:warm-white:bistro';
export function bulbC9Rows(): ConceptRow[] {
  return PRODUCT_COLORS.map((c) => ({ key: bulbC9Key(c.id), label: c.label }));
}

// ── mini lights: the exact strands YLL carries (#82, Naldo) ──────────────────
// A curated list (NOT the messy catalog `color` strings), shown by friendly
// name. The 11 whose name matches a design-palette color (Warm White … Teal)
// keep a `mini:<label>` key, so a design placing that solid mini still
// auto-orders it via materialsProjection (which reads mini:colorLabel(paletteId)).
// The rest — Multi + the specialty / two-color strands — are stocked and
// pre-seeded for binding/manual ordering, but the design can't place them yet,
// so they don't auto-project. SKU↔name from Naldo's supplier list.
export const MINI_CATEGORY = 'Mini Lights';
export const miniKey = (color: string) => `mini:${color.trim()}`;

export type MiniLight = { sku: string; name: string };
export const MINI_LIGHTS: MiniLight[] = [
  // Solid colors that match the design palette → auto-project from a design.
  { sku: '40056', name: 'Warm White' },
  { sku: '40156', name: 'Pure White' },
  { sku: '40956', name: 'Cool White' },
  { sku: '40356', name: 'Red' },
  { sku: '40456', name: 'Green' },
  { sku: '40556', name: 'Blue' },
  { sku: '40656', name: 'Orange' },
  { sku: '40856', name: 'Yellow' },
  { sku: '43116', name: 'Pink' },
  { sku: '40756', name: 'Purple' },
  { sku: '43126', name: 'Teal' },
  // Multi + specialty / two-color strands → stocked, manual ordering.
  { sku: '40256', name: 'Multi' },
  { sku: '43136', name: 'Candy Cane' },
  { sku: '43036', name: 'Old Fashioned Candy Cane' },
  { sku: '43156', name: 'Frozen' },
  { sku: '43346', name: 'Grinch' },
  { sku: '43756', name: 'Goblin' },
  { sku: '43356', name: 'Patriot' },
  { sku: '43456', name: 'Wintergreen' },
  { sku: '43556', name: 'Ocean' },
  { sku: '43226', name: 'Rockefeller Multi' },
  { sku: '43096', name: 'Champagne' },
  { sku: '43416', name: 'Green / Pure White' },
  { sku: '43476', name: 'Green / Purple' },
  { sku: '43656', name: 'Orange / Purple' },
  { sku: '43436', name: 'Red / Green' },
  { sku: '43166', name: 'Pure White (Brown Wire)' },
  { sku: '43006', name: 'Warm White (Twinkle Wire)' },
];
export function miniRows(): ConceptRow[] {
  return MINI_LIGHTS.map((m) => ({ key: miniKey(m.name), label: m.name }));
}

// ── clips: roof feature → { sku, perFt }. Pre-filled with the known SKUs. ────
export const CLIP_FEATURES: { id: string; label: string; hint: string }[] = [
  { id: 'gutter', label: 'Gutterline', hint: 'C9 Flex Clip — your "tuff clip" (14147 W / 14347 B). NOT the "C9 Tuff Tab" 14148.' },
  { id: 'peak', label: 'Peak (front gable, no gutter)', hint: 'Shingle Tab (14145 W / 14345 B).' },
  { id: 'side', label: 'Side (shingles)', hint: 'Shingle Tab (14145 / 14345).' },
  { id: 'ridge', label: 'Ridge (horizontal apex)', hint: 'C9 Peak / Ridge Clip (14159 W / 14859 Brown).' },
  { id: 'pathway', label: 'Pathway / stake-lighting', hint: 'Pathway Ground Stake (14343 B / 14443 Grn).' },
  { id: 'flat', label: 'Flat / commercial', hint: 'Parapet Clip (14144) + Shingle Tab — both. Bind parapet here; the shingle-tab pairing is a Slice-2 detail.' },
  // NOTE: metal roofs take MAGNETIC SOCKET WIRE (bound in the "Socket wire"
  // section above), NOT a clip — projectClips('metal') returns null. So there's
  // deliberately no "Metal roof" clip row; it would just duplicate magnetic wire.
];
// Seeded into clipRules when nothing is saved yet (operator reviews + Saves).
export const DEFAULT_CLIP_SKUS: Record<string, string> = {
  gutter: '14147', peak: '14145', side: '14145', ridge: '14159', pathway: '14343', flat: '14144',
};
// Concept key for a projected clip line (Slice 2b materials engine) — grouped by
// roof feature so unbound features surface in the materials view's unbound list.
export const clipKey = (feature: string) => `clip:${feature}`;

// ── socket wire: ordered per foot of roofline ────────────────────────────────
// Standard C9 socket wire, plus magnetic socket wire for metal roofs (which take
// no clips — see the §4 clip table). Not autofilled — operator binds the SKUs.
export const WIRE_C9_KEY = 'wire:c9';
export const WIRE_MAGNETIC_KEY = 'wire:magnetic';

// ── wreaths: base + bow + decoration fee, all per size ───────────────────────
export const WREATH_SIZES: QuoteWreathSize[] = [
  '24noble', '30noble', '36noble', '48noble', '60noble', '72noble',
];
const wreathSizeLabel = (s: string) => s.replace('noble', '" Noble');
export const wreathBaseKey = (size: string) => `wreath:${size}`;
export const wreathBowKey = (size: string) => `wreath-bow:${size}`;
export const wreathFeeKey = (size: string) => `wreath-fee:${size}`;
// Bow size per wreath (Naldo's bow chart). 30" is absent from the chart → operator picks.
const WREATH_BOW_HINT: Record<string, string> = {
  '24noble': '12" bow', '30noble': 'chart skips 30" — pick', '36noble': '18" bow',
  '48noble': '24" bow', '60noble': '30" bow', '72noble': '36" bow',
};
// Decoration-fee SKU per wreath size (catalog items 1101–1105 / 1108). Pre-filled.
export const DEFAULT_WREATH_FEE_SKUS: Record<string, string> = {
  '24noble': '1101', '30noble': '1108', '36noble': '1102', '48noble': '1103', '60noble': '1104', '72noble': '1105',
};
export function wreathBaseRows(): ConceptRow[] {
  return WREATH_SIZES.map((s) => ({ key: wreathBaseKey(s), label: wreathSizeLabel(s) }));
}
export function wreathBowRows(): ConceptRow[] {
  return WREATH_SIZES.map((s) => ({ key: wreathBowKey(s), label: wreathSizeLabel(s), hint: WREATH_BOW_HINT[s] }));
}
export function wreathFeeRows(): ConceptRow[] {
  return WREATH_SIZES.map((s) => ({ key: wreathFeeKey(s), label: wreathSizeLabel(s) }));
}

// ── garland: base (per length) + one bow + one decoration fee ────────────────
export const GARLAND_LENGTHS: QuoteGarlandLength[] = ['4.5ft', '9ft'];
export const garlandBaseKey = (length: string) => `garland:${length}`;
export const GARLAND_BOW_KEY = 'garland-bow';
export const GARLAND_FEE_KEY = 'garland-fee';
export const DEFAULT_GARLAND_FEE_SKU = '1106'; // Garland Decoration Fee
export function garlandBaseRows(): ConceptRow[] {
  return GARLAND_LENGTHS.map((l) => ({ key: garlandBaseKey(l), label: `${l} section` }));
}

// ── spritzers: the exact spritzers YLL carries (#82, Naldo) ──────────────────
// Curated by SKU + friendly color name + size (NOT the messy catalog `color`).
// Like minis: the solids whose color is a design-palette color keep a
// projection-resolvable spritzer:<paletteId>:<size> key (so a design placing
// that solid spritzer still auto-orders it); the specialty / multi-color combos
// are keyed by SKU (spritzer:<sku>) — stocked + pre-seeded for binding/manual
// ordering, but the design can't place them. One pole per size, shared across
// colors. No black (no black spritzer product). SKU↔color↔size from Naldo's list.
export const SPRITZER_SIZES: QuoteSpritzerSize[] = ['16', '24', '32'];
export const spritzerKey = (paletteId: string, size: string) => `spritzer:${paletteId}:${size}`;
export const spritzerPoleKey = (size: string) => `spritzer-pole:${size}`;

export type Spritzer = { sku: string; name: string; size: QuoteSpritzerSize; paletteId?: string };
export const SPRITZERS: Spritzer[] = [
  // Solids that match the design palette → auto-project from a design.
  { sku: '61001', name: 'Warm White', size: '16', paletteId: 'warm-white' },
  { sku: '61002', name: 'Warm White', size: '24', paletteId: 'warm-white' },
  { sku: '61003', name: 'Warm White', size: '32', paletteId: 'warm-white' },
  { sku: '61101', name: 'Pure White', size: '16', paletteId: 'cool-white' },
  { sku: '61102', name: 'Pure White', size: '24', paletteId: 'cool-white' },
  { sku: '61103', name: 'Pure White', size: '32', paletteId: 'cool-white' },
  { sku: '61301', name: 'Red', size: '16', paletteId: 'red' },
  { sku: '61302', name: 'Red', size: '24', paletteId: 'red' },
  { sku: '61401', name: 'Green', size: '16', paletteId: 'green' },
  { sku: '61402', name: 'Green', size: '24', paletteId: 'green' },
  { sku: '61501', name: 'Blue', size: '16', paletteId: 'blue' },
  { sku: '61502', name: 'Blue', size: '24', paletteId: 'blue' },
  { sku: '61111', name: 'Pink', size: '16', paletteId: 'pink' },
  { sku: '61112', name: 'Pink', size: '24', paletteId: 'pink' },
  // Specialty / multi-color combos → stocked, manual ordering (sku-keyed).
  { sku: '61011', name: 'Warm White / Pure White', size: '16' },
  { sku: '61012', name: 'Warm White / Pure White', size: '24' },
  { sku: '61031', name: 'Warm White / Red', size: '16' },
  { sku: '61032', name: 'Warm White / Red', size: '24' },
  { sku: '61131', name: 'Red / Pure White', size: '16' },
  { sku: '61132', name: 'Red / Pure White', size: '24' },
  { sku: '61151', name: 'Pure White & Blue', size: '16' },
  { sku: '61152', name: 'Pure White & Blue', size: '24' },
  { sku: '61201', name: 'Multi', size: '16' },
  { sku: '61202', name: 'Multi', size: '24' },
  { sku: '61312', name: 'Red / Pink', size: '24' },
  { sku: '61341', name: 'Red / Green', size: '16' },
  { sku: '61342', name: 'Red / Green', size: '24' },
  { sku: '61351', name: 'Red / Pure White / Blue', size: '16' },
  { sku: '61352', name: 'Red / Pure White / Blue', size: '24' },
  { sku: '61671', name: 'Orange / Purple', size: '16' },
  { sku: '61672', name: 'Orange / Purple', size: '24' },
];
// Binding key: solids use the projection-matching key; specialty are sku-keyed.
function spritzerEntryKey(s: Spritzer): string {
  return s.paletteId ? spritzerKey(s.paletteId, s.size) : `spritzer:${s.sku}`;
}
export function spritzerRows(size: string): ConceptRow[] {
  return SPRITZERS.filter((s) => s.size === size).map((s) => ({ key: spritzerEntryKey(s), label: s.name }));
}

// ── autofill defaults (Naldo) ────────────────────────────────────────────────
// Seeded into the editable state when nothing is saved yet; the operator reviews
// and Saves. All Warm-White Noble greenery (the "-30" finish — the one present at
// every size), Red-w/-Gold-Trim bows per the bow chart, the standard 5mm mini
// strands, and the solid spritzer colors that exist in the catalog.
export const DEFAULT_WREATH_SKUS: Record<string, string> = {
  '24noble': '50024-30', '30noble': '50030-30', '36noble': '50036-30',
  '48noble': '50048-30', '60noble': '50060-30', '72noble': '50072-30',
};
// Bow chart: 24→12″, 36→18″, 48→24″, 60→30″, 72→36″. 30″ is absent from the chart → left blank.
export const DEFAULT_WREATH_BOW_SKUS: Record<string, string> = {
  '24noble': '30812', '36noble': '30818', '48noble': '30824', '60noble': '30830', '72noble': '30836',
};
export const DEFAULT_GARLAND_SKUS: Record<string, string> = { '4.5ft': '50045-30', '9ft': '50099-30' };
export const DEFAULT_GARLAND_BOW_SKU = '30812'; // 12" Red/Gold bow
// Mini strands + spritzers are seeded from their curated lists (MINI_LIGHTS /
// SPRITZERS above) — each keyed for binding, pre-filled with its known SKU.

// Build the full seeded binding map (all string values). The page merges saved
// bindings over this (saved wins; seeds fill the gaps).
export function buildSeedBindings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [s, sku] of Object.entries(DEFAULT_WREATH_SKUS)) out[wreathBaseKey(s)] = sku;
  for (const [s, sku] of Object.entries(DEFAULT_WREATH_BOW_SKUS)) out[wreathBowKey(s)] = sku;
  for (const [s, sku] of Object.entries(DEFAULT_WREATH_FEE_SKUS)) out[wreathFeeKey(s)] = sku;
  for (const [l, sku] of Object.entries(DEFAULT_GARLAND_SKUS)) out[garlandBaseKey(l)] = sku;
  out[GARLAND_BOW_KEY] = DEFAULT_GARLAND_BOW_SKU;
  out[GARLAND_FEE_KEY] = DEFAULT_GARLAND_FEE_SKU;
  for (const m of MINI_LIGHTS) out[miniKey(m.name)] = m.sku;
  for (const s of SPRITZERS) out[spritzerEntryKey(s)] = s.sku;
  return out;
}

// Build the seeded clip-rule map (feature → { sku }). Saved rules win.
export function buildSeedClipRules(): Record<string, { sku: string }> {
  const out: Record<string, { sku: string }> = {};
  for (const [f, sku] of Object.entries(DEFAULT_CLIP_SKUS)) out[f] = { sku };
  return out;
}
