// Permanent Lighting (#88 P7) — bridge a stored permanent quote's inputs onto the
// pure BOM engine. Operator-facing ordering + margin only; materials NEVER touch
// the customer price (that's the flat $/ft in pricing.ts). Pure: no DB/UI/I-O.

import type { PermanentQuoteFields } from './types';
import { buildPermanentBom, type PermanentBom, type PermanentBomInput } from './bom';

/** Map the per-side footage/corners + track/gap fields onto the BOM engine input. */
export function permanentBomInputFromFields(p: PermanentQuoteFields): PermanentBomInput {
  return {
    footageBySide: {
      front: p.frontFootage,
      left: p.leftFootage,
      right: p.rightFootage,
      back: p.backFootage,
    },
    cornersBySide: {
      front: p.frontCorners,
      left: p.leftCorners,
      right: p.rightCorners,
      back: p.backCorners,
    },
    trackStyle: p.trackStyle,
    trackColor: p.trackColor,
    blackHousing: p.blackHousing,
    controllerToFirstLightFt: p.controllerToFirstLightFt,
    gaps: p.gaps,
  };
}

/**
 * Build the BOM straight from a quote's stored inputs. Returns null when the quote
 * isn't a permanent quote (no `permanent` block) so callers can render nothing.
 * `costOverrides` (SKU → wholesale) lets P8 feed live inventory_catalog costs.
 */
export function permanentBomFromQuote(
  inputs: { permanent?: PermanentQuoteFields } | null | undefined,
  costOverrides?: ReadonlyMap<string, number>,
): PermanentBom | null {
  const p = inputs?.permanent;
  if (!p) return null;
  return buildPermanentBom(permanentBomInputFromFields(p), costOverrides);
}
