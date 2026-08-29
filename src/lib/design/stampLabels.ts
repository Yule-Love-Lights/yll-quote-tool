// #13 linked twins — the human name shown for a re-placeable CANONICAL item,
// both in the "Re-place from other photos" picker and the "Same as"
// billing-link dropdown (editor-core/editor.ts). Extracted to a pure module
// (no Konva/DOM) so the numbering rule below is unit-testable.

import type { SceneItem } from './sceneTypes';
import { isWreath, isBow, isGarland, isSpritzer, isMiniArea, isMiniGroup, isStrand } from './sceneTypes';

// The base (unnumbered) label for one canonical item. A MiniGroupItem (a
// grouped railing/curtain/etc, #240) reads by its `surface` tag exactly like
// a scattershot area does — same word staff already see on the group's own
// "Surface" dropdown, so "column minis" means the same thing whether it's
// one wrapped column or a 3-strand column group.
export function baseStampLabel(i: SceneItem): string {
  if (isWreath(i)) return `${i.sizeIn}" wreath`;
  if (isBow(i)) return `${i.sizeIn}" bow`;
  if (isGarland(i)) return 'garland run';
  if (isSpritzer(i)) return `${i.sizeIn}" spritzer`;
  if (isMiniGroup(i)) return `${i.surface ?? 'bush'} minis`;
  if (isMiniArea(i)) return `${i.surface ?? 'bush'} minis`;
  if (isStrand(i) && i.bulbType === 'permanent') return `${i.sideOfHouse ?? 'front'} roofline`;
  if (isStrand(i)) return `${i.surface ?? 'mini'} wrap`;
  return 'item';
}

// Number duplicate base labels in DRAW ORDER — the `items` array order IS the
// persisted scene order (projectScene relies on this same invariant) — scoped
// PER SOURCE PHOTO, so photo 2's numbering never counts against photo 1's
// items. Mirrors pricingEngine's numberDuplicateLabels rule (number only when
// 2+ items share a label; a lone item stays unnumbered) but keyed by item id
// so two different UI consumers render the identical name for the same item.
// Twins (`linkedToId` set) never appear in either consumer, so they're
// dropped from the count and never receive an entry.
export function numberStampLabels(items: SceneItem[]): Map<string, string> {
  const keyOf = (item: SceneItem) => `${item.photoId ?? ''} ${baseStampLabel(item)}`;

  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.linkedToId) continue;
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const item of items) {
    if (item.linkedToId) continue;
    const key = keyOf(item);
    const base = baseStampLabel(item);
    const total = counts.get(key) ?? 1;
    if (total <= 1) {
      labels.set(item.id, base);
      continue;
    }
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    labels.set(item.id, `${base} ${n}`);
  }
  return labels;
}
