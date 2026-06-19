'use client';

// Shared selection state for the portal. Lives at the page root via
// <SelectionProvider> so that PackageCards, WhatsIncluded, and the
// StickyBottomBar all read/write the same selection.
//
// Rules (see spec §4):
//   - Picking A/B/C sets that packageId and replaces selectedItemIds
//     with that package's includedItemIds.
//   - Toggling a single item while on A/B/C auto-converts to 'D'
//     (Custom), preserving the currently-selected items then adding/
//     removing the toggled one.
//   - Pricing ALWAYS derives from the selected items via priceSelection
//     (subtotal + rush/takedown + tax), so tiers and custom stay consistent.
//   - Approval is gated until the pre-tax total (item subtotal + rush +
//     premium-takedown) reaches the order minimum ($1,000, or 0 when waived);
//     see meetsMinimum / amountToMinimum (#47 — the fees count toward it).

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type {
  InstallTiming,
  PackageId,
  PortalCharges,
  PortalPackage,
  PortalLineItem,
  PortalRoofline,
  SelectionPrice,
} from './types';
import { sumSelectedItems } from './format';
import { priceSelection, effectiveCharges, orderMinimumStatus, installDiscountRate } from '@/lib/portal/derivePackages';
import { BUSINESS_RULES } from '@/lib/pricing/pricingEngine';
import { DEFAULT_COLOR_SCHEME_ID, resolveSchemeColorIds } from '@/lib/design/colorSchemes';

type SelectionContextValue = {
  packageId: PackageId;
  selectedItemIds: Set<string>;
  /** dollars — pre-tax sum of the selected line items (ties to What's Included) */
  currentSubtotal: number;
  /** dollars — tax-inclusive total the customer pays */
  currentTotal: number;
  /** dollars — 50% of currentTotal, due today */
  currentDeposit: number;
  /** full breakdown (subtotal · fees · tax · total · deposit) for tie-out display */
  breakdown: SelectionPrice;
  /** pre-tax subtotal required to approve ($1,000, or 0 when waived) */
  minimumOrderSubtotal: number;
  /** true once the selection is non-empty AND its pre-tax total (items + rush + takedown) is at/above the order minimum (#47) */
  meetsMinimum: boolean;
  /** dollars still needed to reach the minimum (0 once met) */
  amountToMinimum: number;
  /** whether the rush-install fee is currently selected (#4) */
  rushSelected: boolean;
  /** whether the premium-takedown fee is currently selected (#4) */
  takedownSelected: boolean;
  /** canonical rush fee amount ($) for the toggle label */
  rushAmount: number;
  /** canonical premium-takedown amount ($) for the toggle label */
  takedownAmount: number;
  toggleRush: () => void;
  toggleTakedown: () => void;
  /** the customer's early-install timing choice (#40); mutually exclusive with rush */
  installTiming: InstallTiming;
  /** select/deselect a Sep/Oct early-install discount (clicking the active one clears it); turns rush off */
  toggleInstallTiming: (choice: 'september' | 'october') => void;
  /** September early-install discount rate (e.g. 0.15) for the toggle label */
  septemberDiscountRate: number;
  /** October early-install discount rate (e.g. 0.10) for the toggle label */
  octoberDiscountRate: number;
  /** name of the active package ("Build Your Own" when custom) */
  activeName: string;
  selectPackage: (id: PackageId) => void;
  toggleItem: (itemId: string) => void;
  isItemSelected: (itemId: string) => boolean;
  /**
   * Design scene-item ids that should be HIDDEN in the live render (#27 D):
   * a scene item is hidden when every line item that controls it is deselected.
   * Unmapped scene items (no controlling line item) are never in this set, so
   * they always render. Empty for quotes with no linked design.
   */
  hiddenSceneItemIds: Set<string>;
  /**
   * Customer-facing light color/pattern selection (#10): the active scheme id,
   * a setter, and the resolved color-id override the live render applies (null =
   * "as designed", no recolor). Always starts at "as designed"; the customer
   * switches it on the portal and the choice is frozen into the approval snapshot.
   */
  colorSchemeId: string;
  setColorScheme: (id: string) => void;
  colorOverride: string[] | null;
  /** #43 — true once the quote is approved: the portal is READ-ONLY. Every
   *  selection setter below becomes a no-op, and consumers disable their
   *  controls so a booked customer can't change packages/items/fees/colors. */
  locked: boolean;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

// Pure initial-selection seed (extracted so it's unit-testable without rendering
// React). The recommended-only path (#12): when staff flagged items as
// recommended, the portal opens with EXACTLY those line items selected (custom
// 'D') instead of the initial package's bundle. When the list is absent/empty,
// behavior is unchanged — seed from the initial package's includedItemIds.
export function computeInitialSelection(
  packages: PortalPackage[],
  initialPackageId: PackageId,
  initialSelectedItemIds?: string[],
): { packageId: PackageId; selectedItemIds: string[] } {
  if (Array.isArray(initialSelectedItemIds) && initialSelectedItemIds.length > 0) {
    return { packageId: 'D', selectedItemIds: [...initialSelectedItemIds] };
  }
  const initial = packages.find((p) => p.id === initialPackageId);
  return { packageId: initialPackageId, selectedItemIds: initial?.includedItemIds ?? [] };
}

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be inside <SelectionProvider>');
  return ctx;
}

export type SelectionProviderProps = {
  packages: PortalPackage[];
  lineItems: PortalLineItem[];
  // The mutually-exclusive roofline group (#17 Phase 2): the line-item ids for
  // Santa's + Gingerbread. Selecting one deselects the other. Undefined for
  // legacy quotes (the single roofline is then a plain toggle).
  roofline?: PortalRoofline;
  // Per-job charges (rush/takedown/tax) used to price every selection
  // (tiers and custom) consistently.
  charges: PortalCharges;
  // Pre-tax subtotal the selection must reach to approve ($1,000, or 0
  // when waived because staff sent a sub-$1,000 quote).
  minimumOrderSubtotal: number;
  initialPackageId?: PackageId;
  // Recommended-only initial selection (#12). When present & NON-EMPTY, the
  // portal opens with EXACTLY these line items selected (Build Your Own / 'D')
  // instead of the initial package's bundle — staff-advised items pre-checked,
  // everything else an optional add-on. When absent/empty, behavior is
  // unchanged (the initialPackageId path seeds from the package). The portal
  // page should union in the roofline's recommended id so the customer never
  // lands without a roofline.
  initialSelectedItemIds?: string[];
  // #43 — when true the portal is read-only (the quote is already approved):
  // all selection setters no-op and consumers render their controls disabled.
  locked?: boolean;
  children: React.ReactNode;
};

export function SelectionProvider({
  packages,
  lineItems,
  roofline,
  charges,
  minimumOrderSubtotal,
  initialPackageId = 'B',
  initialSelectedItemIds,
  locked = false,
  children,
}: SelectionProviderProps) {
  // Price lookup — stable for the life of the provider.
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    lineItems.forEach((li) => m.set(li.id, li.price));
    return m;
  }, [lineItems]);

  // The either/or roofline group. Selecting one roofline option removes the
  // others, so the customer can only ever have one (never both). Empty for
  // legacy quotes.
  const rooflineGroup = useMemo(
    () => new Set(roofline?.itemIds ?? []),
    [roofline],
  );

  const packagesById = useMemo(() => {
    const m = new Map<PackageId, PortalPackage>();
    packages.forEach((p) => m.set(p.id, p));
    return m;
  }, [packages]);

  // Recommended-only seed (#12) vs the unchanged package-seeded default — see
  // computeInitialSelection. Computed once for the initial state.
  const initialSeed = useMemo(
    () => computeInitialSelection(packages, initialPackageId, initialSelectedItemIds),
    // Initial seed only — recomputing on prop change would clobber live edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [packageId, setPackageId] = useState<PackageId>(initialSeed.packageId);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    () => new Set(initialSeed.selectedItemIds),
  );

  // Rush + premium-takedown toggles (#4). Seeded from the staff quote's
  // defaults; the customer can flip either. NEVER changed by selectPackage —
  // only the staff default + these toggles control them.
  const [rushSelected, setRushSelected] = useState<boolean>(charges.rush.defaultOn);
  const [takedownSelected, setTakedownSelected] = useState<boolean>(charges.takedown.defaultOn);
  // Early-install timing discount (#40). Mutually exclusive with the rush
  // add-on: selecting a Sep/Oct discount clears rush, and turning rush on
  // clears the discount. Always starts at 'none' (standard install, no discount).
  const [installTiming, setInstallTiming] = useState<InstallTiming>('none');
  const toggleRush = useCallback(() => {
    // Turning rush ON clears any early-install discount (mutually exclusive #40).
    if (!rushSelected) setInstallTiming('none');
    setRushSelected((v) => !v);
  }, [rushSelected]);
  const toggleTakedown = useCallback(() => setTakedownSelected((v) => !v), []);
  const toggleInstallTiming = useCallback((choice: 'september' | 'october') => {
    setInstallTiming((cur) => (cur === choice ? 'none' : choice));
    setRushSelected(false); // early-install and rush are mutually exclusive (#40)
  }, []);

  // Light color/pattern (#10). Always starts at "as designed" (render the colors
  // the operator drew); the customer can switch on the portal and the live design
  // recolors. The resolved override array is stable per scheme (from the
  // COLOR_SCHEMES constant), so passing it to DesignCanvas only re-renders the
  // draw layer when it changes.
  const [colorSchemeId, setColorScheme] = useState<string>(DEFAULT_COLOR_SCHEME_ID);
  const colorOverride = useMemo(
    () => resolveSchemeColorIds(colorSchemeId),
    [colorSchemeId],
  );

  const selectPackage = useCallback(
    (id: PackageId) => {
      const pkg = packagesById.get(id);
      if (!pkg) return;
      setPackageId(id);
      if (id === 'D') {
        // Custom — keep whatever the user currently has selected.
        // No-op on selectedItemIds.
        return;
      }
      setSelectedItemIds(new Set(pkg.includedItemIds));
    },
    [packagesById],
  );

  const toggleItem = useCallback((itemId: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        // Roofline is mutually exclusive: picking Santa's OR Gingerbread
        // removes the other (you can never have both). Removing one is just a
        // normal toggle-off, so this only fires when ADDING.
        if (rooflineGroup.has(itemId)) {
          for (const sibling of rooflineGroup) next.delete(sibling);
        }
        next.add(itemId);
      }
      return next;
    });
    // Any manual item toggle flips selection to Custom.
    setPackageId('D');
  }, [rooflineGroup]);

  const isItemSelected = useCallback(
    (itemId: string) => selectedItemIds.has(itemId),
    [selectedItemIds],
  );

  // Which design scene items to hide in the live render (#27 D). A scene item is
  // controlled by the line item(s) whose sceneItemIds include it; it's hidden
  // only when NONE of its controllers is selected. Items no line item references
  // (text/custom/bow/untagged) never appear here → always visible.
  const hiddenSceneItemIds = useMemo(() => {
    const controllers = new Map<string, string[]>();
    lineItems.forEach((li) => {
      li.sceneItemIds?.forEach((sid) => {
        const arr = controllers.get(sid);
        if (arr) arr.push(li.id);
        else controllers.set(sid, [li.id]);
      });
    });
    const hidden = new Set<string>();
    controllers.forEach((controllingIds, sid) => {
      if (!controllingIds.some((id) => selectedItemIds.has(id))) hidden.add(sid);
    });
    return hidden;
  }, [lineItems, selectedItemIds]);

  // Price EVERY selection (tier or custom) from the actual selected items via
  // the shared priceSelection, so the displayed total always equals the sum of
  // what's checked — plus rush/takedown + tax — with no silent $1,000 floor
  // (#18). The minimum is surfaced as an approval gate below, not baked into
  // the price.
  const currentSubtotal = useMemo(
    () => sumSelectedItems(selectedItemIds, priceMap),
    [selectedItemIds, priceMap],
  );

  // Effective fees reflect the live toggle state; the breakdown re-prices
  // whenever the selection OR a fee toggle changes.
  const breakdown = useMemo(
    () => priceSelection(
      currentSubtotal,
      effectiveCharges(charges, rushSelected, takedownSelected, installDiscountRate(installTiming)),
    ),
    [currentSubtotal, charges, rushSelected, takedownSelected, installTiming],
  );

  // #47 — the $1,000 gate counts the rush + premium-takedown fees too, not just
  // the item subtotal. orderMinimumStatus measures the pre-tax taxable total
  // (items + fees) against the minimum, so a selection that only reaches $1,000
  // once a fee is toggled on still clears the gate.
  const { meetsMinimum, amountToMinimum } = orderMinimumStatus(breakdown, minimumOrderSubtotal);

  const activeName = useMemo(() => {
    if (packageId === 'D') return 'Build Your Own';
    return packagesById.get(packageId)?.name ?? '';
  }, [packageId, packagesById]);

  // #43 — when the quote is approved the portal is read-only: every selection
  // setter is swapped for this no-op so nothing can change, regardless of any
  // stray clickable control. (Belt-and-suspenders with the disabled controls.)
  const noop = useCallback(() => {}, []);

  const value: SelectionContextValue = {
    packageId,
    selectedItemIds,
    currentSubtotal,
    currentTotal: breakdown.total,
    currentDeposit: breakdown.deposit,
    breakdown,
    minimumOrderSubtotal,
    meetsMinimum,
    amountToMinimum,
    rushSelected,
    takedownSelected,
    rushAmount: charges.rush.amount,
    takedownAmount: charges.takedown.amount,
    toggleRush: locked ? noop : toggleRush,
    toggleTakedown: locked ? noop : toggleTakedown,
    installTiming,
    toggleInstallTiming: locked ? noop : toggleInstallTiming,
    septemberDiscountRate: BUSINESS_RULES.earlyInstallDiscounts.september,
    octoberDiscountRate: BUSINESS_RULES.earlyInstallDiscounts.october,
    activeName,
    selectPackage: locked ? noop : selectPackage,
    toggleItem: locked ? noop : toggleItem,
    isItemSelected,
    hiddenSceneItemIds,
    colorSchemeId,
    setColorScheme: locked ? noop : setColorScheme,
    colorOverride,
    locked,
  };

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}
