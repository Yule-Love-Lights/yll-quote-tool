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
//   - Pricing for 'D' is sum-of-selected-items.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { PackageId, PortalPackage, PortalLineItem } from './types';
import { depositFor, sumSelectedItems } from './format';

type SelectionContextValue = {
  packageId: PackageId;
  selectedItemIds: Set<string>;
  /** dollars — current total considering package or custom selection */
  currentTotal: number;
  /** dollars — 50% of currentTotal, rounded to cents */
  currentDeposit: number;
  /** name of the active package ("Build Your Own" when custom) */
  activeName: string;
  selectPackage: (id: PackageId) => void;
  toggleItem: (itemId: string) => void;
  isItemSelected: (itemId: string) => boolean;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be inside <SelectionProvider>');
  return ctx;
}

export type SelectionProviderProps = {
  packages: PortalPackage[];
  lineItems: PortalLineItem[];
  initialPackageId?: PackageId;
  children: React.ReactNode;
};

export function SelectionProvider({
  packages,
  lineItems,
  initialPackageId = 'B',
  children,
}: SelectionProviderProps) {
  // Price lookup — stable for the life of the provider.
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    lineItems.forEach((li) => m.set(li.id, li.price));
    return m;
  }, [lineItems]);

  const packagesById = useMemo(() => {
    const m = new Map<PackageId, PortalPackage>();
    packages.forEach((p) => m.set(p.id, p));
    return m;
  }, [packages]);

  const [packageId, setPackageId] = useState<PackageId>(initialPackageId);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(() => {
    const initial = packages.find((p) => p.id === initialPackageId);
    return new Set(initial?.includedItemIds ?? []);
  });

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
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    // Any manual item toggle flips selection to Custom.
    setPackageId('D');
  }, []);

  const isItemSelected = useCallback(
    (itemId: string) => selectedItemIds.has(itemId),
    [selectedItemIds],
  );

  // Total: for A/B/C use the canned package total; for D sum items.
  const currentTotal = useMemo(() => {
    if (packageId === 'D') return sumSelectedItems(selectedItemIds, priceMap);
    return packagesById.get(packageId)?.total ?? 0;
  }, [packageId, packagesById, priceMap, selectedItemIds]);

  const currentDeposit = useMemo(() => depositFor(currentTotal), [currentTotal]);

  const activeName = useMemo(() => {
    if (packageId === 'D') return 'Build Your Own';
    return packagesById.get(packageId)?.name ?? '';
  }, [packageId, packagesById]);

  const value: SelectionContextValue = {
    packageId,
    selectedItemIds,
    currentTotal,
    currentDeposit,
    activeName,
    selectPackage,
    toggleItem,
    isItemSelected,
  };

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}
