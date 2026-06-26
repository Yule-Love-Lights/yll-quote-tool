// Pure parser: pricing-engine LineItem.label → portal kind + detail.
//
// The pricing engine produces freeform label strings:
//   "Santa's Roofline – 180ft (medium)"
//   "Gingerbread – 90ft (medium)"
//   "Winter Wonderland – 50ft (easy)"
//   "Stake Lighting – 50ft (medium)"
//   "Tree – canopy wrap, 4 strings"
//   "Bush – canopy wrap, 2 strings"
//   "Column – canopy wrap, 1 string"
//   "24\" Spritzer"          OR   "24\" Spritzers × 3"
//   "36\" Noble Wreath – With Bow"   OR  "× 2"
//   "9ft Noble Garland – Full Decor"  OR  "× 2"
//
// The portal needs structured `{ kind, detail }` to render category icons +
// a short detail string under each line item. This module is the only place
// that knows pricing-engine label syntax — if calculateRooflineItems() or
// any sibling changes its label format, fix it here, not in components.
//
// Fallback policy: anything we can't parse becomes kind='roofline' with the
// raw label as detail. The portal stays renderable even if a future label
// shape leaks through.

import type { PortalLineItemKind } from '@/components/portal/types';

export type ParsedLineItem = {
  kind: PortalLineItemKind;
  detail: string;
};

const TREE_RE = /^Tree\b/i;
const BUSH_RE = /^Bush\b/i;
const COLUMN_RE = /^Column\b/i;
const RAILING_RE = /^Railing\b/i;
// Standalone bow (#28): "Bow" or "Bows × 3". ANCHORED — wreath/garland labels
// contain "With Bow" mid-string and must keep matching their own kinds.
const BOW_RE = /^Bows?\b/i;
const RIDGE_RE = /(Gingerbread|Ridge|Wonderland)/i; // Gingerbread (ridge) OR Winter Wonderland
const STAKE_RE = /Stake Lighting/i; // independent stake-lighting runs — its OWN kind/icon
const ROOFLINE_RE = /Roofline/i;
const SPRITZER_RE = /Spritzer/i;
const WREATH_RE = /Wreath/i;
const GARLAND_RE = /Garland/i;

export function parseLineItem(label: string): ParsedLineItem {
  // Mini lights — Tree / Bush / Column. Detail = "N strings".
  if (TREE_RE.test(label)) return { kind: 'tree', detail: extractStrings(label) };
  if (BUSH_RE.test(label)) return { kind: 'bush', detail: extractStrings(label) };
  if (COLUMN_RE.test(label)) return { kind: 'column', detail: extractStrings(label) };
  // Railing — its own kind as of #34 (still PRICED like a bush at $35/string;
  // the kind only drives the portal icon/tier/scene-linkage).
  if (RAILING_RE.test(label)) return { kind: 'railing', detail: extractStrings(label) };

  // Standalone bow (#28). Detail = "1 bow" / "N bows".
  if (BOW_RE.test(label)) return { kind: 'bow', detail: extractBowDetail(label) };

  // Roofline family — order matters: the Ridge regex runs BEFORE Roofline.
  // "Gingerbread" (the ridge product, renamed from "Gingerbread Ridge") is
  // matched explicitly so it classifies as 'ridge', not 'roofline'. Detail = "N ft".
  if (RIDGE_RE.test(label)) return { kind: 'ridge', detail: extractFootage(label) };
  // Stake Lighting — its own independent kind (not part of the roofline family).
  // "Stake Lighting" contains no Gingerbread/Ridge/Wonderland/Roofline token, so
  // it would otherwise fall through to the 'roofline' fallback; classify it here.
  if (STAKE_RE.test(label)) return { kind: 'stake-lighting', detail: extractFootage(label) };
  if (ROOFLINE_RE.test(label)) return { kind: 'roofline', detail: extractFootage(label) };

  // Spritzers — detail = "N × 24\""
  if (SPRITZER_RE.test(label)) return { kind: 'spritzer', detail: extractSpritzerDetail(label) };

  // Decor — wreath / garland. Detail = tier label ("With Bow") + qty.
  if (WREATH_RE.test(label)) return { kind: 'wreath', detail: extractDecorDetail(label) };
  if (GARLAND_RE.test(label)) return { kind: 'garland', detail: extractDecorDetail(label) };

  // Unknown — render under roofline so the icon still works. Detail = the
  // raw label (clipped) so admins can spot mis-categorization in the wild.
  return { kind: 'roofline', detail: label.length > 40 ? `${label.slice(0, 37)}…` : label };
}

function extractStrings(label: string): string {
  const m = label.match(/(\d+)\s+strings?/i);
  if (!m) return '';
  const n = parseInt(m[1], 10);
  return n === 1 ? '1 string' : `${n} strings`;
}

function extractFootage(label: string): string {
  const m = label.match(/(\d+)\s*ft/i);
  return m ? `${m[1]} ft` : '';
}

function extractSpritzerDetail(label: string): string {
  const sizeM = label.match(/(\d+)"\s*Spritzer/i);
  const qtyM = label.match(/×\s*(\d+)/);
  const qty = qtyM ? parseInt(qtyM[1], 10) : 1;
  if (!sizeM) return qty === 1 ? '1 stake' : `${qty} stakes`;
  return qty === 1 ? `1 × ${sizeM[1]}"` : `${qty} × ${sizeM[1]}"`;
}

function extractBowDetail(label: string): string {
  const qtyM = label.match(/×\s*(\d+)/);
  const qty = qtyM ? parseInt(qtyM[1], 10) : 1;
  return qty === 1 ? '1 bow' : `${qty} bows`;
}

function extractDecorDetail(label: string): string {
  // Pricing engine format: "<base> – <tier>" optionally followed by " × N".
  // Pull the tier (between "–" and "×" or end) and the quantity separately.
  const tierM = label.match(/–\s*([^×]+?)(?:\s*×|$)/);
  const qtyM = label.match(/×\s*(\d+)/);
  const tier = tierM?.[1].trim() ?? '';
  const qty = qtyM ? parseInt(qtyM[1], 10) : 1;
  if (!tier) return qty === 1 ? '1 piece' : `${qty} pieces`;
  return qty === 1 ? tier : `${tier} × ${qty}`;
}

// Generate a stable per-quote ID for a line item. The pricing engine doesn't
// emit IDs — but the portal's selection state needs one. We key by kind +
// position-of-this-kind-in-the-list so repeated kinds get distinct IDs:
//   roofline-1, ridge-1, tree-1, tree-2, bush-1, bush-2, …
//
// IDs are deterministic for the same `result.lineItems` array, so the
// selection state is reproducible across page loads of the same quote.
export function buildLineItemId(kind: PortalLineItemKind, indexOfKind: number): string {
  return `${kind}-${indexOfKind + 1}`;
}
