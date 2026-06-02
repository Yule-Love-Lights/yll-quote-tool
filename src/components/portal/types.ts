// Shared types for the customer-facing quote approval portal.
// These are portal-local — deliberately not reusing `src/lib/pricing`
// types so the portal can be iterated on without affecting the pricing
// engine. When wiring real data later, write a thin adapter that maps
// the quote/pricing domain types INTO these.

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
  | 'column';

export type PortalLineItem = {
  id: string;
  kind: PortalLineItemKind;
  label: string;        // "Front-left tree"
  detail: string;       // "4 strands" or "180 ft"
  price: number;        // dollars for this item
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

// Per-package variant images shown on each portal package card. Keyed by
// the same identifiers the render engine uses (RenderVariant). Each value
// is a signed URL or undefined (when that variant hasn't been generated
// or approved). Cards null-check and fall back to the 'full' photo.
//
// Why `string` keys here instead of importing RenderVariant: the portal
// types deliberately don't import from the render engine — keeps the
// portal frontend swappable without coupling. The adapter populates this
// map and the cards consume it.
export type PortalVariantPhotos = {
  santas?: string;
  ridge?: string;
  minis?: string;
  wreaths?: string;
  spritzers?: string;
  garland?: string;
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
  packageId: PackageId;
  packageName: string;       // "Build Your Own", "Santa's Classic", etc.
  totalUsd: number;          // amount the customer saw at approval time
  depositUsd: number;        // amount paid up front
  selectedItemCount: number; // for a "X items included" line
};

// Per-job charges needed to price the "Build Your Own" custom selection
// the SAME way the A/B/C package totals are priced (so the $1,000 minimum,
// rush/takedown fees, and tax apply consistently no matter how the customer
// builds their selection). Populated by the adapter from the quote's
// pricing result; the live SelectionContext total runs the custom subtotal
// through `priceSelection(subtotal, charges)`.
export type PortalCharges = {
  rushFee: number;   // dollars (premium rush fee, or 0)
  takedown: number;  // dollars (premium takedown fee, or 0)
  taxRate: number;   // effective rate for this quote, e.g. 0.08625
};

// Full price breakdown for a selection, so the portal can show a
// tie-out (Subtotal + fees + tax = Total) instead of a mystery number.
// Produced by priceSelection(subtotal, charges). No $1,000 floor — the
// minimum is enforced as an approval gate (see minimumOrderSubtotal).
export type SelectionPrice = {
  subtotal: number;  // pre-tax sum of the selected line items
  rushFee: number;   // dollars (0 when not on this quote)
  takedown: number;  // dollars (0 when not on this quote)
  taxable: number;   // subtotal + rushFee + takedown
  tax: number;       // dollars
  total: number;     // tax-inclusive total the customer pays
  deposit: number;   // 50% of total, due today
};

export type PortalQuote = {
  id: string;
  customer: {
    firstName: string;
    fullName: string;
    address: string;
  };
  photo: {
    before: string;     // URL of daytime photo
    after: string;      // URL of render (the 'full' variant)
    alt: string;
  };
  // Per-package preview images. Each card on the portal looks up its
  // own variant here; missing keys fall back to `photo.after`.
  variantPhotos: PortalVariantPhotos;
  video?: PortalVideo;  // optional — section hides entirely when absent
  packages: PortalPackage[];
  lineItems: PortalLineItem[];
  // Per-job charges (rush/takedown/tax) so the custom "Build Your Own"
  // total is priced identically to the A/B/C tiers. See PortalCharges.
  charges: PortalCharges;
  // Pre-tax subtotal the customer's selection must reach to approve
  // ($1,000), or 0 when waived (staff sent a sub-$1,000 quote). See
  // minimumOrderSubtotal() in lib/portal/derivePackages.
  minimumOrderSubtotal: number;
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
};

export type PortalSelection = {
  packageId: PackageId;
  selectedItemIds: Set<string>; // tracks which line items are currently on
};
