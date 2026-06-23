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
// zip can fall short — extra line items simply get no `sceneItemIds` (not
// hideable, still priced) and extra scene items stay always-visible. Re-Calculate
// re-syncs. This mirrors the contract's "co-derived, born consistent" stance.

import type { Scene, Surface } from '@/lib/design/sceneTypes';
import { isStrand } from '@/lib/design/sceneTypes';
import { projectScene, type ProjectedCategory } from '@/lib/design/projectScene';
import type { PortalLineItem, PortalLineItemKind } from '@/components/portal/types';

const KIND_TO_CATEGORY: Partial<Record<PortalLineItemKind, ProjectedCategory>> = {
  tree: 'mini',
  bush: 'mini',
  column: 'mini',
  railing: 'mini',
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
  // Winter Wonderland is measurement-driven (NOT projected), so its `recommended`
  // flag (#12) rides on its scene strands rather than a ProjectedLineItem. Carry
  // it through on the WW line item so the portal's "Our Recommendation" can
  // include WW when staff check it in the builder (Jason S12). Santa's/Gingerbread
  // keep their own recommend mechanism (PortalRoofline) and never read this.
  const wwRecommended = items.some(
    (i) => isStrand(i) && i.surface === 'winter-wonderland' && i.recommended === true,
  );

  // Per-category projection queues, consumed in order to match the line items.
  // Each entry carries the scene-item ids AND the `recommended` flag (#12) from
  // the projected item, so design-driven recommended items reach the portal.
  type ProjEntry = { sceneItemIds: string[]; recommended?: boolean };
  const proj = projectScene(scene);
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

  return lineItems.map((li) => {
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

    const cat = KIND_TO_CATEGORY[li.kind];
    if (cat) {
      const entry = queue[cat][cursor[cat]++];
      if (entry) {
        // Carry `recommended` from the projected scene item. Custom rows (no
        // scene link) keep whatever `recommended` the adapter already set.
        return entry.recommended
          ? { ...li, sceneItemIds: entry.sceneItemIds, recommended: true }
          : { ...li, sceneItemIds: entry.sceneItemIds };
      }
    }
    return li; // custom / unknown / unmatched → no scene link
  });
}
