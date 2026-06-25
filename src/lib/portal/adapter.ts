// The single seam between the DB schema and the customer portal.
//
// `quoteRowToPortalQuote()` takes a row from `quotes` (plus the resolved
// before/after photo URLs from the renders pipeline) and produces the
// PortalQuote shape the portal sections expect. Every portal page should
// call this once at the top — the components downstream only know
// PortalQuote, not the DB schema.
//
// If the DB schema or pricing engine output ever changes shape, fix the
// mapping here, not in components. This is the contract.

import type { CustomLineItem, QuoteInputs, QuoteResult } from '@/lib/pricing/pricingEngine';
import type {
  PackageId,
  PortalApproval,
  PortalLineItem,
  PortalLineItemKind,
  PortalQuote,
  PortalRoofline,
  PortalVideo,
} from '@/components/portal/types';
import { buildLineItemId, parseLineItem } from './lineItemKind';
import { derivePackages, chargesFromResult, minimumOrderSubtotal } from './derivePackages';
import type { PortalPhotos } from './photos';

// Frozen-snapshot shape stored in the `approval_snapshot` jsonb column.
// Mirrors what /api/quotes/[id]/approve writes — kept here as a narrow
// view (we don't import the API-route's type to avoid a frontend ↔ API
// dep). Optional everywhere because old approval rows from a future
// schema bump shouldn't crash the page; we degrade gracefully.
type ApprovalSnapshotJson = {
  version?: number;
  approvedAt?: string;
  customerSelection?: {
    packageId?: 'A' | 'B' | 'C' | 'D';
    activeName?: string;
    selectedItemIds?: string[];
    currentTotalUsd?: number;
    currentDepositUsd?: number;
    // The light color/pattern the customer approved with (#10). Optional/back-
    // compat: older snapshots predate it.
    colorSchemeId?: string;
    // The premium-takedown (#4) + Sep/Oct early-install (#40) choices the
    // customer approved with. Optional/back-compat: older snapshots predate them.
    takedownSelected?: boolean;
    installTiming?: 'none' | 'september' | 'october';
  };
};

// Shape of a `quotes` row pulled with the columns the portal needs.
// Kept narrow so callers can SELECT only what they need.
export type QuoteRowForPortal = {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  result: QuoteResult | null;
  // The quote's saved inputs (jsonb). Needed for the per-item `recommended`
  // flag on CUSTOM line items (#12): the flag lives on inputs.customLineItems,
  // NOT in result.lineItems. Optional/back-compat — old rows without it just
  // never mark custom rows recommended.
  inputs: QuoteInputs | null;
  total: number | null;
  video_kind: string | null;        // 'youtube' | 'mp4' | null
  video_src: string | null;
  video_poster: string | null;
  video_title: string | null;
  video_duration_sec: number | null;
  customer_approved_at: string | null;
  approval_snapshot: ApprovalSnapshotJson | null;
};

// Scarcity context comes from environment variables (per design B3).
// Naldo updates these weekly; deliberately not stored per-quote because
// they're a global property of the business calendar, not the quote.
function readScarcityFromEnv(): {
  weeklyBookings: number;
  bookedThroughDate: string;
} {
  const wbRaw = process.env.NEXT_PUBLIC_PORTAL_WEEKLY_BOOKINGS;
  const wbParsed = wbRaw ? parseInt(wbRaw, 10) : NaN;
  const weeklyBookings = Number.isFinite(wbParsed) && wbParsed >= 0 ? wbParsed : 8;

  const bookedThroughDate =
    process.env.NEXT_PUBLIC_PORTAL_BOOKED_THROUGH_DATE?.trim() || 'early November';

  return { weeklyBookings, bookedThroughDate };
}

function deriveFirstName(fullName: string | null): string {
  if (!fullName) return 'there';
  const [first] = fullName.trim().split(/\s+/);
  return first || 'there';
}

// Recover the per-item `recommended` flag for CUSTOM line items (#12). The flag
// lives on inputs.customLineItems (NOT result.lineItems), and the engine emits
// custom rows last, in order, with a deterministic label. So we rebuild the same
// valid-custom-item list the engine builds (same filter + label) and zip it to
// the engine's custom result rows in order — returning a Map<engineLabel,
// recommended>. Matching by label keeps it robust if other categories' rows
// happen to interleave.
function recommendedByCustomLabel(inputs: QuoteInputs | null): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const customs = inputs?.customLineItems;
  if (!Array.isArray(customs)) return out;
  for (const c of customs as CustomLineItem[]) {
    if (
      !c ||
      typeof c.label !== 'string' ||
      c.label.trim().length === 0 ||
      typeof c.amount !== 'number' ||
      !Number.isFinite(c.amount) ||
      c.amount < 0
    ) {
      continue; // mirror the engine's calculateCustomLineItems filter
    }
    const qty =
      typeof c.quantity === 'number' && Number.isFinite(c.quantity) && c.quantity >= 1
        ? Math.floor(c.quantity)
        : 1;
    const label = qty === 1 ? c.label.trim() : `${c.label.trim()} × ${qty}`;
    if (c.recommended) out.set(label, true);
  }
  return out;
}

function buildLineItems(result: QuoteResult, inputs: QuoteInputs | null = null): PortalLineItem[] {
  // Defensive: old rows or partial saves may have a missing / non-array
  // lineItems field. Treat as empty so the portal still renders (the
  // packages will all show "—" and the customer can pick "Build Your
  // Own" with nothing — surfaced as a clearly empty quote).
  const items = Array.isArray(result.lineItems) ? result.lineItems : [];
  const customRecommended = recommendedByCustomLabel(inputs);

  // Track per-kind counts so each item gets a unique, deterministic id.
  const counts: Partial<Record<PortalLineItemKind, number>> = {};

  return items
    .filter((raw) => raw && typeof raw.label === 'string' && typeof raw.amount === 'number')
    .map((raw) => {
      const { kind, detail } = parseLineItem(raw.label);
      const idx = counts[kind] ?? 0;
      counts[kind] = idx + 1;
      const item: PortalLineItem = {
        id: buildLineItemId(kind, idx),
        kind,
        // Legacy shim: quotes created before the "Gingerbread Ridge" → "Gingerbread"
        // rename have the old label stored in their result. Normalize for display so
        // the portal reads consistently regardless of when the quote was made. (New
        // quotes already emit "Gingerbread", so this is a no-op for them.)
        label: raw.label.replace(/Gingerbread Ridge/g, 'Gingerbread'),
        detail,
        price: raw.amount,
      };
      // A custom line item flagged `recommended` by staff (#12). Matched by the
      // engine's exact label (custom labels never contain "Gingerbread Ridge",
      // so the shim above is a no-op for them).
      if (customRecommended.get(raw.label)) item.recommended = true;
      return item;
    });
}

// The engine's single billed roofline — Santa's ("…Roofline…") or Gingerbread
// (incl. the legacy "Gingerbread Ridge" wording). NOT Winter Wonderland, which
// is independent C9 and stays a line item even though it parses to 'ridge'.
// Matched by label (not kind) so an unparseable item — which falls back to
// kind 'roofline' — is never mistaken for the roofline.
function isBilledRoofline(label: string): boolean {
  return /Roofline/i.test(label) || /Gingerbread/i.test(label);
}

// Build the portal line items + the mutually-exclusive roofline group (#17
// Phase 2).
//
// For Phase-1+ quotes the engine BILLS one roofline (Santa's or Gingerbread)
// as a line item but exposes BOTH priced options on result.rooflineOptions.
// The portal shows BOTH as ordinary toggle line items (no footage) so the
// customer can pick either one — SelectionContext makes them mutually
// exclusive. So we drop the single billed roofline and synthesize one line
// item per captured option in its place.
//
// Legacy rows (no rooflineOptions, or no billed roofline) keep their existing
// single roofline line item untouched and `roofline` is undefined.
export function buildPortalLineItems(result: QuoteResult, inputs: QuoteInputs | null = null): {
  lineItems: PortalLineItem[];
  roofline?: PortalRoofline;
} {
  const all = buildLineItems(result, inputs);
  const opts = result.rooflineOptions;
  const choice = result.rooflineChoice;

  if (!opts || (choice !== 'santas' && choice !== 'gingerbread')) {
    return { lineItems: all };
  }

  // One line item per captured option, no footage. Santa's keeps the
  // 'roofline' icon, Gingerbread the 'ridge' icon. Stable, descriptive ids.
  const optionItems: PortalLineItem[] = [];
  if (opts.santas) {
    optionItems.push({ id: 'roofline-santas', kind: 'roofline', label: "Santa's Roofline", detail: '', price: opts.santas.amount });
  }
  if (opts.gingerbread) {
    optionItems.push({ id: 'roofline-gingerbread', kind: 'ridge', label: 'Gingerbread', detail: '', price: opts.gingerbread.amount });
  }
  if (optionItems.length === 0) return { lineItems: all };

  const recommendedItemId =
    (choice === 'gingerbread' ? 'roofline-gingerbread' : 'roofline-santas');
  // Defensive: if the recommended option wasn't actually captured, default to
  // whichever option we do have.
  const recommended = optionItems.some((i) => i.id === recommendedItemId)
    ? recommendedItemId
    : optionItems[0].id;

  // Drop the engine's single billed roofline; the option items replace it and
  // lead the list, where the billed roofline sat before.
  const rest = all.filter((li) => !isBilledRoofline(li.label));
  return {
    lineItems: [...optionItems, ...rest],
    roofline: { itemIds: optionItems.map((i) => i.id), recommendedItemId: recommended },
  };
}

// Translate the jsonb approval snapshot into the camelCase PortalApproval
// the frontend consumes. Returns undefined when the customer hasn't
// approved yet (or when the snapshot is malformed beyond rescue) — the
// approved page treats undefined as "404, not yet booked."
function buildApproval(row: QuoteRowForPortal): PortalApproval | undefined {
  if (!row.customer_approved_at) return undefined;
  const snap = row.approval_snapshot;
  // Even without a snapshot we know they approved — fall back to row.total
  // so the page still works for any old rows missing the snapshot column.
  const sel = snap?.customerSelection;
  const packageId = (sel?.packageId ?? 'C') as PackageId;
  const totalUsd =
    typeof sel?.currentTotalUsd === 'number'
      ? sel.currentTotalUsd
      : (row.total ?? 0);
  const depositUsd =
    typeof sel?.currentDepositUsd === 'number'
      ? sel.currentDepositUsd
      : Math.round(totalUsd * 0.5);
  return {
    approvedAt: snap?.approvedAt ?? row.customer_approved_at,
    packageId,
    packageName: sel?.activeName?.trim() || `Package ${packageId}`,
    totalUsd,
    depositUsd,
    selectedItemCount: Array.isArray(sel?.selectedItemIds)
      ? sel.selectedItemIds.length
      : 0,
    installTiming:
      sel?.installTiming === 'september' || sel?.installTiming === 'october'
        ? sel.installTiming
        : 'none',
    takedownSelected: sel?.takedownSelected === true,
  };
}

function buildVideo(row: QuoteRowForPortal): PortalVideo | undefined {
  // Leader name comes from env (single source of truth for Naldo's first
  // name shown across the portal). Falls back to "Naldo" if not set.
  const leaderName = process.env.NEXT_PUBLIC_PORTAL_LEADER_NAME?.trim() || 'Naldo';

  // 1. Per-quote video wins when an admin attached one via /admin/quotes/[id]/video.
  if (
    (row.video_kind === 'youtube' || row.video_kind === 'mp4') &&
    row.video_src
  ) {
    return {
      kind: row.video_kind,
      src: row.video_src,
      poster: row.video_poster ?? undefined,
      title: row.video_title ?? 'Your Yule Love Lights walkthrough',
      durationSec: row.video_duration_sec ?? undefined,
      leaderName,
    };
  }

  // 2. Otherwise fall back to the single global walkthrough video that every
  // customer sees (NEXT_PUBLIC_PORTAL_WALKTHROUGH_VIDEO_ID = 11-char YouTube
  // ID). Section hides entirely only when neither a per-quote nor a global
  // video exists.
  const globalId = process.env.NEXT_PUBLIC_PORTAL_WALKTHROUGH_VIDEO_ID?.trim();
  if (globalId) {
    return {
      kind: 'youtube',
      src: globalId,
      title: 'Your Yule Love Lights walkthrough',
      leaderName,
    };
  }

  return undefined;
}

export type AdapterInput = {
  row: QuoteRowForPortal;
  photos: PortalPhotos;
};

export function quoteRowToPortalQuote({ row, photos }: AdapterInput): PortalQuote | null {
  // Without a pricing result there's nothing to show — caller should 404.
  if (!row.result) return null;

  const { lineItems, roofline } = buildPortalLineItems(row.result, row.inputs);
  // The $1,000 gate threshold (minimumOrderSubtotal) sums only ONE roofline —
  // never both options — so a quote with Santa's + Gingerbread isn't double-
  // counted into clearing a minimum the customer can only pick one roofline for.
  const tierLineItems = roofline
    ? lineItems.filter(
        (li) => !(roofline.itemIds.includes(li.id) && li.id !== roofline.recommendedItemId),
      )
    : lineItems;
  // Tier composition (Jason S12) needs BOTH roofline options so Tier 1 can be
  // Santa's and Tier 2 Gingerbread regardless of which staff recommended;
  // derivePackages guarantees no single tier ever selects both.
  const packages = derivePackages(lineItems, row.result, roofline);
  const { weeklyBookings, bookedThroughDate } = readScarcityFromEnv();
  // Computed up front so the seeded install-timing can prefer the customer's
  // APPROVED choice on a booked quote over the staff default (#40) — otherwise a
  // locked, approved portal could show a price based on the staff's offer rather
  // than what the customer actually confirmed.
  const approval = buildApproval(row);

  return {
    id: row.id,
    customer: {
      firstName: deriveFirstName(row.customer_name),
      fullName: row.customer_name ?? 'Anonymous',
      address: row.customer_address ?? '',
    },
    photo: {
      // Empty strings collapse the <img> visually if the components don't
      // null-check; the portal hero will null-check beforeUrl explicitly.
      before: photos.beforeUrl ?? '',
      after: photos.afterUrl ?? '',
      alt: photos.alt ?? `Photo of ${row.customer_address ?? 'home'}`,
    },
    video: buildVideo(row),
    packages,
    lineItems,
    roofline,
    // Per-job charges so the custom "Build Your Own" total is priced the
    // same way the A/B/C tiers are (rush/takedown + tax). Same source
    // derivePackages uses, kept in sync via the shared chargesFromResult.
    charges: chargesFromResult(row.result),
    // The $1,000 approval gate threshold. 0 when EITHER (a) staff checked
    // "waive the $1,000 minimum" on this quote (#59 — inputs.waiveMinimum), or
    // (b) the quote's items already total under $1,000 (the existing auto-waive
    // in minimumOrderSubtotal()). Enforced on the portal, not in pricing. Uses
    // tierLineItems so a two-roofline quote isn't double-counted.
    minimumOrderSubtotal: row.inputs?.waiveMinimum ? 0 : minimumOrderSubtotal(tierLineItems),
    // Seeds the portal's install-timing (#40): the customer's APPROVED choice on a
    // booked quote, else the staff-set default so an active quote opens with the
    // Sep/Oct discount pre-selected (the customer can still change it).
    installTiming: approval
      ? approval.installTiming
      : row.inputs?.installTiming === 'september' || row.inputs?.installTiming === 'october'
        ? row.inputs.installTiming
        : 'none',
    weeklyBookings,
    seasonCapacity: {
      installedThisWeek: weeklyBookings,
      bookedThroughDate,
    },
    approval,
  };
}
