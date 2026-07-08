// Link portal line items ⇄ design scene items (#27 sub-step D).
//
// Given a quote's portal line items (built from the saved pricing result) and the
// linked design's scene, attach `sceneItemIds` to each line item so the portal
// can hide a drawn item when its line item is toggled off, and re-show it when
// toggled on. Pure + deterministic.
//
// HOW the linkage is recovered:
//   • Roofline — by SURFACE tag. `roofline-santas` ↔ all `santas-roofline`
//     strands; `roofline-gingerbread` ↔ `santas-roofline` + `gingerbread`
//     strands (Gingerbread is the superset). Winter Wonderland ↔
//     `winter-wonderland` strands.
//   • Per-unit (mini / spritzer / wreath / garland) — by CATEGORY ORDER. The
//     saved result's per-unit line items and `projectScene(scene)` are both
//     produced from the same scene in scene order (the quote route projects the
//     scene into the inputs at Calculate), so we zip them per category.
//
// Robustness: if the scene was edited after the quote was last calculated, the
// per-category counts of frozen line items vs the live projection can diverge.
// Because the per-unit zip pairs purely by order, a divergence would silently
// mis-link (wrong drawn item hidden/highlighted, `recommended` on the wrong
// line). So per category we link ONLY when the counts match exactly; on any
// mismatch we skip linking that whole category (rows stay priced + visible, just
// not hideable until re-Calculate re-syncs). Roofline is linked by surface tag,
// not by order, so it is never affected (see audit fix #33 below). This mirrors
// the contract's "co-derived, born consistent" stance.

import type { Scene, Surface, SideOfHouse } from '@/lib/design/sceneTypes';
import { isStrand } from '@/lib/design/sceneTypes';
import { projectScene, type ProjectedCategory } from '@/lib/design/projectScene';
import type { PortalLineItem, PortalLineItemKind } from '@/components/portal/types';

const KIND_TO_CATEGORY: Partial<Record<PortalLineItemKind, ProjectedCategory>> = {
  tree: 'mini',
  bush: 'mini',
  column: 'mini',
  railing: 'mini',
  curtain: 'mini',
  spritzer: 'spritzer',
  wreath: 'wreath',
  garland: 'garland',
  bow: 'bow',
};

export function attachSceneLinks(lineItems: PortalLineItem[], scene: Scene): PortalLineItem[] {
  const items = Array.isArray(scene?.items) ? scene.items : [];
  const idsForSurface = (s: Surface) =>
    items.filter((i) => isStrand(i) && i.surface === s).map((i) => i.id);
  const santasIds = idsForSurface('santas-roofline');
  const gingerIds = idsForSurface('gingerbread');
  const wwIds = idsForSurface('winter-wonderland');
  const stakeIds = idsForSurface('stake-lighting');
  // Permanent Lighting (#88 / S23): per-side strand ids for the portal package
  // toggle. Permanent runs are tagged sideOfHouse + bulbType 'permanent' and DO
  // twin across photos (unlike holiday roofline), so a package deselect hides a
  // side's lights on EVERY angle (the twin expansion below adds the depictions).
  // Each side bills as its own line (#132); 'permanent-sides' is the pre-#132
  // combined left+right line still present on legacy stored results.
  const permanentSideIds = (sides: SideOfHouse[]) =>
    items
      .filter(
        (i) => isStrand(i) && i.bulbType === 'permanent' && i.sideOfHouse != null && sides.includes(i.sideOfHouse),
      )
      .map((i) => i.id);
  // Winter Wonderland is measurement-driven (NOT projected), so its `recommended`
  // flag (#12) rides on its scene strands rather than a ProjectedLineItem. Carry
  // it through on the WW line item so the portal's "Our Recommendation" can
  // include WW when staff check it in the builder (Jason S12). Santa's/Gingerbread
  // keep their own recommend mechanism (PortalRoofline) and never read this.
  const wwRecommended = items.some(
    (i) => isStrand(i) && i.surface === 'winter-wonderland' && i.recommended === true,
  );
  // Stake Lighting is also measurement-driven (NOT projected) and has its OWN
  // portal kind 'stake-lighting' (unlike WW which reuses 'ridge'), so its scene
  // link + recommended flag are recovered cleanly by kind below.
  const stakeRecommended = items.some(
    (i) => isStrand(i) && i.surface === 'stake-lighting' && i.recommended === true,
  );

  // Per-category projection queues, consumed in order to match the line items.
  // Each entry carries the scene-item ids AND the `recommended` flag (#12) from
  // the projected item, so design-driven recommended items reach the portal.
  type ProjEntry = { sceneItemIds: string[]; recommended?: boolean };
  const proj = projectScene(scene);
  // #104 PR2 — id-based linkage. Each projected per-unit line has a STABLE id
  // (`mini-<sceneItemId>` etc.), and (post-#104 PR1) each saved line item carries
  // the same id in `stableId`. Match by that id so a same-count reorder/swap can't
  // mis-link (closes the #90 residual): identity, not list position. A line whose
  // id no longer projects (its scene item was deleted) drops its link cleanly.
  const projById = new Map<string, ProjEntry>(
    proj.items.map((p) => [p.id, { sceneItemIds: p.sceneItemIds, recommended: p.recommended }]),
  );
  const toEntries = (cat: ProjectedCategory): ProjEntry[] =>
    proj.items.filter((p) => p.category === cat).map((p) => ({ sceneItemIds: p.sceneItemIds, recommended: p.recommended }));
  const queue: Record<ProjectedCategory, ProjEntry[]> = {
    mini: toEntries('mini'),
    spritzer: toEntries('spritzer'),
    wreath: toEntries('wreath'),
    garland: toEntries('garland'),
    bow: toEntries('bow'),
  };
  const cursor: Record<ProjectedCategory, number> = { mini: 0, spritzer: 0, wreath: 0, garland: 0, bow: 0 };

  // AUDIT FIX (#33) — count-mismatch guard against editing the design after the
  // last Calculate. The per-unit zip below pairs each frozen (saved-at-Calculate)
  // line item to a live projected scene item purely by per-category order. If
  // staff delete/reorder/toggle scene items after Calculate, the positional zip
  // silently mis-links — hiding/highlighting the wrong drawn item and carrying
  // the projected `recommended` flag onto the wrong line. We can't tell which
  // pairing is right without persisted stable ids (a data-contract change), so
  // the safe interim guard is: per category, if the frozen line-item count !==
  // the live projection count, skip per-unit linking for that category entirely
  // (the rows stay priced + visible, just not hideable until re-Calculate). This
  // never mis-links and never carries `recommended` across a count mismatch.
  // Roofline (linked by surface tag, not by order) is unaffected.
  const frozenCountForCat: Record<ProjectedCategory, number> = { mini: 0, spritzer: 0, wreath: 0, garland: 0, bow: 0 };
  for (const li of lineItems) {
    const cat = KIND_TO_CATEGORY[li.kind];
    if (cat) frozenCountForCat[cat]++;
  }
  const catLinkable: Record<ProjectedCategory, boolean> = {
    mini: frozenCountForCat.mini === queue.mini.length,
    spritzer: frozenCountForCat.spritzer === queue.spritzer.length,
    wreath: frozenCountForCat.wreath === queue.wreath.length,
    garland: frozenCountForCat.garland === queue.garland.length,
    bow: frozenCountForCat.bow === queue.bow.length,
  };

  const linked = lineItems.map((li) => {
    // Roofline tiers (synthesized by the adapter with stable ids). Roofline
    // keeps its OWN recommend mechanism (PortalRoofline) — never the per-item
    // `recommended` flag — so we only attach scene links here.
    if (li.id === 'roofline-santas') return { ...li, sceneItemIds: santasIds };
    if (li.id === 'roofline-gingerbread') return { ...li, sceneItemIds: [...santasIds, ...gingerIds] };
    // Winter Wonderland parses to kind 'ridge'; the Gingerbread roofline (also
    // 'ridge') is already handled above by id, so any remaining 'ridge' is WW.
    if (li.kind === 'ridge')
      return wwRecommended
        ? { ...li, sceneItemIds: wwIds, recommended: true }
        : { ...li, sceneItemIds: wwIds };
    // Stake Lighting — its own kind, linked by the 'stake-lighting' surface tag.
    if (li.kind === 'stake-lighting')
      return stakeRecommended
        ? { ...li, sceneItemIds: stakeIds, recommended: true }
        : { ...li, sceneItemIds: stakeIds };
    // Permanent per-side line items → the drawn permanent strands tagged that
    // side. The twin expansion below then carries the hide/show to every photo.
    if (li.id === 'permanent-front') return { ...li, sceneItemIds: permanentSideIds(['front']) };
    if (li.id === 'permanent-left') return { ...li, sceneItemIds: permanentSideIds(['left']) };
    if (li.id === 'permanent-right') return { ...li, sceneItemIds: permanentSideIds(['right']) };
    if (li.id === 'permanent-sides') return { ...li, sceneItemIds: permanentSideIds(['left', 'right']) };
    if (li.id === 'permanent-back') return { ...li, sceneItemIds: permanentSideIds(['back']) };

    const cat = KIND_TO_CATEGORY[li.kind];
    if (!cat) return li; // custom / unknown → no scene link

    // #104 PR2: prefer IDENTITY-based matching when the line carries a stable id
    // (any post-#104 saved result). Reorder/swap-proof; a deleted item drops its
    // link (no live scene item to hide) instead of mis-linking to a sibling.
    if (li.stableId !== undefined) {
      const entry = projById.get(li.stableId);
      if (!entry) return stripSceneLink(li); // its scene item is gone → no live link
      return entry.recommended
        ? { ...li, sceneItemIds: entry.sceneItemIds, recommended: true }
        : { ...li, sceneItemIds: entry.sceneItemIds };
    }

    // Legacy fallback (pre-#104 results with no stable id): the original per-category
    // positional zip, guarded by the count-mismatch check.
    if (catLinkable[cat]) {
      const entry = queue[cat][cursor[cat]++];
      if (entry) {
        // Carry `recommended` from the projected scene item. Custom rows (no
        // scene link) keep whatever `recommended` the adapter already set.
        return entry.recommended
          ? { ...li, sceneItemIds: entry.sceneItemIds, recommended: true }
          : { ...li, sceneItemIds: entry.sceneItemIds };
      }
    }
    return li; // unmatched → no scene link
  });

  // #13 linked twins: a twin is a render-only depiction of a canonical item on
  // another photo. The portal's toggle/recolor must reach EVERY depiction, so
  // each line's sceneItemIds expand with the twins of the ids already linked
  // (covers per-unit lines and the tag-linked roofline/WW/stake lines alike).
  const twinsByCanonical = new Map<string, string[]>();
  for (const i of items) {
    if (i.linkedToId) {
      const arr = twinsByCanonical.get(i.linkedToId) ?? [];
      arr.push(i.id);
      twinsByCanonical.set(i.linkedToId, arr);
    }
  }
  if (twinsByCanonical.size === 0) return linked;
  return linked.map((li) => {
    const ids = li.sceneItemIds;
    if (!ids || ids.length === 0) return li;
    const twins = ids.flatMap((id) => twinsByCanonical.get(id) ?? []);
    return twins.length > 0 ? { ...li, sceneItemIds: [...ids, ...twins] } : li;
  });
}

// #104 PR2: a stable-id line whose scene item was deleted after Calculate has no
// live scene item to hide — drop any stale sceneItemIds so the portal doesn't try
// to hide a non-existent item.
function stripSceneLink(li: PortalLineItem): PortalLineItem {
  if (li.sceneItemIds === undefined) return li;
  const rest = { ...li };
  delete rest.sceneItemIds;
  return rest;
}
