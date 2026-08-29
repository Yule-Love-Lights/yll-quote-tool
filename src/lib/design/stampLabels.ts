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

// Is this item ever DISPLAYED by name in either consumer (the twin picker's
// stamp-row, or the billing-link "Same as" dropdown)? A twin (`linkedToId`
// set) never is — the canonical bills and is what's shown. A GROUPED member
// (`groupId` set — a strand or miniArea belonging to a MiniGroupItem, #240)
// never is either: the twin picker's isStampableCanonical excludes it
// outright (its extent belongs to the group), and the billing-link dropdown
// only ever surfaces it as a same-kind "Same as" candidate for an UNGROUPED
// item of that kind, never as a row naming the member itself. Both
// consumers' real population is "non-twin, non-grouped-member" — the two
// pools are not literally identical (isStampableCanonical is also choosier
// about strand surfaces), but neither consumer ever needs a NUMBER on a
// grouped member, which is the only thing this predicate has to get right.
function isDisplayableByName(item: SceneItem): boolean {
  const groupId = 'groupId' in item ? item.groupId : undefined;
  return !item.linkedToId && !groupId;
}

// Number duplicate base labels in DRAW ORDER — the `items` array order IS the
// persisted scene order (projectScene relies on this same invariant) — scoped
// PER SOURCE PHOTO, so photo 2's numbering never counts against photo 1's
// items. Mirrors pricingEngine's numberDuplicateLabels rule (number only when
// 2+ items share a label; a lone item stays unnumbered) but keyed by item id
// so two different UI consumers render the identical name for the same item.
// Only items isDisplayableByName() contribute to the count or receive a
// number; everything else (a twin, or a grouped member) falls through to
// stampLabel's own `?? baseStampLabel(i)` fallback — an unnumbered base
// label, never a number borrowed from a pool it was never really part of.
// A MiniGroupItem itself has no `groupId` (only its MEMBERS do), so the
// GROUP still counts and gets numbered normally — only its members are
// excluded.
export function numberStampLabels(items: SceneItem[]): Map<string, string> {
  const keyOf = (item: SceneItem) => `${item.photoId ?? ''} ${baseStampLabel(item)}`;

  const counts = new Map<string, number>();
  for (const item of items) {
    if (!isDisplayableByName(item)) continue;
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const item of items) {
    if (!isDisplayableByName(item)) continue;
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
