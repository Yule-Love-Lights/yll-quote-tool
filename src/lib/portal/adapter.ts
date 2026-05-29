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

import type { QuoteResult } from '@/lib/pricing/pricingEngine';
import type {
  PackageId,
  PortalApproval,
  PortalLineItem,
  PortalLineItemKind,
  PortalQuote,
  PortalVideo,
} from '@/components/portal/types';
import { buildLineItemId, parseLineItem } from './lineItemKind';
import { derivePackages } from './derivePackages';
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

function buildLineItems(result: QuoteResult): PortalLineItem[] {
  // Defensive: old rows or partial saves may have a missing / non-array
  // lineItems field. Treat as empty so the portal still renders (the
  // packages will all show "—" and the customer can pick "Build Your
  // Own" with nothing — surfaced as a clearly empty quote).
  const items = Array.isArray(result.lineItems) ? result.lineItems : [];

  // Track per-kind counts so each item gets a unique, deterministic id.
  const counts: Partial<Record<PortalLineItemKind, number>> = {};

  return items
    .filter((raw) => raw && typeof raw.label === 'string' && typeof raw.amount === 'number')
    .map((raw) => {
      const { kind, detail } = parseLineItem(raw.label);
      const idx = counts[kind] ?? 0;
      counts[kind] = idx + 1;
      return {
        id: buildLineItemId(kind, idx),
        kind,
        label: raw.label,
        detail,
        price: raw.amount,
      };
    });
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

  const lineItems = buildLineItems(row.result);
  const packages = derivePackages(lineItems, row.result);
  const { weeklyBookings, bookedThroughDate } = readScarcityFromEnv();

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
    variantPhotos: photos.variantUrls,
    video: buildVideo(row),
    packages,
    lineItems,
    weeklyBookings,
    seasonCapacity: {
      installedThisWeek: weeklyBookings,
      bookedThroughDate,
    },
    approval: buildApproval(row),
  };
}
