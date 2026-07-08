// Permanent Lighting (#88 P7) — bridge a stored permanent quote's inputs onto the
// pure BOM engine. Operator-facing ordering + margin only; materials NEVER touch
// the customer price (that's the flat $/ft in pricing.ts). Pure: no DB/UI/I-O.

import type { PermanentQuoteFields } from './types';
import { buildPermanentBom, type PermanentBom, type PermanentBomInput } from './bom';

// Untyped-DB-JSON clamp: a count that isn't a positive finite number reads 0.
const count = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

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
    // Default to [] — inputs.permanent comes from untyped DB JSON, and a stored
    // block that predates/omits gaps would otherwise be undefined → buildPermanentBom
    // does `input.gaps.filter(...)`, 500-ing the operator BOM + print pages.
    gaps: Array.isArray(p.gaps) ? p.gaps : [],
    // #140 precedence — THE predicate: the Extensions/Splitters card overrides
    // the gaps path ONLY once something actually wrote it (`accessoriesSource`
    // set by the geometry/AI seed or the operator). Never key on the objects
    // merely existing: a defaulted all-zero `extensions` would silently zero
    // the BOM of every legacy quote that still orders via its gaps rows.
    ...(p.accessoriesSource != null
      ? {
          accessories: {
            extensions: {
              e3: count(p.extensions?.e3),
              e5: count(p.extensions?.e5),
              e10: count(p.extensions?.e10),
              e25: count(p.extensions?.e25),
            },
            splitters: count(p.splittersNeeded),
            jumpBoosters: count(p.jumpBoosters),
          },
        }
      : {}),
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
