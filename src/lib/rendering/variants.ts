// Per-package render variants for the customer portal.
//
// Each customer-facing package on the quote portal (Santa's Roofline,
// Gingerbread Ridge, Mini Lights, Wreaths, Spritzers, Garland) gets its
// own preview render that shows the house with ONLY that package's lights
// installed. This file is the single source of truth for which vision
// fields belong to which variant.
//
// Why a pure module: the filter is called from the orchestrator during
// render generation AND potentially from anywhere we want to compute a
// variant cache key without running a render. Keeping it side-effect-free
// makes both safe.
//
// Stacking semantics: 'ridge' is unique in that it stacks ON TOP of
// Santa's. In the YLL business model, Gingerbread Ridge is sold as an
// upsell to Santa's Roofline — a render of the ridge alone (peak lit,
// gutters dark) doesn't reflect what a customer would actually see if
// they bought the package. Every other variant is sold à la carte and
// reads visually correct in isolation, so they get pure isolation.

import type { RenderVariant, RenderVisionInput } from './types';

const EMPTY_VISION: RenderVisionInput = {
  santasLines: [],
  gingerbreadLines: [],
  c9Lines: [],
  miniLights: [],
  wreaths: [],
  spritzers: [],
  garland: [],
};

// Returns a NEW vision input with only the fields relevant to `variant`.
// Pure function — does not mutate the input. Safe to share across renders.
//
// 'full' returns the input unchanged (passes through). Every other variant
// starts from EMPTY_VISION and copies in only the fields that belong.
export function filterVisionForVariant(
  vision: RenderVisionInput,
  variant: RenderVariant,
): RenderVisionInput {
  if (variant === 'full') {
    return vision;
  }
  const base = { ...EMPTY_VISION };
  switch (variant) {
    case 'santas':
      base.santasLines = vision.santasLines;
      return base;
    case 'ridge':
      // Stacked: ridge is sold on top of Santa's, never alone.
      base.santasLines = vision.santasLines;
      base.gingerbreadLines = vision.gingerbreadLines;
      return base;
    case 'minis':
      base.miniLights = vision.miniLights;
      return base;
    case 'wreaths':
      base.wreaths = vision.wreaths;
      return base;
    case 'spritzers':
      base.spritzers = vision.spritzers;
      return base;
    case 'garland':
      base.garland = vision.garland;
      return base;
    default: {
      // Exhaustiveness check — if a new variant is added to RenderVariant
      // without a case here, TypeScript surfaces the missing branch.
      const _exhaustive: never = variant;
      void _exhaustive;
      return base;
    }
  }
}

// Does this variant have anything to render given the supplied vision?
// Used by the batch entry point to skip variants that would produce an
// empty render (e.g., 'wreaths' on a quote with no wreaths detected).
// Skipping is preferable to rendering a "house with literally zero lights
// installed" placeholder.
export function variantHasContent(
  vision: RenderVisionInput,
  variant: RenderVariant,
): boolean {
  if (variant === 'full') return true;
  const filtered = filterVisionForVariant(vision, variant);
  return (
    (filtered.santasLines?.length ?? 0) > 0 ||
    (filtered.gingerbreadLines?.length ?? 0) > 0 ||
    (filtered.c9Lines?.length ?? 0) > 0 ||
    (filtered.miniLights?.length ?? 0) > 0 ||
    (filtered.wreaths?.length ?? 0) > 0 ||
    (filtered.spritzers?.length ?? 0) > 0 ||
    (filtered.garland?.length ?? 0) > 0
  );
}

// Customer-facing label for each variant. Used by the admin grid + the
// portal cards. Kept here so renaming is one-edit.
export const VARIANT_LABELS: Record<RenderVariant, string> = {
  full: 'Full Package',
  santas: "Santa's Roofline",
  ridge: 'Gingerbread Ridge',
  minis: 'Mini Lights',
  wreaths: 'Wreaths',
  spritzers: 'Spritzers',
  garland: 'Garland',
};
