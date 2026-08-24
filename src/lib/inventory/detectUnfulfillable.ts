// src/lib/inventory/detectUnfulfillable.ts
// #92 — operator-side fulfillability check. Flags the mini/spritzer items a design
// can't supply AS DRAWN so staff fix them before sending a quote. Two cases:
//   (a) a single item in a color we don't OFFER for that item type (e.g. an orange
//       spritzer — orange spritzers don't exist), or
//   (b) a single item drawn in a MULTI-color mix that isn't one of our stocked
//       strands (a single bush/spritzer can only be one solid color or a real
//       pattern strand — it can't be an arbitrary multi-color mix).
//
// Pure: the caller passes the offered-colors (offeredFromBindings, from the live
// bindings). Only minis & spritzers can fail — C9 roofline comes in every color and
// wreaths/garland aren't palette-colored, so they're never targets here.

import type { SceneItem, QuoteSpritzerSize } from '@/lib/design/sceneTypes';
import { isStrand, isSpritzer, isMiniArea, isMiniGroup } from '@/lib/design/sceneTypes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';
import { matchPattern } from './patternSkus';
import type { OfferedColors } from './resolveInstalls';

export type UnfulfillableItem = { sceneItemId: string; message: string };

const MINI_SURFACES = new Set(['bush', 'tree', 'column', 'railing']);
const DEFAULT_SPRITZER_SIZE: QuoteSpritzerSize = '24';
const colorLabel = (id: string) => DEFAULT_COLORS.find((c) => c.id === id)?.label ?? id;
const offeredList = (has: (id: string) => boolean) =>
  DEFAULT_COLORS.filter((c) => c.id !== 'black' && has(c.id))
    .map((c) => c.label)
    .join(', ');

type Target = { id: string; type: 'mini' | 'spritzer'; noun: string; nounPlural: string; colors: string[]; size: QuoteSpritzerSize };

// The colorable mini/spritzer items, in scene order (mirrors resolveInstalls).
function targets(items: SceneItem[]): Target[] {
  const out: Target[] = [];
  for (const item of items ?? []) {
    if (item.included === false) continue;
    // #13 linked twins mirror their canonical's colors — flag only the canonical.
    if (item.linkedToId) continue;
    if (isSpritzer(item)) {
      out.push({ id: item.id, type: 'spritzer', noun: 'spritzer', nounPlural: 'spritzers', colors: item.colorPattern ?? [], size: item.quoteSize ?? DEFAULT_SPRITZER_SIZE });
    } else if (isStrand(item)) {
      if (item.groupId) continue;
      const s = item.surface ?? '';
      if (!MINI_SURFACES.has(s)) continue;
      out.push({ id: item.id, type: 'mini', noun: s, nounPlural: 'mini lights', colors: item.colorPattern ?? [], size: DEFAULT_SPRITZER_SIZE });
    } else if (isMiniArea(item)) {
      if (item.groupId) continue; // #240 fix: projected via its MiniGroupItem, mirrors the isStrand skip above
      const s = item.surface ?? '';
      if (!MINI_SURFACES.has(s)) continue;
      out.push({ id: item.id, type: 'mini', noun: s, nounPlural: 'mini lights', colors: item.colorPattern ?? [], size: DEFAULT_SPRITZER_SIZE });
    } else if (isMiniGroup(item)) {
      out.push({ id: item.id, type: 'mini', noun: item.surface ?? 'railing', nounPlural: 'mini lights', colors: item.colorPattern ?? [], size: DEFAULT_SPRITZER_SIZE });
    }
  }
  return out;
}

export function detectUnfulfillable(items: SceneItem[], offered: OfferedColors): UnfulfillableItem[] {
  const out: UnfulfillableItem[] = [];
  for (const t of targets(items)) {
    const has = (id: string) => (t.type === 'mini' ? offered.miniHas(id) : offered.spritzerHas(id, t.size));
    const colors = [...new Set(t.colors)];
    const eff = colors.length ? colors : ['warm-white']; // empty pattern = warm-white default

    if (eff.length === 1) {
      // (a) single color we don't offer for this type.
      if (!has(eff[0])) {
        const avail = offeredList(has);
        out.push({
          sceneItemId: t.id,
          message: `We don't offer ${colorLabel(eff[0])} ${t.nounPlural}${avail ? ` — offered: ${avail}` : ''}. Recolor or remove this ${t.noun}.`,
        });
      }
      continue;
    }

    // (b) multi-color: OK only if a stocked strand exists for this product (+ size).
    const pattern = matchPattern(eff);
    const hasStrand = !!pattern && (t.type === 'mini' || !!pattern.spritzerSku?.[t.size]);
    if (!hasStrand) {
      out.push({
        sceneItemId: t.id,
        message: `This ${t.noun} is drawn in colors we don't sell as one strand. Pick a single color, or use one of our patterns.`,
      });
    }
  }
  return out;
}
