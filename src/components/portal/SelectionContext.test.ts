import { describe, it, expect } from 'vitest';
import {
  computeInitialSelection,
  nextSelectedItemIds,
  nextPackageSelectedItemIds,
  frozenMutatorGroups,
} from './SelectionContext';
import { sumSelectedItems } from './format';
import { priceSelection, effectiveCharges, orderMinimumStatus } from '@/lib/portal/derivePackages';
import type { PortalCharges, PortalPackage } from './types';

// Minimal package list — only id + includedItemIds matter for the seed.
const pkg = (id: PortalPackage['id'], includedItemIds: string[]): PortalPackage => ({
  id,
  name: `Package ${id}`,
  tagline: '',
  total: 0,
  deposit: 0,
  includedItemIds,
});

const PACKAGES: PortalPackage[] = [
  pkg('A', ['roofline-santas']),
  pkg('B', ['roofline-santas', 'bush-1', 'wreath-1']),
  pkg('C', ['roofline-santas', 'bush-1', 'bush-2', 'wreath-1', 'garland-1']),
];

describe('computeInitialSelection (#12)', () => {
  it('FALLBACK: seeds from the initial package when no recommended ids are given', () => {
    const seed = computeInitialSelection(PACKAGES, 'B');
    expect(seed.packageId).toBe('B');
    expect(seed.selectedItemIds).toEqual(['roofline-santas', 'bush-1', 'wreath-1']);
  });

  it('FALLBACK: an empty recommended list is treated as absent (unchanged default)', () => {
    const seed = computeInitialSelection(PACKAGES, 'C', []);
    expect(seed.packageId).toBe('C');
    expect(seed.selectedItemIds).toEqual(PACKAGES[2].includedItemIds);
  });

  it('FALLBACK: empty selection when the initial package id is unknown', () => {
    const seed = computeInitialSelection(PACKAGES, 'D');
    expect(seed.packageId).toBe('D');
    expect(seed.selectedItemIds).toEqual([]);
  });

  it('RECOMMENDED: seeds EXACTLY the recommended ids and switches to custom (D)', () => {
    const seed = computeInitialSelection(PACKAGES, 'B', ['roofline-santas', 'wreath-1']);
    expect(seed.packageId).toBe('D');
    expect(seed.selectedItemIds).toEqual(['roofline-santas', 'wreath-1']);
  });

  it('RECOMMENDED: ignores the package bundle entirely (only the recommended ids)', () => {
    const seed = computeInitialSelection(PACKAGES, 'C', ['garland-1']);
    expect(seed.packageId).toBe('D');
    expect(seed.selectedItemIds).toEqual(['garland-1']);
  });

  it('RECOMMENDED: copies the ids (does not return the same array reference)', () => {
    const ids = ['bush-1'];
    const seed = computeInitialSelection(PACKAGES, 'B', ids);
    expect(seed.selectedItemIds).not.toBe(ids);
    expect(seed.selectedItemIds).toEqual(['bush-1']);
  });
});

// Audit #110 W4-011 — toggleItem/selectPackage had zero coverage. These
// reducers are extracted verbatim from SelectionContext's toggleItem/
// selectPackage callbacks (the provider now calls them directly), so testing
// the pure functions here IS testing the live selection logic — including
// the money-sensitive either/or roofline rule (a double roofline would
// double-count the subtotal/approve total).
describe('nextSelectedItemIds — mutually-exclusive roofline (XOR) + plain toggle', () => {
  const ROOFLINE_GROUP = new Set(['roofline-santas', 'roofline-gingerbread']);

  it('adding a roofline item when none is selected just adds it', () => {
    const next = nextSelectedItemIds(new Set(), 'roofline-santas', ROOFLINE_GROUP);
    expect(next).toEqual(new Set(['roofline-santas']));
  });

  it('adding gingerbread while santas is selected removes santas and keeps exactly gingerbread', () => {
    const prev = new Set(['roofline-santas', 'bush-1']);
    const next = nextSelectedItemIds(prev, 'roofline-gingerbread', ROOFLINE_GROUP);
    expect(next).toEqual(new Set(['bush-1', 'roofline-gingerbread']));
    expect(next.has('roofline-santas')).toBe(false);
  });

  it('adding santas while gingerbread is selected removes gingerbread (symmetric)', () => {
    const prev = new Set(['roofline-gingerbread']);
    const next = nextSelectedItemIds(prev, 'roofline-santas', ROOFLINE_GROUP);
    expect(next).toEqual(new Set(['roofline-santas']));
  });

  it('never allows both roofline options selected at once, regardless of starting state', () => {
    const prev = new Set(['roofline-santas', 'roofline-gingerbread']); // shouldn't happen, but defend it
    const next = nextSelectedItemIds(prev, 'roofline-gingerbread', ROOFLINE_GROUP);
    // Toggling an already-selected item off is a plain delete (no sibling touch).
    expect(next).toEqual(new Set(['roofline-santas']));
  });

  it('toggling OFF a selected roofline item is a plain delete (no sibling side-effect)', () => {
    const prev = new Set(['roofline-santas', 'bush-1']);
    const next = nextSelectedItemIds(prev, 'roofline-santas', ROOFLINE_GROUP);
    expect(next).toEqual(new Set(['bush-1']));
  });

  it('non-roofline items toggle normally (add/remove) without touching the roofline group', () => {
    const prev = new Set(['roofline-santas']);
    const added = nextSelectedItemIds(prev, 'bush-1', ROOFLINE_GROUP);
    expect(added).toEqual(new Set(['roofline-santas', 'bush-1']));
    const removed = nextSelectedItemIds(added, 'bush-1', ROOFLINE_GROUP);
    expect(removed).toEqual(new Set(['roofline-santas']));
  });

  it('does not mutate the input Set (returns a new one)', () => {
    const prev = new Set(['roofline-santas']);
    const next = nextSelectedItemIds(prev, 'bush-1', ROOFLINE_GROUP);
    expect(next).not.toBe(prev);
    expect(prev).toEqual(new Set(['roofline-santas']));
  });

  it('an empty rooflineGroup (legacy quote) never triggers the XOR — plain toggle only', () => {
    const prev = new Set(['roofline-single']);
    const next = nextSelectedItemIds(prev, 'roofline-other', new Set());
    expect(next).toEqual(new Set(['roofline-single', 'roofline-other']));
  });

  // #125 — permanent portal tier selector: with only ONE package on offer
  // (e.g. a single-surface permanent quote), the last remaining item must
  // never be uncheckable down to a zero-package state.
  it('onlyOnePackage=true: unchecking the LAST remaining item is a no-op', () => {
    const prev = new Set(['permanent-front']);
    const next = nextSelectedItemIds(prev, 'permanent-front', new Set(), true);
    expect(next).toBe(prev);
    expect(next).toEqual(new Set(['permanent-front']));
  });

  it('onlyOnePackage=true: unchecking one of SEVERAL selected items still works normally', () => {
    const prev = new Set(['permanent-front', 'custom-0']);
    const next = nextSelectedItemIds(prev, 'custom-0', new Set(), true);
    expect(next).toEqual(new Set(['permanent-front']));
  });

  it('onlyOnePackage=true: adding an item is unaffected', () => {
    const prev = new Set(['permanent-front']);
    const next = nextSelectedItemIds(prev, 'custom-0', new Set(), true);
    expect(next).toEqual(new Set(['permanent-front', 'custom-0']));
  });

  it('onlyOnePackage=false (default/multi-package): unchecking the last item still empties the set', () => {
    const prev = new Set(['permanent-front']);
    const next = nextSelectedItemIds(prev, 'permanent-front', new Set());
    expect(next).toEqual(new Set());
  });
});

describe('nextPackageSelectedItemIds — selectPackage tier/custom logic', () => {
  it('picking tier A/B/C replaces the selection with exactly that bundle', () => {
    const pkgB = { id: 'B' as const, includedItemIds: ['roofline-santas', 'bush-1', 'wreath-1'] };
    const next = nextPackageSelectedItemIds(pkgB, new Set(['garland-1']));
    expect(next).toEqual(new Set(['roofline-santas', 'bush-1', 'wreath-1']));
  });

  it('picking D with a non-empty recommendation loads EXACTLY the recommended ids', () => {
    const recommended = { id: 'D' as const, includedItemIds: ['roofline-santas', 'wreath-1'] };
    const next = nextPackageSelectedItemIds(recommended, new Set(['bush-1']));
    expect(next).toEqual(new Set(['roofline-santas', 'wreath-1']));
  });

  it('picking the empty D ("Build Your Own", no recommendation) keeps the current selection', () => {
    const emptyD = { id: 'D' as const, includedItemIds: [] };
    const current = new Set(['bush-1', 'wreath-1']);
    const next = nextPackageSelectedItemIds(emptyD, current);
    expect(next).toEqual(current);
    expect(next).not.toBe(current); // still a fresh Set, not the same reference
  });

  it('does not mutate the current selection Set', () => {
    const pkgA = { id: 'A' as const, includedItemIds: ['roofline-santas'] };
    const current = new Set(['bush-1']);
    nextPackageSelectedItemIds(pkgA, current);
    expect(current).toEqual(new Set(['bush-1']));
  });
});

// Audit #110 W4-011 — pin the pricing math the approve POST body reads
// (currentTotal/currentDeposit come straight from priceSelection's output;
// selectedItemIds is exactly what toggleItem/selectPackage produce above).
// This composes the same pure functions SelectionContext's `breakdown`/
// `currentTotal`/`currentDeposit`/`meetsMinimum` memos call, so a regression
// in the pricing chain (wrong tax basis, deposit %, or minimum-gate basis)
// would fail here without needing to render the provider.
describe('approve-payload pricing pin (selectedItemIds -> currentTotal/currentDeposit)', () => {
  const PRICE_MAP = new Map<string, number>([
    ['roofline-santas', 500],
    ['bush-1', 300],
    ['wreath-1', 200],
  ]);
  const CHARGES: PortalCharges = {
    taxRate: 0.08,
    rush: { amount: 150, defaultOn: false },
    takedown: { amount: 100, defaultOn: false },
  };

  it('a known selection prices to the expected total/deposit with no fees', () => {
    const selectedItemIds = new Set(['roofline-santas', 'bush-1']); // 500 + 300 = 800
    const subtotal = sumSelectedItems(selectedItemIds, PRICE_MAP);
    expect(subtotal).toBe(800);

    const breakdown = priceSelection(subtotal, effectiveCharges(CHARGES, false, false, 0, 0));
    // taxable = 800, tax = 800 * 0.08 = 64, total = 864, deposit = 50% = 432
    expect(breakdown.taxable).toBe(800);
    expect(breakdown.tax).toBe(64);
    expect(breakdown.total).toBe(864);
    expect(breakdown.deposit).toBe(432);
  });

  it('rush + takedown fees are added to the taxable base before tax/deposit', () => {
    const selectedItemIds = new Set(['roofline-santas', 'wreath-1']); // 500 + 200 = 700
    const subtotal = sumSelectedItems(selectedItemIds, PRICE_MAP);
    const breakdown = priceSelection(subtotal, effectiveCharges(CHARGES, true, true, 0, 0));
    // taxable = 700 + 150 + 100 = 950, tax = 950*0.08 = 76, total = 1026, deposit = 513
    expect(breakdown.taxable).toBe(950);
    expect(breakdown.total).toBe(1026);
    expect(breakdown.deposit).toBe(513);
  });

  it('the $1,000 approval minimum counts fees, not just items (#47)', () => {
    // Item subtotal alone ($700) is under $1,000, but rush pushes the basis over.
    const selectedItemIds = new Set(['roofline-santas', 'wreath-1']);
    const subtotal = sumSelectedItems(selectedItemIds, PRICE_MAP);
    const withoutRush = priceSelection(subtotal, effectiveCharges(CHARGES, false, false, 0, 0));
    expect(orderMinimumStatus(withoutRush, 1000).meetsMinimum).toBe(false);

    const withRush = priceSelection(subtotal, effectiveCharges(CHARGES, true, false, 0, 0));
    // basis = 700 + 150 = 850 — still short of $1,000.
    expect(orderMinimumStatus(withRush, 1000).meetsMinimum).toBe(false);
    expect(orderMinimumStatus(withRush, 1000).amountToMinimum).toBe(150);
  });

  it('an empty selection prices to all-zero and never meets the minimum', () => {
    const subtotal = sumSelectedItems(new Set(), PRICE_MAP);
    const breakdown = priceSelection(subtotal, effectiveCharges(CHARGES, false, false, 0, 0));
    expect(breakdown.total).toBe(0);
    expect(breakdown.deposit).toBe(0);
    expect(orderMinimumStatus(breakdown, 1000).meetsMinimum).toBe(false);
  });
});

// Audit #110 W4-011 — the `locked` no-op wiring (toggleRush/toggleTakedown/
// selectPackage/toggleItem/setColorScheme/setCustomPattern/toggleInstallTiming
// all swap to a shared `() => {}` when locked=true) is a trivial ternary over
// React state setters built inline in SelectionProvider's `value` object — it
// has no pure-logic seam to extract without rendering the provider (this repo
// has no @testing-library/jsdom; house convention is pure-logic tests only,
// per the #110 conventions charter). Documenting as the infra-gap blocker
// rather than inventing component-test infra for one ternary.
//
// #155 UPDATE: the freeze DECISION now has a pure seam — frozenMutatorGroups
// (tested below) — because legacy rebook needed a partial freeze. Three groups
// (r2): items (toggleItem/selectPackage), fees (toggleRush/toggleTakedown/
// toggleInstallTiming — LIVE upsells on a legacy rebook), appearance (color/
// pattern/effect). The setter ternaries in the provider read frozen.items /
// frozen.fees / frozen.appearance from it; only the noop-swap wiring itself
// remains render-only.

describe('frozenMutatorGroups (#155 legacy rebook / #43 locked)', () => {
  it('legacyRebook=true (not locked): ONLY the items group (toggleItem/selectPackage) freezes — fees and appearance stay live', () => {
    expect(frozenMutatorGroups({ locked: false, legacyRebook: true })).toEqual({
      items: true,
      fees: false,
      appearance: false,
    });
  });

  it('legacyRebook=false, not locked: nothing freezes (a normal quote is unchanged)', () => {
    expect(frozenMutatorGroups({ locked: false, legacyRebook: false })).toEqual({
      items: false,
      fees: false,
      appearance: false,
    });
  });

  it('locked=true freezes ALL THREE groups (the #43 booked read-only rule, unchanged)', () => {
    expect(frozenMutatorGroups({ locked: true, legacyRebook: false })).toEqual({
      items: true,
      fees: true,
      appearance: true,
    });
  });

  it('locked + legacyRebook together: locked wins everywhere (fees and colors frozen too)', () => {
    expect(frozenMutatorGroups({ locked: true, legacyRebook: true })).toEqual({
      items: true,
      fees: true,
      appearance: true,
    });
  });
});
