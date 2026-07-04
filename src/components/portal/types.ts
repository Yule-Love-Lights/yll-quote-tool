// Shared types for the customer-facing quote approval portal.
// These are portal-local — deliberately not reusing `src/lib/pricing`
// types so the portal can be iterated on without affecting the pricing
// engine. When wiring real data later, write a thin adapter that maps
// the quote/pricing domain types INTO these.

import type { Scene } from '@/lib/design/sceneTypes';

export type PackageId = 'A' | 'B' | 'C' | 'D';

export type PortalPackage = {
  id: PackageId;
  name: string;
  tagline: string;
  total: number;        // dollars, tax-inclusive final price (rush/takedown + tax; no floor — minimum is a portal gate)
  deposit: number;      // dollars, 50% of total
  recommended?: boolean;
  aLaCarteTotal?: number; // used to compute "you save $X" line (Package C only)
  includedItemIds: string[]; // which line items are bundled in this package
};

export type PortalLineItemKind =
  | 'roofline'
  | 'ridge'
  | 'tree'
  | 'bush'
  | 'wreath'
  | 'garland'
  | 'spritzer'
  | 'column'
  | 'bow'
  | 'railing'
  | 'curtain'
  | 'stake-lighting'
  | 'permanent'
  | 'permanent-addon';

export type PortalLineItem = {
  id: string;
  // #104: the engine's STABLE line id (`mini-<sceneItemId>`, `roofline-santas`,
  // `winter-wonderland`, …), carried from result.lineItems. Used to link scene
  // items by IDENTITY (not list position — closes the #90 same-count reorder/swap
  // mis-map) and to key a per-quote price override. `id` above stays position-based
  // for back-compat with the selection / package / approval-snapshot consumers.
  // Undefined for legacy saved results (pre-#104) + custom/manual rows.
  stableId?: string;
  kind: PortalLineItemKind;
  label: string;        // "Front-left tree"
  detail: string;       // "4 strands" or "180 ft"
  price: number;        // dollars for this item
  // The design scene item(s) this line item controls (#27 D). Present only for
  // design-linked quotes; toggling this line item off hides exactly these drawn
  // items in the live portal render. Undefined ⇒ no linked design item (legacy
  // quotes, custom line items, or an untagged item).
  sceneItemIds?: string[];
  // Staff flagged this item as "recommended" for this home (#12). When any line
  // item is recommended, the portal opens with ONLY the recommended ones
  // pre-selected and shows a "Recommended" label on each. NEVER set on roofline
  // option items (roofline keeps its own recommend mechanism — PortalRoofline).
  recommended?: boolean;
};

// The mutually-exclusive roofline group for the portal (#17 Phase 2). Present
// ONLY for quotes priced by the Phase-1 engine (QuoteResult.rooflineOptions)
// that have a billed roofline. Legacy rows leave this undefined and the single
// roofline stays an ordinary toggleable line item.
//
// Both Santa's (front) and Gingerbread (front + ridge + sides) appear as
// ordinary line items in "What's Included"; this just tells SelectionContext
// which line items form the either/or group so picking one deselects the
// other. `recommendedItemId` is the staff pick — the one selected by default
// (and the only one bundled into the A/B/C package tiers).
export type PortalRoofline = {
  itemIds: string[];          // the mutually-exclusive roofline line-item ids (1 or 2)
  recommendedItemId: string;  // the default-selected one (staff's rooflineChoice)
};

// Walkthrough video recorded by Naldo explaining this specific quote.
// Sits below the hero on every portal version to increase close rate.
// Two hosting modes so Naldo can use whichever is easiest today:
//   - 'youtube': src is the 11-char YouTube video ID (NOT full URL)
//   - 'mp4':     src is the full URL of a hosted .mp4 file (Supabase
//                Storage, Cloudflare R2, any public CDN)
export type PortalVideoKind = 'youtube' | 'mp4';

export type PortalVideo = {
  kind: PortalVideoKind;
  src: string;           // YT id OR full mp4 URL
  poster?: string;       // custom thumbnail — falls back to YT auto-thumb
  title?: string;        // "Your personal walkthrough"
  durationSec?: number;  // shown as "2:45" badge
  leaderName?: string;   // "Naldo" — shown in the eyebrow label
};

// Frozen at the moment the customer clicks Approve. Lets the post-
// approval confirmation page show "you booked Package C for $5,400,
// $2,700 paid" without re-deriving from the package list (which the
// admin might subsequently edit).
//
// Mirrors the ApprovalSnapshot shape written by /api/quotes/[id]/approve;
// translated into camelCase here for the frontend.
export type PortalApproval = {
  approvedAt: string;        // ISO timestamp
  depositPaidAt?: string | null; // #38 — set once the deposit webhook confirms; null = approved-but-unpaid
  packageId: PackageId;
  packageName: string;       // "Build Your Own", "Santa's Classic", etc.
  totalUsd: number;          // amount the customer saw at approval time
  depositUsd: number;        // amount paid up front
  selectedItemCount: number; // for a "X items included" line
  installTiming: InstallTiming; // #40 — Sep/Oct early-install choice (or 'none')
  takedownSelected: boolean;    // #4 — premium (before-Jan-9) takedown chosen
};

// The customer's early-install timing choice on the portal (#40). Picking
// September or October applies a percentage discount to the order subtotal and
// is mutually exclusive with the rush-install add-on. 'none' = the standard
// mid-Nov–early-Dec install with no discount.
export type InstallTiming = 'none' | 'september' | 'october';

// Effective per-job charges fed into priceSelection: the actual dollar
// amounts to add (0 when a fee is toggled off) plus the quote's tax rate.
export type SelectionCharges = {
  rushFee: number;   // dollars to add (0 when off)
  takedown: number;  // dollars to add (0 when off)
  taxRate: number;   // effective rate for this quote, e.g. 0.08625
  discountRate?: number; // promo/manual-% rate off the subtotal; 0/undefined when none
  discountFlat?: number; // flat $ off the subtotal (manual flat discount); 0/undefined when none
};

// Per-quote fee config for the portal. Rush + premium-takedown are
// customer-toggleable (#4): each carries the canonical amount charged when ON
// and the default on/off state staff set in the builder. SelectionContext
// turns the live toggle state + this config into the effective
// SelectionCharges it passes to priceSelection (package-card totals use the
// staff defaults). Populated by the adapter from the quote's pricing result.
export type PortalCharges = {
  taxRate: number;   // effective rate for this quote, e.g. 0.08625
  rush: { amount: number; defaultOn: boolean };
  takedown: { amount: number; defaultOn: boolean };
  // Staff "Apply discount" from the builder, flowed to the live portal price so
  // the customer sees + gets it. rate = fraction off the subtotal (percentage),
  // flat = dollars off (flat). Both 0 / absent = no manual discount. Mutually
  // exclusive with the early-install promo (one discount per quote).
  manualDiscount?: { rate: number; flat: number };
};

// Full price breakdown for a selection, so the portal can show a
// tie-out (Subtotal + fees + tax = Total) instead of a mystery number.
// Produced by priceSelection(subtotal, charges). No $1,000 floor — the
// minimum is enforced as an approval gate (see minimumOrderSubtotal).
export type SelectionPrice = {
  subtotal: number;  // pre-tax sum of the selected line items
  discount: number;  // total discount off the subtotal (early-install OR manual); 0 when none
  rushFee: number;   // dollars (0 when not on this quote)
  takedown: number;  // dollars (0 when not on this quote)
  taxable: number;   // subtotal − discount + rushFee + takedown
  tax: number;       // dollars
  total: number;     // tax-inclusive total the customer pays
  deposit: number;   // 50% of total, due today
};

// A saved on-photo light design linked to this quote (design-tool integration
// #27 Phase 2). When present, the portal hero renders it live (read-only)
// instead of the static render image. `scene` is the design tool's Scene;
// `photoUrl` is a signed, time-limited URL to the design's base photo.
// One traced roofline polyline in satellite-image space — points are
// normalized 0–1 (fractions of the satellite image's width/height). Mirrors the
// geometry of lib/designs' DesignSatelliteLines (portal-local by design; we only
// need the shape to draw, not the footage).
export type PortalSatelliteLine = { points: [number, number][]; label: string };
export type PortalSatelliteLines = {
  santas: PortalSatelliteLine[];       // front roofline (red)
  gingerbread: PortalSatelliteLine[];  // ridge & sides (blue)
  c9: PortalSatelliteLine[];           // C9 roofline (green)
  stake?: PortalSatelliteLine[];       // stake lighting (purple) — optional (older designs lack it)
};

export type PortalDesign = {
  scene: Scene;
  photoUrl: string | null;
  photoW: number | null;
  photoH: number | null;
  // Top-down satellite roof view (#51): the signed satellite image + its dims +
  // the roofline polylines, so the portal can show the customer exactly where
  // the roof lights go. Optional — quotes without a satellite (manual upload /
  // pre-migration / never-Calculated) omit these and the section hides.
  satelliteUrl?: string | null;
  satelliteW?: number | null;
  satelliteH?: number | null;
  satelliteLines?: PortalSatelliteLines | null;
  // Extra street photos (#13 multi-image): more angles of the same house, each
  // with its own drawn items (scene items reference them via photoId). Absent/
  // empty = single-photo design → every multi-photo surface hides.
  extraPhotos?: { id: string; url: string | null; w: number; h: number; title: string | null }[];
};

export type PortalQuote = {
  id: string;
  customer: {
    firstName: string;
    fullName: string;
    address: string;
  };
  // Bug fix (B3): the derived quote lifecycle status so the portal can gate the
  // approve+pay UI. When this is a terminal/branch state (declined/cancelled/
  // lost/changes_requested) the portal must show a read-only closed/under-
  // revision state instead of the approve+pay controls.
  quoteStatus?: string;
  // The reason the customer declined (or null/absent for non-declines). Shown
  // on the portal's closed-state screen to acknowledge the customer's feedback.
  declineReason?: string | null;
  photo: {
    before: string;     // URL of daytime photo
    after: string;      // URL of a lit "after" image ('' since #36 — the
                        // hero renders the live design instead)
    alt: string;
  };
  video?: PortalVideo;  // optional — section hides entirely when absent
  packages: PortalPackage[];
  lineItems: PortalLineItem[];
  // The mutually-exclusive roofline choice (#17 Phase 2). Present only for
  // quotes priced by the Phase-1 engine; undefined for legacy rows (their
  // roofline stays a normal toggleable line item). See PortalRoofline.
  roofline?: PortalRoofline;
  // Per-job charges (rush/takedown/tax) so the custom "Build Your Own"
  // total is priced identically to the A/B/C tiers. See PortalCharges.
  charges: PortalCharges;
  // Pre-tax subtotal the customer's selection must reach to approve
  // ($1,000), or 0 when waived (staff sent a sub-$1,000 quote). See
  // minimumOrderSubtotal() in lib/portal/derivePackages.
  minimumOrderSubtotal: number;
  // Staff-set early-install promo (#40): seeds the customer's portal timing so
  // they see the Sep/Oct discount pre-applied. 'none'/undefined = no promo set.
  installTiming?: InstallTiming;
  weeklyBookings: number;    // real scarcity — pulled from DB in production
  seasonCapacity: {
    installedThisWeek: number;
    bookedThroughDate: string; // human-readable: "early November"
  };
  // Set ONLY after the customer clicks Approve. Undefined while the
  // quote is still awaiting customer action — the approved page uses
  // its absence as the signal to 404 (prevents anyone from previewing
  // the celebration page before approval).
  approval?: PortalApproval;
  // Linked on-photo light design (#27 Phase 2). When present, the hero renders
  // it live instead of the static render image. Undefined for quotes with no
  // design (they keep the current static-image behavior).
  design?: PortalDesign;
  // Test Quote (ledger #93): true ⇒ the deposit button simulates payment
  // (→ /simulate-deposit) instead of a real Valor charge. Default false.
  isTest?: boolean;
  // The quote's service line (#88 Permanent Lighting vertical). Additive/
  // optional — undefined for legacy rows (they behave as 'holiday' throughout).
  serviceType?: import('@/lib/serviceType').ServiceType;
  // Event Lighting (#96): the staff-entered install/event/takedown dates
  // (ISO yyyy-mm-dd), shown on the portal's "Your Event Schedule" block. Present
  // only for an event quote that set at least one date; undefined otherwise.
  eventSchedule?: { installDate?: string; eventDate?: string; takedownDate?: string };
};

export type PortalSelection = {
  packageId: PackageId;
  selectedItemIds: Set<string>; // tracks which line items are currently on
};
