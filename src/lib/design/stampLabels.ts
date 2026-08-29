// #13 linked twins — the human name shown for a re-placeable CANONICAL item,
// both in the "Re-place from other photos" picker and the "Same as"
// billing-link dropdown (editor-core/editor.ts). Extracted to a pure module
// (no Konva/DOM) so the numbering rule below is unit-testable.

import type { Scene, SceneItem } from './sceneTypes';
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

// The (photo, base-label) bucket key — shared by assignStampOrdinals (which
// WRITES a counter per bucket) and numberStampLabels (which reads it, via
// each item's own persisted stampOrdinal). Keeping one keying function is
// what guarantees the two agree on what counts as "the same bucket".
function bucketKey(item: SceneItem): string {
  return `${item.photoId ?? ''} ${baseStampLabel(item)}`;
}

// Fix round item 2a (Jason's ruling): assign a STABLE, NEVER-REASSIGNED
// ordinal to every displayable item that doesn't have one yet, so a
// staffer's note ("re-place column minis 3") can never end up pointing at a
// different physical item just because some OTHER item in the same bucket
// was deleted. Gaps are the accepted tradeoff — see `stampOrdinalCounters`
// on Scene for why a deleted item's number is never handed to a new one
// either (an item-COUNT-based "next number" would forget the deleted item
// ever existed).
//
// Pure and idempotent: returns the SAME `scene` reference when nothing
// needed assigning (every displayable item already carries a stampOrdinal
// AND the counters already lead every existing ordinal), so a caller can
// cheaply no-op on every render after the first. Back-compat: a scene saved
// before this field existed has no counters and no item ordinals — the
// first call seeds every current item 1..N in draw order per bucket (the
// same order they'd have displayed in under the OLD live-recomputed
// scheme), and every assignment after that point is permanent.
export function assignStampOrdinals(scene: Scene): Scene {
  const counters: Record<string, number> = { ...(scene.stampOrdinalCounters ?? {}) };
  let itemsChanged = false;
  let countersChanged = false;

  const items = scene.items.map((item) => {
    if (!isDisplayableByName(item)) return item;
    const key = bucketKey(item);
    if (typeof item.stampOrdinal === 'number' && Number.isFinite(item.stampOrdinal)) {
      // Defensive: never let the counter fall BEHIND an ordinal already in
      // use (e.g. data seeded some other way), so it can't hand out a
      // colliding number later.
      if ((counters[key] ?? 1) <= item.stampOrdinal) {
        counters[key] = item.stampOrdinal + 1;
        countersChanged = true;
      }
      return item;
    }
    const n = counters[key] ?? 1;
    counters[key] = n + 1;
    countersChanged = true;
    itemsChanged = true;
    return { ...item, stampOrdinal: n };
  });

  if (!itemsChanged && !countersChanged) return scene;
  return {
    ...scene,
    items: itemsChanged ? items : scene.items,
    stampOrdinalCounters: counters,
  };
}

// Render the label for every displayable item — a lone item in its bucket
// stays unnumbered (mirrors pricingEngine's numberDuplicateLabels rule); a
// bucket with 2+ items appends each item's OWN persisted `stampOrdinal`, so
// deleting one sibling never renumbers the others. Callers MUST run
// assignStampOrdinals over the scene first (editor.ts's stampLabel() does,
// on every call) — an item that somehow reaches this without one falls back
// to the unnumbered base label rather than crashing or fabricating a number
// that could collide with a real one.
export function numberStampLabels(items: SceneItem[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!isDisplayableByName(item)) continue;
    counts.set(bucketKey(item), (counts.get(bucketKey(item)) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const item of items) {
    if (!isDisplayableByName(item)) continue;
    const base = baseStampLabel(item);
    const total = counts.get(bucketKey(item)) ?? 1;
    if (total <= 1) {
      labels.set(item.id, base);
      continue;
    }
    labels.set(item.id, typeof item.stampOrdinal === 'number' ? `${base} ${item.stampOrdinal}` : base);
  }
  return labels;
}
