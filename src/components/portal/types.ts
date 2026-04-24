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
  total: number;        // dollars, pre-tax, already deposit-inclusive total
  deposit: number;      // dollars, typically 50% of total
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

export type PortalQuote = {
  id: string;
  customer: {
    firstName: string;
    fullName: string;
    address: string;
  };
  photo: {
    before: string;     // URL of daytime photo
    after: string;      // URL of render
    alt: string;
  };
  video?: PortalVideo;  // optional — section hides entirely when absent
  packages: PortalPackage[];
  lineItems: PortalLineItem[];
  weeklyBookings: number;    // real scarcity — pulled from DB in production
  seasonCapacity: {
    installedThisWeek: number;
    bookedThroughDate: string; // human-readable: "early November"
  };
};

export type PortalSelection = {
  packageId: PackageId;
  selectedItemIds: Set<string>; // tracks which line items are currently on
};
