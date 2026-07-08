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
import type { PermanentWarranty } from '@/lib/permanent/types';
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
import { derivePackagesPermanent } from '@/lib/permanent/derivePackagesPermanent';
import { derivePackagesEvent, eventSuggestions } from '@/lib/event/packages';
import type { PortalPhotos } from './photos';
import { deriveStatus, isPortalActionable, type QuoteStatus } from '@/lib/quoteStatus';

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
    // compat: older snapshots predate it. #49: a build-your-own pattern (color
    // ids) when colorSchemeId === 'custom'.
    colorSchemeId?: string;
    customPattern?: string[];
    // The rush-install (#4) + premium-takedown (#4) + Sep/Oct early-install (#40)
    // choices the customer approved with. Optional/back-compat: older snapshots
    // predate them.
    rushSelected?: boolean;
    takedownSelected?: boolean;
    installTiming?: 'none' | 'september' | 'october';
  };
  // #88 P6b-2 — the frozen "Your Protection" warranty copy + version the customer
  // agreed to (permanent quotes only). Optional/back-compat: older snapshots predate it.
  permanentWarranty?: {
    eyebrow?: string;
    heading?: string;
    bullets?: string[];
    version?: number;
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
  // When the deposit webhook confirmed payment (#38). NULL = approved but not
  // yet paid. Optional for back-compat with older callers/tests.
  deposit_paid_at?: string | null;
  // Bug fix (B3): status + decline_reason let the portal gate the approve+pay
  // UI for terminal/branch quotes (declined/cancelled/lost/changes_requested).
  // Optional for back-compat with older callers/tests that don't select them.
  status?: QuoteStatus | null;
  decline_reason?: string | null;
  // quote_sent_at + viewed_at used by deriveStatus so the B3 status gate is
  // accurate for legacy rows without a persisted status column.
  quote_sent_at?: string | null;
  viewed_at?: string | null;
  // Test Quote (ledger #93): drives the portal's "Simulate deposit paid" path.
  // Optional for back-compat with older callers/tests.
  is_test?: boolean | null;
  // Permanent Lighting (#88 P5): which package-derivation + minimum-gate path
  // the portal uses. Optional/back-compat — undefined/null reads as holiday.
  service_type?: import('@/lib/serviceType').ServiceType | null;
};

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

// #131: which inputs.permanent flag marks each permanent side line recommended.
// The legacy combined 'permanent-sides' line predates the flags (any Calculate
// that saves them also splits the line), so it is deliberately absent here.
// Exported: the builder breakdown renders its recommend checkboxes off the
// same map, so the two can't drift.
export const PERMANENT_RECOMMEND_FIELDS: Record<
  string,
  'frontRecommended' | 'leftRecommended' | 'rightRecommended' | 'backRecommended'
> = {
  'permanent-front': 'frontRecommended',
  'permanent-left': 'leftRecommended',
  'permanent-right': 'rightRecommended',
  'permanent-back': 'backRecommended',
};

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
      // Permanent Lighting (#88 P5): the pricing engine stamps stable
      // 'permanent-*' ids on these rows — key off the id directly (never a
      // label regex) instead of running them through the holiday parser.
      // The stable id becomes the portal id itself so packages/selection can
      // key on it without a separate lookup.
      if (typeof raw.id === 'string' && raw.id.startsWith('permanent-')) {
        const isAddon = raw.id === 'permanent-maintenance';
        const item: PortalLineItem = {
          id: raw.id,
          kind: isAddon ? 'permanent-addon' : 'permanent',
          // Customer-facing: drop the operator's " - N ft ($X/ft)" detail so the
          // customer sees just the surface name + price (Jason S23). The operator
          // breakdown keeps the full label — this transform is portal-only.
          label: raw.label.replace(/\s*-\s*[\d,]+\s*ft\s*\(\$[\d.,]+\/ft\)\s*$/i, ''),
          detail: '',
          price: raw.amount,
          stableId: raw.id,
        };
        // #131: staff per-side recommend flags ride the inputs (the WW/Stake #12
        // pattern — permanent sides bill from footage NUMBERS, so there may be no
        // scene strand to carry the flag). The portal pre-selects these.
        const recommendField = PERMANENT_RECOMMEND_FIELDS[raw.id];
        if (recommendField && inputs?.permanent?.[recommendField]) item.recommended = true;
        return item;
      }
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
        // #104: carry the engine's stable id so attachSceneLinks can link by
        // identity (not position). Absent on legacy results → positional fallback.
        ...(raw.id ? { stableId: raw.id } : {}),
      };
      // A custom line item flagged `recommended` by staff (#12). Matched by the
      // engine's exact label (custom labels never contain "Gingerbread Ridge",
      // so the shim above is a no-op for them).
      if (customRecommended.get(raw.label)) item.recommended = true;
      // #12: Winter Wonderland + Stake are measurement-driven (no scene item to
      // hold `recommended` when drawn as manual footage), so their staff-recommend
      // flag rides the quote inputs — matched by the stable line id (#104).
      // attachSceneLinks preserves this (it spreads ...li in the WW/Stake branch).
      if (raw.id === 'winter-wonderland' && inputs?.winterWonderlandRecommended) item.recommended = true;
      if (raw.id === 'stake-lighting' && inputs?.stakeLightingRecommended) item.recommended = true;
      return item;
    });
}

// The stable ids the engine now stamps on its single billed roofline row
// (#104, pricingEngine.ts:428/437) — Santa's or Gingerbread. Same ids the
// option items below are synthesized with, so identity matching is exact.
// Exported so any other UI that must drop/skip the billed roofline row (e.g.
// the staff Quote Breakdown, #110 W3-003) filters by the same stable ids
// instead of a fragile label match that can drop staff custom line items.
export const BILLED_ROOFLINE_IDS = new Set(['roofline-santas', 'roofline-gingerbread']);

// LEGACY label fallback ONLY — matches the engine's single billed roofline by
// its label wording ("…Roofline…" / "Gingerbread", incl. the old "Gingerbread
// Ridge"). Used exclusively for pre-#104 results whose billed roofline carries
// NO stable id; modern results drop it by identity via BILLED_ROOFLINE_IDS.
// A staff-typed CUSTOM line item can share these words (e.g. "Gingerbread house
// display" — W1-005), so this must NEVER run against a modern result — see the
// guard at the call site.
function isBilledRooflineLabel(label: string): boolean {
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
  //
  // Drop by IDENTITY, not label (#110 W1-005). The billed roofline now carries
  // a stable id ('roofline-santas' / 'roofline-gingerbread', #104). Matching the
  // label regex against every row deleted staff-typed CUSTOM items whose freeform
  // label happened to contain "Roofline"/"Gingerbread" (e.g. "Gingerbread house
  // display – $250") — silently dropping them from the portal list, the tiers,
  // the $1,000 gate, AND the approve route's authoritative recompute (same fn),
  // so the customer approved+paid a total that excluded them.
  //
  // Modern results (the billed roofline has a stable id) → drop by id ONLY; the
  // label regex never runs, so custom items with those words survive. Legacy
  // pre-#104 results (billed roofline had no id) fall back to the label regex —
  // scoped to roofline/ridge kinds so a differently-kinded row is never dropped.
  const hasStableRoofline = all.some((li) => li.stableId && BILLED_ROOFLINE_IDS.has(li.stableId));
  const rest = all.filter((li) => {
    if (li.stableId) return !BILLED_ROOFLINE_IDS.has(li.stableId);
    // No stable id: an id-carrying modern result already handled its billed
    // roofline above, so any remaining row here is a custom/manual item — keep
    // it. Only for a fully-legacy result do we fall back to the label regex.
    if (hasStableRoofline) return true;
    return !(isBilledRooflineLabel(li.label) && (li.kind === 'roofline' || li.kind === 'ridge'));
  });
  return {
    lineItems: [...optionItems, ...rest],
    roofline: { itemIds: optionItems.map((i) => i.id), recommendedItemId: recommended },
  };
}

// Translate the jsonb approval snapshot into the camelCase PortalApproval
// the frontend consumes. Returns undefined when the customer hasn't
// approved yet (or when the snapshot is malformed beyond rescue) — the
// approved page treats undefined as "404, not yet booked."
// #88 P6b-2 — shape the frozen warranty jsonb back into a PortalApproval field.
// null when the quote has no frozen warranty (non-permanent, or an older snapshot
// predating the freeze) — the portal then falls back to the LIVE settings copy.
function frozenWarranty(
  w: NonNullable<QuoteRowForPortal['approval_snapshot']>['permanentWarranty'],
): PermanentWarranty | null {
  if (!w || typeof w.version !== 'number' || !Array.isArray(w.bullets)) return null;
  return {
    eyebrow: typeof w.eyebrow === 'string' ? w.eyebrow : '',
    heading: typeof w.heading === 'string' ? w.heading : '',
    bullets: w.bullets.filter((b): b is string => typeof b === 'string'),
    version: w.version,
  };
}

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
    depositPaidAt: row.deposit_paid_at ?? null,
    packageId,
    packageName: sel?.activeName?.trim() || `Package ${packageId}`,
    totalUsd,
    depositUsd,
    selectedItemCount: Array.isArray(sel?.selectedItemIds)
      ? sel.selectedItemIds.length
      : 0,
    // The exact frozen selection, so a booked portal re-seeds SelectionProvider
    // from what the customer signed rather than the recommendation/staff defaults
    // (audit: approved-portal-snapshot). Sanitize to a clean string[] — the
    // approve route already validated these against real ids, but old/forged
    // snapshots shouldn't leak non-strings into the seed.
    selectedItemIds: Array.isArray(sel?.selectedItemIds)
      ? sel.selectedItemIds.filter((x): x is string => typeof x === 'string')
      : [],
    installTiming:
      sel?.installTiming === 'september' || sel?.installTiming === 'october'
        ? sel.installTiming
        : 'none',
    rushSelected: sel?.rushSelected === true,
    takedownSelected: sel?.takedownSelected === true,
    permanentWarranty: frozenWarranty(snap?.permanentWarranty),
  };
}

// ── Portal-page display derivations (audit: approved-portal-snapshot) ────────
// Extracted here (server-free, unit-testable) because the portal page component
// pulls in `server-only` deps and can't be imported by a test.

// Whether the portal should render the BOOKED experience (banner + booked
// sticky bar + the /approved celebration link).
//   - checkout ON / test quote: "booked" means the deposit was actually PAID.
//   - checkout OFF (placeholder flow): approval is the end state, BUT only while
//     the quote is still live (actionable) or already paid — a quote staff
//     CANCEL/DECLINE after approval must fall out of the booked view (it's shown
//     the neutral closed notice instead). A genuinely paid deal stays booked.
export function deriveIsBooked(args: {
  checkoutEnabled: boolean;
  isTest: boolean;
  isPaid: boolean;
  isApproved: boolean;
  quoteStatus: string | null | undefined;
}): boolean {
  const { checkoutEnabled, isTest, isPaid, isApproved, quoteStatus } = args;
  if (checkoutEnabled || isTest) return isPaid;
  return isApproved && (isPaid || isPortalActionable(quoteStatus));
}

// Seed the SelectionProvider package/item selection. On an approved (locked)
// portal we prefer the FROZEN snapshot over the recommendation/staff default so
// the display matches what the customer signed:
//   - a divergent/custom approval (packageId 'D') restores its exact item set
//     (passing the id list highlights the custom "Build Your Own" slot);
//   - a named tier (A/B/C) restores by packageId with NO id list, because
//     computeInitialSelection collapses a non-empty id list to 'D' — passing the
//     ids for a lettered package would wrongly drop its tier highlight.
export function resolveApprovalSelectionSeed(
  approval: Pick<PortalApproval, 'packageId' | 'selectedItemIds'> | undefined,
  fallback: { initialPackageId: PackageId; initialSelectedItemIds: string[] | undefined },
): { initialPackageId: PackageId; initialSelectedItemIds: string[] | undefined } {
  if (!approval) return fallback;
  if (approval.packageId === 'D') {
    return { initialPackageId: 'D', initialSelectedItemIds: approval.selectedItemIds };
  }
  return { initialPackageId: approval.packageId, initialSelectedItemIds: undefined };
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
  //
  // Permanent Lighting (#88 P5): surface-based packages (front/sides/back/
  // whole-home) instead of the holiday roofline/spritzer tier ladder.
  // Event Lighting (#96 Phase B): ONE "what's included" package (all line items
  // bundled) instead of the holiday tier ladder / permanent surface packages.
  const isPermanent = row.service_type === 'permanent';
  const isEvent = row.service_type === 'event';
  const allPackages = isPermanent
    ? derivePackagesPermanent(lineItems, row.result)
    : isEvent
      ? derivePackagesEvent(lineItems, row.result)
      : derivePackages(lineItems, row.result, roofline);
  // The approval gate threshold — hoisted (was inline in the return below) so
  // the package filter next uses the IDENTICAL value the approve gate enforces.
  // $1,000 for holiday/event, or the permanent quote's FROZEN rate-snapshot
  // minimumJobAmount (#88 — never live app_settings, the rate-drift guard;
  // falls back to the canonical $2,500 default if a permanent result somehow
  // lacks a snapshot). 0 when EITHER (a) staff checked "waive the minimum" on
  // this quote (#59 — inputs.waiveMinimum), or (b) the quote's items already
  // total under the minimum (the existing auto-waive in minimumOrderSubtotal()).
  // Enforced on the portal, not in pricing. Uses tierLineItems so a
  // two-roofline quote isn't double-counted.
  const approvalGate = row.inputs?.waiveMinimum
    ? 0
    : minimumOrderSubtotal(
        tierLineItems,
        isPermanent ? (row.result.permanentRatesSnapshot?.minimumJobAmount ?? 2500) : undefined,
      );
  // #134 (Jason S24): hide any package tile whose selection can't be approved —
  // its PRE-TAX subtotal lands under the gate, so tapping it only walks the
  // customer into the "add $X more" wall. Gate 0 (waived / auto-waived because
  // the whole quote is under the minimum) hides nothing, so tiles can never
  // ALL vanish; the individual line-item toggles are unaffected either way.
  const priceById = new Map(lineItems.map((li) => [li.id, li.price]));
  const packages =
    approvalGate > 0
      ? allPackages.filter(
          (pkg) =>
            pkg.includedItemIds.reduce((sum, id) => sum + (priceById.get(id) ?? 0), 0) >=
            approvalGate,
        )
      : allPackages;
  // Computed up front so the seeded install-timing can prefer the customer's
  // APPROVED choice on a booked quote over the staff default (#40) — otherwise a
  // locked, approved portal could show a price based on the staff's offer rather
  // than what the customer actually confirmed.
  const approval = buildApproval(row);
  // Staff "Apply discount" from the builder → flowed to the live portal price so
  // the customer sees + gets it. Percentage rides as a fraction off the subtotal;
  // flat as dollars. Mutually exclusive with the early-install promo (one per quote).
  const d = row.inputs?.discount;
  const manualDiscount = d
    ? { rate: d.type === 'percentage' ? d.amount : 0, flat: d.type === 'flat' ? d.amount : 0 }
    : { rate: 0, flat: 0 };

  // Event Lighting (#96): surface the staff-entered dates for the portal's
  // "Your Event Schedule" block — only for an event quote with at least one set.
  const ev = row.service_type === 'event' ? row.inputs?.event : undefined;
  const eventSchedule =
    ev && (ev.installDate || ev.eventDate || ev.takedownDate)
      ? {
          ...(ev.installDate ? { installDate: ev.installDate } : {}),
          ...(ev.eventDate ? { eventDate: ev.eventDate } : {}),
          ...(ev.takedownDate ? { takedownDate: ev.takedownDate } : {}),
        }
      : undefined;
  // Event Lighting (#96): the soft "add if you'd like" suggestions — popular
  // add-ons not already on the quote (event quotes only).
  const evSuggestions =
    row.service_type === 'event' && row.result ? eventSuggestions(row.result) : [];

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
    charges: { ...chargesFromResult(row.result), manualDiscount },
    // The approval gate threshold — see `approvalGate` above (hoisted so the
    // #134 package filter and this gate can never disagree).
    minimumOrderSubtotal: approvalGate,
    // Seeds the portal's install-timing (#40): the customer's APPROVED choice on a
    // booked quote, else the staff-set default so an active quote opens with the
    // Sep/Oct discount pre-selected (the customer can still change it).
    installTiming: approval
      ? approval.installTiming
      : row.inputs?.installTiming === 'september' || row.inputs?.installTiming === 'october'
        ? row.inputs.installTiming
        : 'none',
    approval,
    // Test Quote (ledger #93): the portal pay button becomes "Simulate deposit
    // paid" (→ /simulate-deposit) when this is a test quote.
    isTest: row.is_test ?? false,
    // The quote's service line (#88 Permanent Lighting vertical). Undefined
    // for legacy rows without the column.
    serviceType: row.service_type ?? undefined,
    ...(eventSchedule ? { eventSchedule } : {}),
    ...(evSuggestions.length > 0 ? { eventSuggestions: evSuggestions } : {}),
    // Bug fix (B3): derive the current status from the row (explicit persisted
    // status wins for branch/terminal states; timestamps are the fallback for
    // legacy rows) and thread it into PortalQuote so the portal can gate the
    // approve+pay UI for dead/under-revision quotes.
    quoteStatus: deriveStatus({
      quote_sent_at: row.quote_sent_at ?? null,
      customer_approved_at: row.customer_approved_at ?? null,
      deposit_paid_at: row.deposit_paid_at ?? null,
      viewed_at: row.viewed_at ?? null,
      status: row.status ?? null,
    }) as string,
    declineReason: row.decline_reason ?? null,
  };
}
