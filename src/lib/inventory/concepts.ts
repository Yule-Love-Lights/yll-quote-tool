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
export const bulbC9Key = (paletteId: string) => `bulb:${paletteId}:c9`;
export const BISTRO_KEY = 'bulb:warm-white:bistro';
export function bulbC9Rows(): ConceptRow[] {
  return DEFAULT_COLORS.map((c) => ({ key: bulbC9Key(c.id), label: c.label }));
}

// ── mini lights: keyed by catalog color; rows derived from the catalog ───────
export const MINI_CATEGORY = 'Mini Lights';
export const miniKey = (color: string) => `mini:${color.trim()}`;

// ── clips: roof feature → { sku, perFt }. Pre-filled with the known SKUs. ────
export const CLIP_FEATURES: { id: string; label: string; hint: string }[] = [
  { id: 'gutter', label: 'Gutterline', hint: 'C9 Flex Clip — your "tuff clip" (14147 W / 14347 B). NOT the "C9 Tuff Tab" 14148.' },
  { id: 'peak', label: 'Peak (front gable, no gutter)', hint: 'Shingle Tab (14145 W / 14345 B).' },
  { id: 'side', label: 'Side (shingles)', hint: 'Shingle Tab (14145 / 14345).' },
  { id: 'ridge', label: 'Ridge (horizontal apex)', hint: 'C9 Peak / Ridge Clip (14159 W / 14859 Brown).' },
  { id: 'pathway', label: 'Pathway / stake-lighting', hint: 'Pathway Ground Stake (14343 B / 14443 Grn).' },
  { id: 'flat', label: 'Flat / commercial', hint: 'Parapet Clip (14144) + Shingle Tab — both. Bind parapet here; the shingle-tab pairing is a Slice-2 detail.' },
  { id: 'metal', label: 'Metal roof', hint: 'Magnetic socket wire — no clip; flag for staff review.' },
];
// Seeded into clipRules when nothing is saved yet (operator reviews + Saves).
export const DEFAULT_CLIP_SKUS: Record<string, string> = {
  gutter: '14147', peak: '14145', side: '14145', ridge: '14159', pathway: '14343', flat: '14144',
};

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

// ── spritzers: palette color × size → SKU, + one pole per size ───────────────
export const SPRITZER_SIZES: QuoteSpritzerSize[] = ['16', '24', '32'];
export const spritzerKey = (paletteId: string, size: string) => `spritzer:${paletteId}:${size}`;
export const spritzerPoleKey = (size: string) => `spritzer-pole:${size}`;
export function spritzerColorRows(size: string): ConceptRow[] {
  return DEFAULT_COLORS.map((c) => ({ key: spritzerKey(c.id, size), label: c.label }));
}
