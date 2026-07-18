import { describe, it, expect } from 'vitest';
import { calculateQuote, type QuoteInputs } from './pricing/pricingEngine';
import { buildPortalLineItems } from './portal/adapter';
import { addFreeLineItem, removeFreeLineItem } from './freeItemEdit';

// A fully-zeroed quote (mirrors pricingEngine.test.ts's emptyInputs).
function emptyInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    santasFootage: 0,
    santasDifficulty: 'medium',
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'medium',
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'medium',
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'medium',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
    ...overrides,
  };
}

// A realistic priced holiday quote (one roofline, total > 0), with the customer
// having approved the WHOLE quote (selection = every derived portal line id).
function pricedQuote() {
  const inputs = emptyInputs({ santasFootage: 200, santasDifficulty: 'medium' }); // 200 × 10 = $2,000
  const result = calculateQuote(inputs);
  const { lineItems } = buildPortalLineItems(result, inputs);
  const selectedItemIds = lineItems.map((li) => li.id);
  return { inputs, result, selectedItemIds };
}

describe('addFreeLineItem — adds a $0 line to the approved selection', () => {
  it('adds the free item as a $0 portal line included in the selection', () => {
    const { inputs, result, selectedItemIds } = pricedQuote();

    const edited = addFreeLineItem({
      inputs,
      result,
      selectedItemIds,
      label: 'Free spritzers',
      quantity: 2,
      id: 'free-1',
    });

    const { lineItems } = buildPortalLineItems(edited.result, edited.inputs);
    const added = lineItems.find((li) => li.id === edited.addedPortalId);
    expect(added).toBeDefined();
    expect(added!.price).toBe(0);
    expect(added!.label).toBe('Free spritzers × 2');
    expect(edited.selectedItemIds).toContain(edited.addedPortalId);
    expect(edited.alreadyPresent).toBe(false);
  });

  it('derives the correct portal id even when the quote already has custom items', () => {
    // Two existing custom items so the new one is the THIRD custom line — its
    // positional portal id must be resolved by identity, not a guessed index.
    const inputs = emptyInputs({
      santasFootage: 200,
      santasDifficulty: 'medium',
      customLineItems: [
        { id: 'c-1', label: 'Existing A', amount: 100, quantity: 1 },
        { id: 'c-2', label: 'Existing B', amount: 200, quantity: 1 },
      ],
    });
    const result = calculateQuote(inputs);
    const { lineItems } = buildPortalLineItems(result, inputs);
    const selectedItemIds = lineItems.map((li) => li.id);

    const edited = addFreeLineItem({
      inputs,
      result,
      selectedItemIds,
      label: 'Free wreath',
      id: 'free-9',
    });
    const after = buildPortalLineItems(edited.result, edited.inputs).lineItems;
    const added = after.find((li) => li.stableId === 'free-9');
    expect(added).toBeDefined();
    expect(added!.id).toBe(edited.addedPortalId);
    expect(added!.price).toBe(0);
  });
});

describe('addFreeLineItem — the money invariant (guard)', () => {
  it('never changes any whole-quote total (the added line is $0)', () => {
    const { inputs, result, selectedItemIds } = pricedQuote();
    const edited = addFreeLineItem({
      inputs,
      result,
      selectedItemIds,
      label: 'Free spritzers',
      quantity: 3,
      id: 'free-1',
    });
    expect(edited.result.total).toBe(result.total);
    expect(edited.result.subtotalBeforeDiscount).toBe(result.subtotalBeforeDiscount);
    expect(edited.result.subtotalAfterDiscount).toBe(result.subtotalAfterDiscount);
    expect(edited.result.taxableAmount).toBe(result.taxableAmount);
    expect(edited.result.taxAmount).toBe(result.taxAmount);
    expect(edited.result.depositAmount).toBe(result.depositAmount);
    expect(edited.result.balanceDue).toBe(result.balanceDue);
  });

  it('leaves the SELECTED subtotal (what the customer pays) unchanged', () => {
    const { inputs, result, selectedItemIds } = pricedQuote();
    const sel = new Set(selectedItemIds);
    const before = buildPortalLineItems(result, inputs)
      .lineItems.filter((li) => sel.has(li.id))
      .reduce((s, li) => s + li.price, 0);

    const edited = addFreeLineItem({
      inputs,
      result,
      selectedItemIds,
      label: 'Free spritzers',
      id: 'free-1',
    });
    const selAfter = new Set(edited.selectedItemIds);
    const after = buildPortalLineItems(edited.result, edited.inputs)
      .lineItems.filter((li) => selAfter.has(li.id))
      .reduce((s, li) => s + li.price, 0);
    expect(after).toBe(before);
  });
});

describe('addFreeLineItem — idempotency + validation', () => {
  it('is idempotent by label — adding the same free item twice keeps ONE line', () => {
    const { inputs, result, selectedItemIds } = pricedQuote();
    const first = addFreeLineItem({
      inputs,
      result,
      selectedItemIds,
      label: 'Free spritzers',
      quantity: 2,
      id: 'free-1',
    });
    const second = addFreeLineItem({
      inputs: first.inputs,
      result: first.result,
      selectedItemIds: first.selectedItemIds,
      label: 'Free spritzers',
      quantity: 2,
      id: 'free-2',
    });

    expect(second.alreadyPresent).toBe(true);
    const zeroCustoms = (second.inputs.customLineItems ?? []).filter((c) => c.amount === 0);
    expect(zeroCustoms).toHaveLength(1);
    expect(second.selectedItemIds).toEqual(first.selectedItemIds);
    expect(second.addedPortalId).toBe(first.addedPortalId);
  });

  it('rejects an empty / whitespace-only label', () => {
    const { inputs, result, selectedItemIds } = pricedQuote();
    expect(() =>
      addFreeLineItem({ inputs, result, selectedItemIds, label: '   ', id: 'free-1' }),
    ).toThrow(/label/i);
  });
});

describe('removeFreeLineItem', () => {
  function withFreeItem() {
    const { inputs, result, selectedItemIds } = pricedQuote();
    return addFreeLineItem({
      inputs,
      result,
      selectedItemIds,
      label: 'Free spritzers',
      quantity: 2,
      id: 'free-1',
    });
  }

  it('removes a $0 free item from result, inputs, and the selection — total unchanged', () => {
    const added = withFreeItem();
    const removed = removeFreeLineItem({
      inputs: added.inputs,
      result: added.result,
      selectedItemIds: added.selectedItemIds,
      portalId: added.addedPortalId,
    });

    expect(removed.selectedItemIds).not.toContain(added.addedPortalId);
    const after = buildPortalLineItems(removed.result, removed.inputs).lineItems;
    expect(after.find((li) => li.stableId === 'free-1')).toBeUndefined();
    expect((removed.inputs.customLineItems ?? []).some((c) => c.id === 'free-1')).toBe(false);
    expect(removed.result.total).toBe(added.result.total);
    expect(removed.removedPortalId).toBe(added.addedPortalId);
  });

  it('refuses to remove a priced (non-$0) line', () => {
    const { inputs, result, selectedItemIds } = pricedQuote();
    const priced = buildPortalLineItems(result, inputs).lineItems.find((li) => li.price > 0)!;
    expect(() =>
      removeFreeLineItem({ inputs, result, selectedItemIds, portalId: priced.id }),
    ).toThrow(/\$0|free|priced|zero/i);
  });

  it('throws on an unknown portal id', () => {
    const { inputs, result, selectedItemIds } = pricedQuote();
    expect(() =>
      removeFreeLineItem({ inputs, result, selectedItemIds, portalId: 'nope-999' }),
    ).toThrow(/not found|unknown/i);
  });
});
