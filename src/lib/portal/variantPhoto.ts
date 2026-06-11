// Picks the right variant preview image URL for a given portal item kind.
//
// Each customer-visible package on the portal corresponds to one variant
// rendered by the AI pipeline. This helper hides the kind→variant mapping
// from the cards so they don't have to know about render-engine identifiers.
//
// Returns the variant URL when available; falls back to the 'full' photo
// (passed in as `fallback`) when the variant hasn't been rendered or
// approved yet. Cards should render an <img> only when the returned value
// is non-empty.
//
// Why a separate helper instead of inlining a switch in every card:
//   - One place to update if business renames a package or adds a variant.
//   - Keeps cards declarative — they ask for a photo, not for a render row.

import type {
  PortalLineItemKind,
  PortalVariantPhotos,
} from '@/components/portal/types';

// Mapping from portal item kind → variant key. Note that portal kinds
// 'tree' / 'bush' / 'column' all map to 'minis' because they share the
// same install (mini-light wrap), and the AI renders them together.
const KIND_TO_VARIANT: Record<PortalLineItemKind, keyof PortalVariantPhotos> = {
  roofline: 'santas',
  ridge: 'ridge',
  tree: 'minis',
  bush: 'minis',
  column: 'minis',
  wreath: 'wreaths',
  garland: 'garland',
  spritzer: 'spritzers',
  // Standalone bow (#28) rides the wreaths variant — no dedicated AI render
  // variant exists for bows (and the render pipeline is slated for replacement).
  bow: 'wreaths',
  // Railing (#34) is a mini-light install — rides the minis variant.
  railing: 'minis',
};

export function variantPhotoForKind(
  kind: PortalLineItemKind,
  variantPhotos: PortalVariantPhotos,
  fallback: string,
): string {
  const key = KIND_TO_VARIANT[kind];
  return variantPhotos[key] ?? fallback;
}

// Variant key → portal kind, used by the admin grid label cross-reference.
export function variantKeyToHumanLabel(key: keyof PortalVariantPhotos): string {
  switch (key) {
    case 'santas': return "Santa's Roofline";
    case 'ridge': return 'Gingerbread';
    case 'minis': return 'Mini Lights';
    case 'wreaths': return 'Wreaths';
    case 'spritzers': return 'Spritzers';
    case 'garland': return 'Garland';
  }
}
