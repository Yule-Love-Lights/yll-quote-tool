// Permanent Lighting (#88 P7) — bridge a stored permanent quote's inputs onto the
// pure BOM engine. Operator-facing ordering + margin only; materials NEVER touch
// the customer price (that's the flat $/ft in pricing.ts). Pure: no DB/UI/I-O.

import { effectiveSideTrackStyle, type PermanentQuoteFields, type PermanentSide } from './types';
import { buildPermanentBom, type PermanentBom, type PermanentBomInput } from './bom';

// Untyped-DB-JSON clamp: a count that isn't a positive finite number reads 0.
const count = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/**
 * Map the per-side footage/corners + track/gap fields onto the BOM engine
 * input. `includedSides` (#192) scopes the ordered footage/corners to the
 * customer's APPROVED sides: undefined/null = unscoped (today's behavior,
 * every measured side bills); a Set zeroes footage/corners for any side NOT
 * in it. Gaps/controllerToFirstLightFt/accessories are NEVER scoped — no
 * side attribution exists for them (documented limitation; they stay
 * whole-job even on a partial-side booking).
 */
export function permanentBomInputFromFields(
  p: PermanentQuoteFields,
  includedSides?: ReadonlySet<PermanentSide> | null,
): PermanentBomInput {
  const included = (side: PermanentSide) => includedSides == null || includedSides.has(side);
  return {
    footageBySide: {
      front: included('front') ? p.frontFootage : 0,
      left: included('left') ? p.leftFootage : 0,
      right: included('right') ? p.rightFootage : 0,
      back: included('back') ? p.backFootage : 0,
    },
    cornersBySide: {
      front: included('front') ? p.frontCorners : 0,
      left: included('left') ? p.leftCorners : 0,
      right: included('right') ? p.rightCorners : 0,
      back: included('back') ? p.backCorners : 0,
    },
    // #192 — fully resolved per side (the pure BOM engine never sees "absent").
    trackStyleBySide: {
      front: effectiveSideTrackStyle(p, 'front'),
      left: effectiveSideTrackStyle(p, 'left'),
      right: effectiveSideTrackStyle(p, 'right'),
      back: effectiveSideTrackStyle(p, 'back'),
    },
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

// The pricing engine's stable per-side permanent line-item ids (mirrors
// derivePackagesPermanent.ts's FRONT_ID/LEFT_ID/RIGHT_ID/BACK_ID/LEGACY_SIDES_ID
// — not imported from there to avoid a portal-component ↔ BOM-engine dep; both
// read the same pricing.ts-assigned ids).
const SIDE_ITEM_ID: Record<string, PermanentSide[]> = {
  'permanent-front': ['front'],
  'permanent-left': ['left'],
  'permanent-right': ['right'],
  'permanent-back': ['back'],
  // Pre-#132 results carry ONE combined sides line under this id.
  'permanent-sides': ['left', 'right'],
};

/**
 * #192 — map a frozen approval_snapshot's customerSelection.selectedItemIds
 * (PortalLineItem ids) onto the permanent sides the customer actually
 * approved/booked. Returns null ("no scoping — include every side", today's
 * behavior) whenever the selection can't be confidently resolved: no
 * snapshot, no customerSelection, an empty/unparseable selectedItemIds, or a
 * selection that resolves to NO known permanent side id (a corrupted/foreign
 * snapshot). FAIL OPEN — never under-order a paid job.
 *
 * KNOWN LIMITATION (#674 review, documented not fixed — pre-existing parity
 * with #160's holiday selectedSceneItemIds, which reads the exact same frozen
 * `customerSelection` with no amendment awareness either): a side-ADDING
 * amendment on an already-booked order never updates THIS field. Concrete
 * case — a quote books front-only (`selectedItemIds: ['permanent-front']`),
 * then staff amend the order to add the back side; `approval_snapshot.
 * amendments[]` gets a `line_item_changes` entry recording the add, but
 * `customerSelection.selectedItemIds` (the ORIGINAL signed selection, by
 * design never overwritten — see amend.ts) still reads `['permanent-front']`
 * forever. This function has no way to see the amendment trail, so the
 * scoped BOM keeps excluding the newly-sold back side until a human notices
 * and hand-adjusts. Follow-up: ledger #193 (amendment-aware BOM/materials
 * scoping for both #192 permanent and #160 holiday).
 */
export function includedPermanentSidesFromSnapshot(snapshot: unknown): Set<PermanentSide> | null {
  const sel = (snapshot as { customerSelection?: { selectedItemIds?: unknown } } | null | undefined)
    ?.customerSelection;
  const raw = Array.isArray(sel?.selectedItemIds) ? sel.selectedItemIds : null;
  const ids = raw?.filter((x): x is string => typeof x === 'string') ?? null;
  if (!ids || ids.length === 0) return null;

  const sides = new Set<PermanentSide>();
  for (const id of ids) {
    for (const side of SIDE_ITEM_ID[id] ?? []) sides.add(side);
  }
  return sides.size > 0 ? sides : null;
}

/**
 * Build the BOM straight from a quote's stored inputs. Returns null when the quote
 * isn't a permanent quote (no `permanent` block) so callers can render nothing.
 * `costOverrides` (SKU → wholesale) lets P8 feed live inventory_catalog costs.
 * `includedSides` (#192) scopes footage/corners to the approved sides — see
 * permanentBomInputFromFields.
 */
export function permanentBomFromQuote(
  inputs: { permanent?: PermanentQuoteFields } | null | undefined,
  costOverrides?: ReadonlyMap<string, number>,
  includedSides?: ReadonlySet<PermanentSide> | null,
): PermanentBom | null {
  const p = inputs?.permanent;
  if (!p) return null;
  return buildPermanentBom(permanentBomInputFromFields(p, includedSides), costOverrides);
}
