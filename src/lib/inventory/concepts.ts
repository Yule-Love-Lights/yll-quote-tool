// src/lib/inventory/concepts.ts
// The design-concept VOCABULARY the binding editor (#82 Slice 1b-ii) renders and
// the materials engine (Slice 2) will read. Pure data + key builders — no React,
// no Supabase. Each "concept" is one billable design attribute that maps to a
// real Thunder SKU (or a small bundle of SKUs). The binding map (app_settings
// `bindings`) is keyed by these strings; keeping the builders here the single
// source of truth means the UI and the engine never disagree on key format.

import type {
  BulbType,
  Tier,
  WrapStyle,
  QuoteWreathSize,
  QuoteGarlandLength,
  QuoteSpritzerSize,
} from '@/lib/design/sceneTypes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';

export type ConceptRow = { key: string; label: string };
export type BundleField = { id: string; label: string };
export type ConceptBundleRow = { key: string; label: string; fields: BundleField[] };

// ── bulb colors: paletteId × bulbType → one SKU ──────────────────────────────
export const BULB_TYPES: { id: BulbType; label: string }[] = [
  { id: 'c9', label: 'C9' },
  { id: 'mini', label: 'Mini' },
  { id: 'permanent', label: 'Permanent' },
  { id: 'bistro', label: 'Bistro' },
];
export const bulbKey = (paletteId: string, bulbType: BulbType) => `bulb:${paletteId}:${bulbType}`;
// Returns one group per bulb type so the UI can render a labelled section each.
export function bulbGroups(): { type: { id: BulbType; label: string }; rows: ConceptRow[] }[] {
  return BULB_TYPES.map((type) => ({
    type,
    rows: DEFAULT_COLORS.map((c) => ({ key: bulbKey(c.id, type.id), label: c.label })),
  }));
}
export const bulbRows = (): ConceptRow[] => bulbGroups().flatMap((g) => g.rows);

// ── tiers (shared by wreath + garland) ───────────────────────────────────────
export const TIERS: { id: Tier; label: string }[] = [
  { id: 'bow', label: 'Non-decorated' },
  { id: 'fullDecor', label: 'Decorated' },
];

// ── wreaths: size × tier → one SKU ───────────────────────────────────────────
export const WREATH_SIZES: QuoteWreathSize[] = [
  '24noble', '30noble', '36noble', '48noble', '60noble', '72noble',
];
export const wreathKey = (size: QuoteWreathSize, tier: Tier) => `wreath:${size}:${tier}`;
const sizeLabel = (s: string) => s.replace('noble', '″ Noble');
export function wreathRows(): ConceptRow[] {
  return WREATH_SIZES.flatMap((size) =>
    TIERS.map((t) => ({ key: wreathKey(size, t.id), label: `${sizeLabel(size)} — ${t.label}` })),
  );
}

// ── garland: length × tier → one SKU ─────────────────────────────────────────
export const GARLAND_LENGTHS: QuoteGarlandLength[] = ['4.5ft', '9ft'];
export const garlandKey = (length: QuoteGarlandLength, tier: Tier) => `garland:${length}:${tier}`;
export function garlandRows(): ConceptRow[] {
  return GARLAND_LENGTHS.flatMap((len) =>
    TIERS.map((t) => ({ key: garlandKey(len, t.id), label: `${len} section — ${t.label}` })),
  );
}

// ── spritzer: size → { spritzerSku, stakeMetalSku } bundle ───────────────────
export const SPRITZER_SIZES: QuoteSpritzerSize[] = ['16', '24', '32'];
export const spritzerKey = (size: QuoteSpritzerSize) => `spritzer:${size}`;
export const SPRITZER_BUNDLE_FIELDS: BundleField[] = [
  { id: 'spritzerSku', label: 'Spritzer' },
  { id: 'stakeMetalSku', label: 'Stake (metal pole)' },
];
export function spritzerRows(): ConceptBundleRow[] {
  return SPRITZER_SIZES.map((size) => ({
    key: spritzerKey(size),
    label: `${size}″ spritzer`,
    fields: SPRITZER_BUNDLE_FIELDS,
  }));
}

// ── mini surfaces: surface × wrapStyle → one SKU ─────────────────────────────
export const MINI_SURFACES: { id: string; label: string }[] = [
  { id: 'tree', label: 'Tree' },
  { id: 'bush', label: 'Bush' },
  { id: 'column', label: 'Column' },
  { id: 'railing', label: 'Railing' },
];
export const WRAP_STYLES: { id: WrapStyle; label: string }[] = [
  { id: 'canopy', label: 'Canopy' },
  { id: 'trunk', label: 'Trunk' },
];
export const miniKey = (surface: string, wrap: WrapStyle) => `mini:${surface}:${wrap}`;
export function miniRows(): ConceptRow[] {
  return MINI_SURFACES.flatMap((s) =>
    WRAP_STYLES.map((w) => ({ key: miniKey(s.id, w.id), label: `${s.label} — ${w.label}` })),
  );
}

// ── clip rules: roof feature → { sku, perFt } (app_settings `clipRules`) ─────
// Hints encode the spec §4 terminology traps so staff bind the right SKU.
export const CLIP_FEATURES: { id: string; label: string; hint: string }[] = [
  { id: 'gutter', label: 'Gutterline', hint: 'C9 Flex Clip — Naldo’s "tuff clip" (14147 W / 14347 B). NOT the "C9 Tuff Tab" 14148.' },
  { id: 'peak', label: 'Peak (front gable, no gutter)', hint: 'Shingle Tab (14145 W / 14345 B).' },
  { id: 'side', label: 'Side (shingles)', hint: 'Shingle Tab (14145 / 14345).' },
  { id: 'ridge', label: 'Ridge (horizontal apex)', hint: 'C9 Peak / Ridge Clip (14159 W / 14859 Brown).' },
  { id: 'pathway', label: 'Pathway / stake-lighting', hint: 'Pathway Ground Stake (14343 B / 14443 Grn). NOT the spritzer’s Stake Metal.' },
  { id: 'flat', label: 'Flat / commercial', hint: 'Parapet Clip + Shingle Tab (both).' },
  { id: 'metal', label: 'Metal roof', hint: 'Magnetic socket wire — no clip; flag for staff review.' },
];
