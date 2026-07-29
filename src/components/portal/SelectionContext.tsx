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
import {
  DEFAULT_COLOR_SCHEME_ID,
  resolveSchemeColorIds,
  CUSTOM_SCHEME_ID,
  sanitizeCustomPattern,
  isKnownColorSchemeId,
  DEFAULT_COLOR_SCHEMES,
  DEFAULT_BUILDABLE_COLOR_IDS,
  type ColorScheme,
} from '@/lib/design/colorSchemes';
import { DEFAULT_PERMANENT_EFFECT, type SceneEffect } from '@/lib/design/permanentScenes';
import type { ServiceType } from '@/lib/serviceType';

type SelectionContextValue = {
  packageId: PackageId;
  selectedItemIds: Set<string>;
  /** dollars — pre-tax sum of the selected line items (ties to What's Included) */
  currentSubtotal: number;
  /** dollars — tax-inclusive total the customer pays */
  currentTotal: number;
  /** dollars — this quote's deposit rate (see depositRate) of currentTotal, due today */
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
  /** #177 — this quote's deposit rate (0-1, e.g. 0.5) for copy that states the
   *  percent (falls back to BUSINESS_RULES.depositPercentage when unset) */
  depositRate: number;
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
  /** true when the global "hide early-install discounts" setting is on AND the
   *  quote isn't approved — the Sep/Oct section is hidden + no early-install
   *  discount applies (approved quotes keep their agreed price). */
  earlyInstallHidden: boolean;
  /** Staff "Apply discount" (#40): when set, the early-install picker is hidden
   *  and this fixed %/flat discount applies instead. null when none. */
  manualDiscount: { rate: number; flat: number } | null;
  /** convenience: true when a staff manual discount is in effect (picker hidden) */
  hasManualDiscount: boolean;
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
  /**
   * The operator-configured swatch presets + build-your-own palette (#101),
   * data-driven from app_settings and passed down by the portal page. The picker
   * renders these instead of the built-in constants; colorOverride resolves
   * against `schemes`. Default to the built-ins when no props are provided.
   */
  schemes: ColorScheme[];
  buildableColorIds: string[];
  /**
   * Build-your-own custom pattern (#49): the customer's ordered list of palette
   * color ids. Active when colorSchemeId === 'custom' — it then drives
   * colorOverride (the live recolor) instead of a preset.
   */
  customPattern: string[];
  setCustomPattern: (ids: string[]) => void;
  /**
   * #88 P6b-4 — permanent-only ANIMATION effect (Solid / Chase / Fade), chosen
   * SEPARATELY from the color so any color can play any effect. Drives the hero's
   * live animation and freezes into the approval snapshot. Unused for holiday/event
   * (no effect picker renders there).
   */
  permanentEffect: SceneEffect;
  setPermanentEffect: (e: SceneEffect) => void;
  /** #43 — true once the quote is approved: the portal is READ-ONLY. Every
   *  selection setter below becomes a no-op, and consumers disable their
   *  controls so a booked customer can't change packages/items/fees/colors. */
  locked: boolean;
  /** #163 — whether the COLOUR/pattern picker specifically is frozen. Usually
   *  equals `locked`, but a BOOKED quote (colorPreviewWhenLocked) leaves it false
   *  so the picker stays interactive for a live preview while packages/items/fees
   *  remain locked. `locked && !colorLocked` ⇒ the "booked colour preview" mode
   *  where the picker shows a "Request colour change" button instead of persisting. */
  colorLocked: boolean;
  /** #155 — true when this quote was migrated from last year's Jobber data
   *  (a legacy rebook). Drives the Light Color band's rebook copy (no "see it
   *  in daylight" toggle) and the read-only What's Included list — the color
   *  swatches themselves stay interactive. Default false. */
  legacyRebook: boolean;
  /** #61 — daytime⇄lit-design view toggle, lifted out of the hero so the Light
   *  Color section can drive the hero's day/night view. `daylightAvailable` is
   *  false when there's no base photo to switch to. NOT affected by `locked` —
   *  it's a view toggle, not a selection change. */
  showDaylight: boolean;
  toggleDaylight: () => void;
  daylightAvailable: boolean;
  /** PostHog v1 — the quote id, threaded through for consumers that fire
   *  portal analytics events (package_selected, package_viewed) without
   *  needing their own quoteId prop. Undefined for the mock/dev fallback. */
  quoteId?: string;
  /** PostHog Wave 2 — the quote's service line, threaded through the same way
   *  as quoteId so light-color/effect/video consumers can stamp service_type
   *  onto their events without their own prop. Wave 4 reuses it so
   *  SectionViewTracker can fire section_viewed via useSelection() too.
   *  Undefined for the mock/dev fallback. */
  serviceType?: ServiceType;
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

// Pure reducer for toggleItem (extracted for test coverage — audit W4-011).
// Mirrors the Set logic inside SelectionProvider's toggleItem exactly: toggling
// OFF an already-selected item is a plain delete; toggling ON a roofline-group
// item first removes every sibling in the group so Santa's and Gingerbread can
// never both be selected (the single most money-sensitive selection rule — a
// double roofline would double-count in the subtotal/approve total).
//
// `onlyOnePackage` (#125 permanent tier-selector fix): when the portal only
// offers ONE package (e.g. a single-surface permanent quote — just "Front of
// Home"), there is no other tier to fall back to, so unchecking the last
// remaining item would leave the customer at a zero-package/zero-total state
// with nothing to re-select from. Deselecting the last item is a no-op in
// that case; with 2+ packages available the normal toggle-to-empty behavior
// is unchanged.
export function nextSelectedItemIds(
  prev: Set<string>,
  itemId: string,
  rooflineGroup: Set<string>,
  onlyOnePackage = false,
): Set<string> {
  const next = new Set(prev);
  if (next.has(itemId)) {
    if (onlyOnePackage && next.size === 1) return prev;
    next.delete(itemId);
  } else {
    if (rooflineGroup.has(itemId)) {
      for (const sibling of rooflineGroup) next.delete(sibling);
    }
    next.add(itemId);
  }
  return next;
}

// Pure reducer for selectPackage (extracted for test coverage — audit W4-011).
// Mirrors SelectionProvider's selectPackage exactly: picking A/B/C replaces the
// selection with that tier's bundle; picking D ("Our Recommendation") loads the
// staff-recommended set when non-empty, otherwise keeps whatever's currently
// selected (the empty "Build Your Own" card is a no-op on the item set).
export function nextPackageSelectedItemIds(
  pkg: Pick<PortalPackage, 'id' | 'includedItemIds'>,
  currentSelectedItemIds: Set<string>,
): Set<string> {
  if (pkg.id === 'D') {
    return pkg.includedItemIds.length > 0
      ? new Set(pkg.includedItemIds)
      : new Set(currentSelectedItemIds);
  }
  return new Set(pkg.includedItemIds);
}

// Pure — which mutator groups no-op for a given portal state (extracted for
// test coverage, the computeInitialSelection/nextSelectedItemIds pattern).
// Three groups:
//   items      — toggleItem / selectPackage: everything that changes the
//                included item set or the active package.
//   fees       — toggleRush / toggleTakedown / toggleInstallTiming: the
//                per-job add-on and early-install offers.
//   appearance — setColorScheme / setCustomPattern / setPermanentEffect: the
//                customer's light color/pattern/effect choice (view-side only,
//                frozen into the approval snapshot at approve time).
// #43 locked (booked/approved) freezes ALL THREE groups — the whole portal is
// read-only (byte-equivalent to the pre-#155 all-noop behavior).
//
// items also freezes below an item COUNT of 2, for two reasons that both land
// on the same test (#179/#180 — real incidents on YLL Neighbor quotes with a
// staff-added comparison line):
//   #179 — a legacy rebook keeps last year's item list fixed ONLY while it's a
//          single bundled line; at 2+ items it becomes toggleable exactly like
//          a normal quote (rush/takedown/early-install/color already stayed
//          live regardless — unaffected by this).
//   #180 — ANY quote (legacy or not) whose portal shows exactly one line item
//          can never toggle it off — an empty selection is a dead end, and
//          combined with a waived $1,000 minimum it could otherwise reach an
//          "approvable" $0 selection. 2+-item quotes keep today's rules.
// Both collapse to the same `itemCount < 2` test, so legacyRebook no longer
// changes the outcome once itemCount is known — it stays a parameter here for
// the call sites' clarity and so the matrix below documents both rules
// independently (a normal 1-item quote freezes for #180's reason even though
// legacyRebook is false).
export function frozenMutatorGroups(state: {
  locked: boolean;
  legacyRebook: boolean;
  // #179/#180 — total line items the portal shows (WhatsIncluded's `items`
  // prop / SelectionProvider's `lineItems` — the same array both read).
  itemCount: number;
  // #163: a booked customer may still recolor the LIVE preview (appearance
  // unfrozen) while items/fees stay locked. The change is never persisted to the
  // frozen order — a separate "Request colour change" action notifies staff, who
  // apply it deliberately. Off by default, so every existing caller is
  // byte-identical (items/fees are unaffected by this flag either way).
  colorPreviewWhenLocked?: boolean;
}): { items: boolean; fees: boolean; appearance: boolean } {
  return {
    items: state.locked || state.itemCount < 2,
    fees: state.locked,
    appearance: state.locked && state.colorPreviewWhenLocked !== true,
  };
}

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be inside <SelectionProvider>');
  return ctx;
}

// Null-safe read for components that can mount OUTSIDE the portal (referral
// page bug batch 2026-07-17: the refer page reuses Gallery, whose
// SectionViewTracker sat on useSelection and crashed the whole /refer SSR
// with "useSelection must be inside <SelectionProvider>"). Portal mounts get
// the real context; provider-less mounts get null and degrade gracefully.
export function useSelectionOptional(): SelectionContextValue | null {
  return useContext(SelectionContext);
}

// #163 — resolve the colour state the portal should OPEN on. Pure so the seed
// logic is unit-testable: a frozen scheme that still exists opens the picker on
// it (custom only with a valid sanitized pattern); anything else — no frozen
// colour, a scheme since deleted in Settings, or a custom pick whose colours
// are no longer buildable — falls back to the "as designed" default (S9).
export function resolveInitialColorState(
  initialColorSchemeId: string | undefined,
  initialCustomPattern: string[] | undefined,
  schemes: ColorScheme[],
  buildableColorIds: string[],
): { schemeId: string; pattern: string[] } {
  if (!initialColorSchemeId || !isKnownColorSchemeId(initialColorSchemeId, schemes)) {
    return { schemeId: DEFAULT_COLOR_SCHEME_ID, pattern: [] };
  }
  if (initialColorSchemeId === CUSTOM_SCHEME_ID) {
    const clean = sanitizeCustomPattern(initialCustomPattern ?? [], buildableColorIds);
    return clean.length > 0
      ? { schemeId: CUSTOM_SCHEME_ID, pattern: clean }
      : { schemeId: DEFAULT_COLOR_SCHEME_ID, pattern: [] };
  }
  return { schemeId: initialColorSchemeId, pattern: [] };
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
  // portal opens with EXACTLY these line items selected (custom 'D') instead of
  // the initial package's bundle — staff-advised items pre-checked, everything
  // else an optional add-on. When absent/empty, behavior is unchanged (the
  // initialPackageId path seeds from the package). This set is the "Our
  // Recommendation" package's includedItemIds, built upstream by
  // applyOurRecommendation (which already unions in the recommended roofline).
  initialSelectedItemIds?: string[];
  // #43 — when true the portal is read-only (the quote is already approved):
  // all selection setters no-op and consumers render their controls disabled.
  locked?: boolean;
  // #163 — when true (a booked quote), the light-color/pattern picker stays
  // interactive for a LIVE preview even though the order is locked; the change
  // never persists (a separate "Request colour change" action notifies staff).
  // Only unfreezes the appearance group — items/fees stay locked. Default false.
  colorPreviewWhenLocked?: boolean;
  // #163 — the FROZEN light colour on the order (approval_snapshot.
  // customerSelection: the colour approved with, or a staff-applied colour
  // change). When present + still a known scheme, the picker AND the live
  // render OPEN on it, so a booked customer reopening the portal sees the
  // colour they actually ordered. Absent (pre-approval, or older snapshots)
  // keeps the S9 default: open on "as designed".
  initialColorSchemeId?: string;
  initialCustomPattern?: string[];
  // #155 — true for a quote migrated from last year's Jobber data (a legacy
  // rebook). Passed straight through onto the context value (see
  // SelectionContextValue.legacyRebook) so LightColorPicker/WhatsIncluded can
  // read it via useSelection() without their own prop. Default false.
  legacyRebook?: boolean;
  // #61 — whether the linked design has a base photo to toggle to (daytime view).
  daylightAvailable?: boolean;
  // Staff-set early-install promo (#40): the customer's timing starts here so the
  // Sep/Oct discount shows pre-applied (they can still change it). Default 'none'.
  initialInstallTiming?: InstallTiming;
  // Global Settings → Customer Portal "hide early-install discounts". When on
  // (and the quote isn't approved), the Sep/Oct picker is hidden + the discount
  // is forced off.
  earlyInstallDiscountsHidden?: boolean;
  // Operator-configured light-color swatches + build-your-own palette (#101),
  // from app_settings. Default to the built-ins for callers that don't pass them.
  schemes?: ColorScheme[];
  buildableColorIds?: string[];
  // PostHog v1 — passed straight through onto the context value (see
  // SelectionContextValue.quoteId) so package_selected/package_viewed can
  // read it via useSelection() instead of their own prop.
  quoteId?: string;
  // PostHog Wave 2 — same passthrough as quoteId (see
  // SelectionContextValue.serviceType); Wave 4 reuses it for section_viewed.
  serviceType?: ServiceType;
  children: React.ReactNode;
};

export function SelectionProvider({
  packages,
  lineItems,
  roofline,
  charges,
  minimumOrderSubtotal,
  initialPackageId = 'A',
  initialSelectedItemIds,
  locked = false,
  colorPreviewWhenLocked = false,
  initialColorSchemeId,
  initialCustomPattern,
  legacyRebook = false,
  daylightAvailable = false,
  initialInstallTiming = 'none',
  earlyInstallDiscountsHidden = false,
  schemes = DEFAULT_COLOR_SCHEMES,
  buildableColorIds = DEFAULT_BUILDABLE_COLOR_IDS,
  quoteId,
  serviceType,
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
  // Global "hide early-install discounts" (Settings → Customer Portal). Only
  // affects a NOT-yet-approved quote — an approved quote keeps the price it
  // agreed to. When on, the Sep/Oct picker is hidden + the discount is forced off.
  const earlyInstallHidden = earlyInstallDiscountsHidden && !locked;
  // Early-install timing discount (#40). Mutually exclusive with the rush
  // add-on: selecting a Sep/Oct discount clears rush, and turning rush on
  // clears the discount. Forced to 'none' when early-install is hidden.
  const [installTiming, setInstallTiming] = useState<InstallTiming>(
    earlyInstallHidden ? 'none' : initialInstallTiming,
  );
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

  // Light color/pattern (#10). Pre-approval this starts at "as designed"
  // (render the colors the operator drew; S9 confirmed default). #163: once an
  // order carries a FROZEN colour (approved with one, or staff applied a
  // colour-change request), the portal opens ON that colour instead — the
  // customer should see what they actually ordered. The customer can still
  // switch for a live preview either way.
  const initialColor = useMemo(
    () =>
      resolveInitialColorState(initialColorSchemeId, initialCustomPattern, schemes, buildableColorIds),
    // Initial seed only — recomputing on prop change would clobber live edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [colorSchemeId, setColorScheme] = useState<string>(initialColor.schemeId);
  // #88 P6b-4 — the permanent animation effect, chosen separately from the color.
  // Opens on Chase (a booked portal re-opens on the default, same as colorSchemeId —
  // the frozen effect lives in the approval snapshot, not re-displayed here).
  const [permanentEffect, setPermanentEffect] = useState<SceneEffect>(DEFAULT_PERMANENT_EFFECT);
  const [customPattern, setCustomPattern] = useState<string[]>(initialColor.pattern);
  // Custom pattern (#49) drives the override when its scheme is active; otherwise
  // resolve the preset. Sanitize the custom list so an invalid/empty pattern can
  // never reach the renderer (empty → null = "as designed", no recolor).
  const colorOverride = useMemo(() => {
    if (colorSchemeId === CUSTOM_SCHEME_ID) {
      const clean = sanitizeCustomPattern(customPattern, buildableColorIds);
      return clean.length > 0 ? clean : null;
    }
    return resolveSchemeColorIds(colorSchemeId, schemes);
  }, [colorSchemeId, customPattern, schemes, buildableColorIds]);

  // #61 — daytime⇄lit-design view toggle, lifted from the hero so the Light Color
  // section can flip the hero's day/night view. View-only (never gated by locked).
  const [showDaylight, setShowDaylight] = useState(false);
  const toggleDaylight = useCallback(() => setShowDaylight((v) => !v), []);

  const selectPackage = useCallback(
    (id: PackageId) => {
      const pkg = packagesById.get(id);
      if (!pkg) return;
      setPackageId(id);
      setSelectedItemIds((prev) => nextPackageSelectedItemIds(pkg, prev));
    },
    [packagesById],
  );

  // #125 — with only one package on offer, there's no other tier to land on,
  // so the last remaining item can never be unchecked down to zero.
  const onlyOnePackage = packages.length === 1;

  const toggleItem = useCallback((itemId: string) => {
    // Single-package quote: unchecking the last remaining item would strand the
    // customer at a zero-package/$0 selection with no tier to fall back to. Make
    // it a FULL no-op — no selection change AND no flip to Custom — so the tier
    // label/highlight stays put on the dead click.
    if (onlyOnePackage && selectedItemIds.size === 1 && selectedItemIds.has(itemId)) return;
    setSelectedItemIds((prev) => nextSelectedItemIds(prev, itemId, rooflineGroup, onlyOnePackage));
    // Any manual item toggle flips selection to Custom.
    setPackageId('D');
  }, [rooflineGroup, onlyOnePackage, selectedItemIds]);

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

  // One discount per quote: a staff manual discount (fixed %/flat) OR the
  // customer's early-install pick (#40). When a manual discount is set, the
  // early-install picker is hidden so installTiming stays 'none' — but guard here
  // too so the two can never stack.
  const manualDiscount = charges.manualDiscount ?? null;
  const hasManualDiscount =
    !!manualDiscount && (manualDiscount.rate > 0 || manualDiscount.flat > 0);

  // Effective fees reflect the live toggle state; the breakdown re-prices
  // whenever the selection OR a fee toggle changes.
  const breakdown = useMemo(
    () => {
      const rate = hasManualDiscount ? manualDiscount!.rate : installDiscountRate(installTiming);
      const flat = hasManualDiscount ? manualDiscount!.flat : 0;
      return priceSelection(
        currentSubtotal,
        effectiveCharges(charges, rushSelected, takedownSelected, rate, flat),
      );
    },
    [currentSubtotal, charges, rushSelected, takedownSelected, installTiming, hasManualDiscount, manualDiscount],
  );

  // #47 — the $1,000 gate counts the rush + premium-takedown fees too, not just
  // the item subtotal. orderMinimumStatus measures the pre-tax taxable total
  // (items + fees) against the minimum, so a selection that only reaches $1,000
  // once a fee is toggled on still clears the gate.
  const { meetsMinimum, amountToMinimum } = orderMinimumStatus(breakdown, minimumOrderSubtotal);

  // The active package's display name. For the custom slot (D): show the
  // recommendation name only while the selection still matches it; once the
  // customer diverges (or there was no recommendation) it reads "Build Your Own".
  const activeName = useMemo(() => {
    const pkg = packagesById.get(packageId);
    if (packageId === 'D') {
      const recIds = pkg?.includedItemIds ?? [];
      const matchesRec =
        recIds.length > 0 &&
        recIds.length === selectedItemIds.size &&
        recIds.every((id) => selectedItemIds.has(id));
      return matchesRec ? pkg?.name ?? 'Our Recommendation' : 'Build Your Own';
    }
    return pkg?.name ?? '';
  }, [packageId, packagesById, selectedItemIds]);

  // #43 — when the quote is approved the portal is read-only: every selection
  // setter is swapped for this no-op so nothing can change, regardless of any
  // stray clickable control. (Belt-and-suspenders with the disabled controls.)
  const noop = useCallback(() => {}, []);

  // #155/#179/#180 — which setter groups no-op for this quote (pure,
  // unit-tested seam). locked freezes all three groups (unchanged #43
  // behavior); the item/package setters additionally freeze below 2 line
  // items (a legacy rebook at exactly 1 item, or ANY quote at exactly 1 item)
  // — fees and colors stay interactive either way.
  const frozen = frozenMutatorGroups({ locked, legacyRebook, itemCount: lineItems.length, colorPreviewWhenLocked });

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
    depositRate: charges.depositRate ?? BUSINESS_RULES.depositPercentage,
    // Fee toggles are deliberately NOT gated on legacyRebook — rush/takedown/
    // early-install are live upsells on a legacy rebook (#155 r2).
    toggleRush: frozen.fees ? noop : toggleRush,
    toggleTakedown: frozen.fees ? noop : toggleTakedown,
    installTiming,
    toggleInstallTiming: frozen.fees || earlyInstallHidden ? noop : toggleInstallTiming,
    septemberDiscountRate: BUSINESS_RULES.earlyInstallDiscounts.september,
    octoberDiscountRate: BUSINESS_RULES.earlyInstallDiscounts.october,
    earlyInstallHidden,
    manualDiscount,
    hasManualDiscount,
    activeName,
    selectPackage: frozen.items ? noop : selectPackage,
    toggleItem: frozen.items ? noop : toggleItem,
    isItemSelected,
    hiddenSceneItemIds,
    colorSchemeId,
    // Appearance setters are deliberately NOT gated on legacyRebook — a legacy
    // rebook customer still picks their light color/pattern/effect (#155).
    setColorScheme: frozen.appearance ? noop : setColorScheme,
    colorOverride,
    schemes,
    buildableColorIds,
    customPattern,
    setCustomPattern: frozen.appearance ? noop : setCustomPattern,
    permanentEffect,
    setPermanentEffect: frozen.appearance ? noop : setPermanentEffect,
    locked,
    // #163 — whether the COLOUR/pattern picker is frozen. Normally equals
    // `locked`, but a booked quote with colorPreviewWhenLocked leaves it false so
    // the picker stays interactive for a live preview (the change never persists).
    colorLocked: frozen.appearance,
    legacyRebook,
    showDaylight,
    toggleDaylight,
    daylightAvailable,
    quoteId,
    serviceType,
  };

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}
