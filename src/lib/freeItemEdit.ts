// Post-approval FREE-item selection edit (ledger #162). PURE helpers — no IO.
//
// What this is: staff can add or remove a ZERO-DOLLAR line item on an already-
// approved / booked quote (the "free spritzers the customer should have had"
// case). Deliberately SEPARATE from amend (src/lib/amend.ts), which re-prices a
// booked order and moves money. This path only ever adds/removes a $0 line, so
// the order total, deposit, and balance are invariant BY CONSTRUCTION — the
// route asserts it and records a zero-delta amendment-trail entry so every
// settlement gate (blocksSettlement / requiresReconsent) already treats it as
// the cosmetic change it is.
//
// The free item reuses the existing $0-custom-line-item mechanism (the referral
// "2 Free 16\" Spritzers" pattern, QuoteBuilder.tsx): a customLineItem with
// amount 0 flows through calculateCustomLineItems as an ordinary $0 line with
// zero subtotal/tax impact. So an added item lands in inputs.customLineItems +
// result.lineItems (for the portal/PDF/job to render) and its derived portal id
// joins the approval snapshot's selectedItemIds (so it counts as approved).

import type { QuoteInputs, QuoteResult } from './pricing/pricingEngine';
import { calculateCustomLineItems } from './pricing/pricingEngine';
import { buildPortalLineItems } from './portal/adapter';

export const MAX_FREE_ITEM_LABEL = 120;
export const MAX_FREE_ITEM_QTY = 99;

// Quantity defaults to 1; a missing / invalid / <1 value is treated as 1, and
// it is floored + capped at MAX_FREE_ITEM_QTY. Mirrors the engine's own
// quantity handling (calculateCustomLineItems) so a future recompute is stable.
function normalizeQty(q: number | undefined): number {
  if (typeof q !== 'number' || !Number.isFinite(q) || q < 1) return 1;
  return Math.min(Math.floor(q), MAX_FREE_ITEM_QTY);
}

export type AddFreeItemInput = {
  inputs: QuoteInputs | null;
  result: QuoteResult;
  // The customer's currently-approved selection (approval_snapshot
  // .customerSelection.selectedItemIds).
  selectedItemIds: string[];
  label: string;
  quantity?: number;
  // A caller-generated stable id for the new custom line (the route passes
  // crypto.randomUUID()); taken as a param so the pure fn stays deterministic.
  id: string;
};

export type FreeItemEdit = {
  inputs: QuoteInputs;
  result: QuoteResult;
  selectedItemIds: string[];
  // The DERIVED portal line id (buildPortalLineItems) of the affected free item,
  // added to / removed from selectedItemIds.
  addedPortalId: string;
  // The engine-formatted label of the added line ("Free spritzers × 2").
  addedLabel: string;
  // True when the item was already present (idempotent no-op add) — no new line
  // was created, but the returned selection still includes it.
  alreadyPresent: boolean;
};

export type RemoveFreeItemInput = {
  inputs: QuoteInputs | null;
  result: QuoteResult;
  selectedItemIds: string[];
  // The DERIVED portal line id (as stored in selectedItemIds) to remove.
  portalId: string;
};

export type FreeItemRemoval = {
  inputs: QuoteInputs;
  result: QuoteResult;
  selectedItemIds: string[];
  removedPortalId: string;
  removedLabel: string;
};

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function addFreeLineItem(input: AddFreeItemInput): FreeItemEdit {
  const { inputs, result, selectedItemIds, id } = input;
  const label = input.label.trim();
  if (!label) {
    throw new Error('addFreeLineItem: a non-empty label is required');
  }
  if (label.length > MAX_FREE_ITEM_LABEL) {
    throw new Error(`addFreeLineItem: label exceeds ${MAX_FREE_ITEM_LABEL} characters`);
  }
  const quantity = normalizeQty(input.quantity);

  // Idempotency: a $0 custom line with the same label is the SAME free item —
  // return it unchanged (no duplicate) with its existing portal id ensured in
  // the selection. Guards a double-click / route retry.
  const dupe = (inputs?.customLineItems ?? []).find(
    (c) => c && c.amount === 0 && typeof c.label === 'string' && norm(c.label) === norm(label),
  );
  if (dupe) {
    const portalLines = buildPortalLineItems(result, inputs).lineItems;
    const existing = dupe.id
      ? portalLines.find((li) => li.stableId === dupe.id)
      : portalLines.find((li) => li.price === 0 && norm(li.label) === norm(dupe.label));
    if (existing) {
      const withSel = selectedItemIds.includes(existing.id)
        ? selectedItemIds
        : [...selectedItemIds, existing.id];
      return {
        inputs: inputs ?? ({ customLineItems: [] } as unknown as QuoteInputs),
        result,
        selectedItemIds: withSel,
        addedPortalId: existing.id,
        addedLabel: existing.label,
        alreadyPresent: true,
      };
    }
    // A dupe in inputs with no resolvable portal line is a corrupt/partial row;
    // fall through and add a fresh, self-consistent line rather than throwing.
  }

  // The free item is a $0 custom line — amount is ALWAYS forced to 0 here, so
  // no caller path can turn this into a priced change.
  const customLine = { id, label, amount: 0, quantity };
  const newInputs: QuoteInputs = {
    ...(inputs ?? ({} as QuoteInputs)),
    customLineItems: [...(inputs?.customLineItems ?? []), customLine],
  };
  // Build the EXACT $0 result line the pricing engine would emit for this custom
  // item (same label/qty transform), so result stays a faithful function of
  // inputs without a full re-price (which could pick up drifted rates).
  const [engineLine] = calculateCustomLineItems({
    customLineItems: [customLine],
  } as QuoteInputs);
  const newResult: QuoteResult = {
    ...result,
    lineItems: [...result.lineItems, engineLine],
  };

  // The portal id is derived (buildLineItemId), so resolve it by identity: the
  // new line carries stableId === id.
  const { lineItems } = buildPortalLineItems(newResult, newInputs);
  const addedLine = lineItems.find((li) => li.stableId === id);
  if (!addedLine) {
    throw new Error('addFreeLineItem: could not resolve the new portal line id');
  }
  const addedPortalId = addedLine.id;
  const newSelectedItemIds = selectedItemIds.includes(addedPortalId)
    ? selectedItemIds
    : [...selectedItemIds, addedPortalId];

  return {
    inputs: newInputs,
    result: newResult,
    selectedItemIds: newSelectedItemIds,
    addedPortalId,
    addedLabel: engineLine.label,
    alreadyPresent: false,
  };
}

export function removeFreeLineItem(input: RemoveFreeItemInput): FreeItemRemoval {
  const { inputs, result, selectedItemIds, portalId } = input;

  const portalLines = buildPortalLineItems(result, inputs).lineItems;
  const target = portalLines.find((li) => li.id === portalId);
  if (!target) {
    throw new Error(`removeFreeLineItem: line not found (unknown portal id "${portalId}")`);
  }
  // Only a $0 line is removable here. A priced line changes the total, so it
  // MUST go through amend (money path) — never this selection-only edit.
  if (target.price !== 0) {
    throw new Error(
      'removeFreeLineItem: refusing to remove a priced line here — a non-$0 change goes through amend',
    );
  }

  // The custom line's stable id (the raw result/inputs id) rides as stableId on
  // the portal line. Drop the line from result + inputs by that identity, and
  // the portal id from the selection.
  const stableId = target.stableId;
  const newResult: QuoteResult = stableId
    ? { ...result, lineItems: result.lineItems.filter((li) => li.id !== stableId) }
    : result;
  const newInputs: QuoteInputs = {
    ...(inputs ?? ({ customLineItems: [] } as unknown as QuoteInputs)),
    customLineItems: stableId
      ? (inputs?.customLineItems ?? []).filter((c) => c.id !== stableId)
      : (inputs?.customLineItems ?? []),
  };

  return {
    inputs: newInputs,
    result: newResult,
    selectedItemIds: selectedItemIds.filter((sid) => sid !== portalId),
    removedPortalId: portalId,
    removedLabel: target.label,
  };
}
