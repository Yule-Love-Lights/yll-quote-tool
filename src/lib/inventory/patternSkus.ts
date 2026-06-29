// src/lib/inventory/patternSkus.ts
// #92 — pattern → real supplier STRAND SKUs. The inventory-side definition of a
// "light pattern": a color SET signature (order-ignored) + the manufactured mini
// strand SKU and, where one exists, the spritzer strand SKU per billed size.
//
// Patterns are matched BEHIND THE SCENES from the colors the customer ends up with
// (Build-your-own, a named portal swatch, or the operator's as-designed colors) —
// they are NOT new portal swatches. Five ids match a visible COLOR_SCHEME
// (multicolor/champagne/candy-cane/christmas/blue-white); the other eight are
// inventory-only. The `blue-white` swatch is shown to customers as "Frozen".
//
// SKUs are the curated #82 catalog (MINI_LIGHTS / SPRITZERS in concepts.ts). A unit
// test (patternSkus.test.ts) asserts every SKU below exists there at the right size
// and every colorSet is unique. Spritzer pattern strands ship in 16"/24" ONLY —
// never 32" — so an absent size means "build from solids" for that size.

import type { QuoteSpritzerSize } from '@/lib/design/sceneTypes';

export type PatternSku = {
  id: string;
  /** Pattern signature: palette color ids, order-ignored (deduped on match). */
  colorSet: string[];
  /** Every pattern has a manufactured mini strand. */
  miniSku: string;
  /** The manufactured spritzer strand per billed size, if one exists. */
  spritzerSku?: Partial<Record<QuoteSpritzerSize, string>>;
};

export const PATTERN_SKUS: PatternSku[] = [
  // ── visible swatches (id matches a COLOR_SCHEME) ──
  { id: 'multicolor', colorSet: ['red', 'green', 'blue', 'yellow', 'pink'], miniSku: '40256', spritzerSku: { '16': '61201', '24': '61202' } },
  { id: 'champagne', colorSet: ['warm-white', 'cool-white'], miniSku: '43096', spritzerSku: { '16': '61011', '24': '61012' } },
  { id: 'candy-cane', colorSet: ['cool-white', 'red'], miniSku: '43136', spritzerSku: { '16': '61131', '24': '61132' } },
  { id: 'christmas', colorSet: ['green', 'red'], miniSku: '43436', spritzerSku: { '16': '61341', '24': '61342' } },
  { id: 'blue-white', colorSet: ['blue', 'cool-white'], miniSku: '43156', spritzerSku: { '16': '61151', '24': '61152' } }, // customer-facing name: "Frozen"
  // ── inventory-only patterns (no portal swatch) ──
  { id: 'ocean', colorSet: ['teal', 'blue', 'cool-white'], miniSku: '43556' },
  { id: 'wintergreen', colorSet: ['blue', 'green', 'cool-white'], miniSku: '43456' },
  { id: 'patriot', colorSet: ['red', 'cool-white', 'blue'], miniSku: '43356', spritzerSku: { '16': '61351', '24': '61352' } },
  { id: 'grinch', colorSet: ['red', 'green', 'cool-white'], miniSku: '43346' },
  { id: 'rockefeller', colorSet: ['red', 'blue', 'green', 'orange', 'yellow'], miniSku: '43226' },
  { id: 'old-fashioned-candy-cane', colorSet: ['warm-white', 'red'], miniSku: '43036', spritzerSku: { '16': '61031', '24': '61032' } },
  { id: 'goblin', colorSet: ['purple', 'green'], miniSku: '43756' },
  { id: 'halloween', colorSet: ['purple', 'orange'], miniSku: '43656', spritzerSku: { '16': '61671', '24': '61672' } },
];

// Sorted-unique signature key for a color list (the pattern identity).
export function colorSetKey(ids: string[]): string {
  return [...new Set(ids)].sort().join('|');
}

const PATTERN_BY_SET = new Map(PATTERN_SKUS.map((p) => [colorSetKey(p.colorSet), p]));

// Match a color list to a known pattern by its SET (order-ignored). A single color
// (or none) is never a pattern → null.
export function matchPattern(colorIds: string[]): PatternSku | null {
  if (new Set(colorIds).size < 2) return null;
  return PATTERN_BY_SET.get(colorSetKey(colorIds)) ?? null;
}
