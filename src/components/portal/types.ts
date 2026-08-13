// Shared types for the customer-facing quote approval portal.
// These are portal-local — deliberately not reusing `src/lib/pricing`
// types so the portal can be iterated on without affecting the pricing
// engine. When wiring real data later, write a thin adapter that maps
// the quote/pricing domain types INTO these.

import type { Scene } from '@/lib/design/sceneTypes';
import type { PermanentWarranty } from '@/lib/permanent/types';

export type PackageId = 'A' | 'B' | 'C' | 'D';

export type PortalPackage = {
  id: PackageId;
  name: string;
  tagline: string;
  total: number;        // dollars, tax-inclusive final price (rush/takedown + tax; no floor — minimum is a portal gate)
  deposit: number;      // dollars, this quote's deposit rate (default 50%) of total
  recommended?: boolean;
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
  | 'bistro'
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
export type PortalPendingAmendment = {
  amendedAt: string;
  reason: string;
  previousTotalUsd: number;
  newTotalUsd: number;
  deltaUsd: number;
  depositAppliedUsd: number;
  newBalanceUsd: number;
};

export type PortalApproval = {
  approvedAt: string;        // ISO timestamp
  depositPaidAt?: string | null; // #38 — set once the deposit webhook confirms; null = approved-but-unpaid
  packageId: PackageId;
  packageName: string;       // "Build Your Own", "Santa's Classic", etc.
  totalUsd: number;          // amount the customer saw at approval time
  depositUsd: number;        // amount paid up front
  // #177 — the FROZEN deposit rate (0-1) this customer approved with (staff
  // override or BUSINESS_RULES.depositPercentage). Post-approval surfaces read
  // this instead of the live inputs.depositPercent so a later staff edit can't
  // retro-change what the customer signed for. Optional/back-compat like the
  // other frozen-choice fields below — buildApproval always computes a real
  // number for a live row; a hand-built test/legacy fixture may omit it.
  depositRate?: number;
  selectedItemCount: number; // for a "X items included" line
  // The FROZEN line-item selection the customer approved (the exact ids), so a
  // booked portal can re-seed SelectionProvider from what they signed instead of
  // the recommendation/staff defaults (audit: approved-portal-snapshot). Empty
  // for older snapshots that predate the freeze.
  selectedItemIds: string[];
  installTiming: InstallTiming; // #40 — Sep/Oct early-install choice (or 'none')
  rushSelected: boolean;        // #4 — rush-install add-on chosen (frozen at approval)
  takedownSelected: boolean;    // #4 — premium (before-Jan-9) takedown chosen
  // #163 — the FROZEN light colour on the order (#10 approved choice, or a
  // staff-applied colour change). The booked portal opens its picker/render on
  // this. Optional/back-compat: older snapshots predate the colour freeze.
  colorSchemeId?: string;
  customPattern?: string[];
  // #88 P6b-2 — the permanent "Your Protection" warranty copy + version the
  // customer agreed to, frozen at approval. null for non-permanent quotes or
  // older snapshots; the portal then renders the LIVE settings copy instead.
  permanentWarranty?: PermanentWarranty | null;
  // Latest total-changing booked amendment that still needs the customer's
  // signature. Absent once accepted or when there is no amendment.
  pendingAmendment?: PortalPendingAmendment;
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
  // #177: the per-quote deposit rate (e.g. 0.5); undefined falls back to
  // BUSINESS_RULES.depositPercentage at the priceSelection call site.
  depositRate?: number;
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
  // #177: the per-quote deposit rate (e.g. 0.5), frozen on the pricing result.
  // Undefined for a legacy result priced before this field existed — consumers
  // fall back to BUSINESS_RULES.depositPercentage.
  depositRate?: number;
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
  deposit: number;   // this quote's deposit rate (default 50%) of total, due today
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
  // Permanent Lighting (#88 / S23): the four house-side rooflines — optional
  // (holiday/event designs lack them). Drawn on the portal like the holiday trace.
  front?: PortalSatelliteLine[];
  left?: PortalSatelliteLine[];
  right?: PortalSatelliteLine[];
  back?: PortalSatelliteLine[];
  // Permanent Bistro Lighting (#117): freeform bistro-run polylines traced on
  // the satellite view — optional (non-bistro designs lack it).
  bistro?: PortalSatelliteLine[];
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
  // `source: 'crew'` marks an INTERNAL field photo (the text-ops bot's install
  // capture) that portalPhotos() filters out — the homeowner must never see a
  // ladder shot in their own gallery. Absent = an operator's design photo, shown.
  extraPhotos?: {
    id: string;
    url: string | null;
    w: number;
    h: number;
    title: string | null;
    source?: 'crew' | null;
  }[];
};

export type PortalQuote = {
  id: string;
  // The stable customers.id this quote is linked to (ledger #83 Phase 5
  // identity), when the quote has one. Referral program (#41): the booked-page
  // referral section needs this to ensure/read the customer's referral code.
  // Undefined for a quote with no customer link (walk-in/test data) — the
  // referral section renders copy-only, no link, when absent.
  customerId?: string | null;
  customer: {
    firstName: string;
    fullName: string;
    address: string;
    // Ledger #87(a): the customer PDFs' RECIPIENT block shows a phone line.
    // Additive — no existing portal UI reads this, so populating it from
    // quotes.customer_phone (already selected by loadPortalQuote) is a
    // zero-risk addition. '' when the quote has no phone on file.
    phone: string;
  };
  // Bug fix (B3): the derived quote lifecycle status so the portal can gate the
  // approve+pay UI. When this is a terminal/branch state (declined/cancelled/
  // abandoned/changes_requested) the portal must show a read-only closed/under-
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
  // Legacy rebook (#155): true ⇒ this quote was migrated from last year's
  // Jobber data — the portal shows the Light Color band's rebook copy (no
  // "see it in daylight" toggle) and a read-only What's Included list.
  // Optional/default false, matching isTest above — every other quote is
  // unaffected.
  legacyRebook?: boolean;
  // View-only portal (#176): true ⇒ a staff-flagged browse-only quote — the
  // scene/colours/prices stay fully live, but the sticky bar shows a neutral
  // "just browsing" strip instead of approve/pay/decline/request-changes, and
  // the server hard-blocks those same actions. Optional/default false,
  // matching isTest/legacyRebook above — every other quote is unaffected.
  viewOnly?: boolean;
  // The quote's service line (#88 Permanent Lighting vertical). Additive/
  // optional — undefined for legacy rows (they behave as 'holiday' throughout).
  serviceType?: import('@/lib/serviceType').ServiceType;
  // Event Lighting (#96): the staff-entered install/event/takedown dates
  // (ISO yyyy-mm-dd), shown on the portal's "Your Event Schedule" block. Present
  // only for an event quote that set at least one date; undefined otherwise.
  eventSchedule?: { installDate?: string; eventDate?: string; takedownDate?: string };
  // Event Lighting (#96): a couple soft "add if you'd like" suggestions for
  // popular add-ons not already on the quote. Present only for an event quote
  // with suggestions; undefined otherwise.
  eventSuggestions?: Array<{ key: string; label: string; blurb: string }>;
  // #154 interim — Wisetack financing prequal CTA. Present ONLY when the
  // server-read flag is exactly on AND a prequal URL is configured (the loader
  // is the single seam that sets it); absent = the feature is off and the
  // portal renders byte-identical to before. `approvedBalanceUsd` is the
  // financed balance for an APPROVED quote (agreed total via resolveAgreedTotal
  // minus the snapshot deposit) or null pre-approval / when the snapshot has no
  // deposit — the pre-approval CTA computes its balance from the LIVE selection
  // instead. Eligibility (service type + the $500–$25,000 range) is checked at
  // each render site via isFinancingEligible.
  financing?: {
    prequalUrl: string;
    /** The agreed job total (amendment-aware) — null until approved. Gates the
     *  $1,500 YLL job floor on /approved alongside the balance range. */
    approvedTotalUsd: number | null;
    approvedBalanceUsd: number | null;
  };
};

export type PortalSelection = {
  packageId: PackageId;
  selectedItemIds: Set<string>; // tracks which line items are currently on
};
