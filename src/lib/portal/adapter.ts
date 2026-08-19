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

import { effectiveDepositRate, type CustomLineItem, type QuoteInputs, type QuoteResult } from '@/lib/pricing/pricingEngine';
import type { PermanentWarranty } from '@/lib/permanent/types';
import type {
  PackageId,
  PortalApproval,
  PortalLineItem,
  PortalLineItemKind,
  PortalPackage,
  PortalQuote,
  PortalRoofline,
  PortalVideo,
} from '@/components/portal/types';
import { buildLineItemId, parseLineItem } from './lineItemKind';
import { derivePackages, derivePackagesLegacyRebook, chargesFromResult, minimumOrderSubtotal } from './derivePackages';
import { roundMoney } from '@/lib/money';
import { derivePackagesPermanent } from '@/lib/permanent/derivePackagesPermanent';
import { derivePackagesEvent, eventSuggestions } from '@/lib/event/packages';
import { derivePackagesPermanentBistro } from '@/lib/permanentBistro/packages';
import type { PortalPhotos } from './photos';
import { deriveStatus, isPortalActionable, type QuoteStatus } from '@/lib/quoteStatus';
import { isAmendmentConsentPending, latestConsentAmendment, type AmendmentTrailEntry } from '@/lib/amend';

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
    // #177 — the effective deposit rate (0-1) frozen at approval time. Optional/
    // back-compat: snapshots written before this field existed lack it, and
    // buildApproval falls back to the live rate, then BUSINESS_RULES.depositPercentage.
    depositRate?: number;
  };
  // #88 P6b-2 — the frozen "Your Protection" warranty copy + version the customer
  // agreed to (permanent quotes only). Optional/back-compat: older snapshots predate it.
  permanentWarranty?: {
    eyebrow?: string;
    heading?: string;
    bullets?: string[];
    version?: number;
  };
  amendments?: AmendmentTrailEntry[];
};

// Shape of a `quotes` row pulled with the columns the portal needs.
// Kept narrow so callers can SELECT only what they need.
export type QuoteRowForPortal = {
  id: string;
  // Referral program (#41): the stable customers.id link (ledger #83 Phase 5).
  // Optional for back-compat with older callers/tests that don't select it.
  customer_id?: string | null;
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
  // UI for terminal/branch quotes (declined/cancelled/abandoned/changes_requested).
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
  // Legacy rebook (#155): quote migrated from last year's Jobber data — the
  // portal shows a slightly different Light Color band + read-only What's
  // Included list. Optional/back-compat — undefined/null reads as false
  // (normal quote, unchanged behavior).
  legacy_rebook?: boolean | null;
  // View-only portal (#176): a staff-flagged browse-only quote — the sticky
  // bar shows a neutral "just browsing" strip instead of approve/pay/decline.
  // Optional/back-compat — undefined/null reads as false (normal quote).
  view_only?: boolean | null;
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

// Jason (portal-label-detail-strip): the mini-light kinds whose engine label
// carries an operator-only "– [canopy|trunk wrap, ]N string(s)" suffix
// (pricingEngine.ts calculateMiniLights ~565-580). Each kind is assigned by
// its OWN exclusive `^`-anchored prefix regex in lineItemKind.ts (TREE_RE/
// BUSH_RE/COLUMN_RE/RAILING_RE/CURTAIN_RE) — no other product shares these
// kinds, so scoping the strip by kind can never catch a staff-typed CUSTOM
// item unless that item's free-text label happens to START with the exact
// product word (a pre-existing parseLineItem characteristic, not something
// this strip introduces — same reasoning as the W1-005 roofline-label guard).
const MINI_LIGHT_KINDS: ReadonlySet<PortalLineItemKind> = new Set([
  'tree',
  'bush',
  'column',
  'railing',
  'curtain',
]);
// En-dash aware (the engine uses U+2013, not a hyphen). Matches the trailing
// "– canopy wrap, 4 strings" / "– trunk wrap, 4 strings" / "– 1 string" /
// "– 3 strings" portion only — a label without this exact suffix shape is
// left untouched (see the stripped !== item.label guard at the call site).
const MINI_LIGHT_SUFFIX_RE = /\s*–\s*(?:(?:canopy|trunk)\s+wrap,\s*)?\d+\s+strings?\s*$/i;

// #246: the customer must never see LIGHT footage (business rule — wreath/
// garland SIZES are fine, this is scoped to footage specifically). Several
// engine labels carry it as a trailing "– Nft" suffix, sometimes followed by
// a "(<difficulty>|($X/ft))" parenthetical (roofline family) and sometimes
// not (bistro). Anchored to the EXACT known product-name prefix — not just
// the item's `kind` — so a staff-typed CUSTOM item that merely shares a
// kind's classifying word is never silently truncated (same defense as the
// #138/S30/W1-005 label-identity guards elsewhere in this file). Accepts
// either a hyphen or an en dash before the footage, since a pre-#104 stored
// label is a data hypothesis, not a guarantee of the engine's exact byte.
// Returns the bare product name when the shape matched, else null (the
// label is left completely untouched). NOTE: this also blanks `detail` at
// every call site below — that's not cosmetic. The web portal components
// never read `detail`, but the customer-facing PDF does (docModels.ts ~115
// -> PdfLineItemsTable.tsx ~29 renders it verbatim), so an unstripped/
// unblanked `detail` would leak the same footage onto the PDF even when the
// label itself is clean. Don't "simplify" the detail-blanking away as dead.
//
// `productName` is escaped before interpolation — every current caller below
// is metacharacter-free (an apostrophe isn't special in a JS regex), so this
// is a hardening move, not a live-bug fix: without it, a future product name
// containing a regex metacharacter (. ( $ + etc.) would silently misparse
// instead of erroring.
function stripFootageSuffix(label: string, productName: string, requireParen: boolean): string | null {
  const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = requireParen
    ? new RegExp(`^${escaped} [-–] [\\d,]+(?:\\.\\d+)?\\s*ft\\s*\\(`, 'i')
    : new RegExp(`^${escaped} [-–] [\\d,]+(?:\\.\\d+)?\\s*ft\\s*$`, 'i');
  return re.test(label) ? productName : null;
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
      // Permanent Lighting (#88 P5): the pricing engine stamps stable
      // 'permanent-*' ids on these rows — key off the id directly (never a
      // label regex) instead of running them through the holiday parser.
      // The stable id becomes the portal id itself so packages/selection can
      // key on it without a separate lookup.
      // NOTE (#117): permanent BISTRO ids ('permanent-bistro-*') also match this
      // prefix (manual/no-scene-link bistro runs + the poles line), so they are
      // carved out FIRST into their own 'bistro' kind below — id/stableId/label
      // preserved exactly as the plain permanent branch, detail stays '' (the
      // label already carries footage). Any future permanent-only logic keyed on
      // this prefix must still exclude 'permanent-bistro-'.
      //
      // #246 HIGH (prod-confirmed, quote 652c88f8-…): this id-prefix check is
      // NOT the only door a permanent-bistro run comes through. A run drawn on
      // the design carries the SCENE item's own uuid as its id — the synthesized
      // 'permanent-bistro-<i>' id (permanentBistro/pricing.ts withIdentity) is
      // ONLY a fallback for a manual run with no scene link. A uuid never
      // starts with 'permanent-bistro', so a scene-linked run falls through to
      // the generic kind === 'bistro' branch below instead of here — that
      // branch strips footage too (see its own comment) precisely because of
      // this gap.
      if (typeof raw.id === 'string' && raw.id.startsWith('permanent-bistro')) {
        // #246: strip the run's engine footage suffix ("Permanent Bistro
        // Lighting – 40ft", permanentBistro/pricing.ts calculateBistroLines).
        // The poles/maintenance rows sharing this id prefix ("Poles (N)",
        // "Annual Maintenance Plan") don't match the shape and pass through.
        const bareLabel = stripFootageSuffix(raw.label, 'Permanent Bistro Lighting', false);
        const item: PortalLineItem = {
          id: raw.id,
          kind: 'bistro',
          label: bareLabel ?? raw.label,
          detail: '',
          price: raw.amount,
          stableId: raw.id,
        };
        return item;
      }
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
      // #138 (Jason S24): the customer card shows just the product name + price —
      // the engine's " – 41ft (easy)" footage/difficulty suffix is operator
      // detail (the builder breakdown renders result.lineItems directly, so it
      // keeps the full label). Matched by kind + the ENGINE'S EXACT label shape
      // ("Winter Wonderland – <n>ft (<rate>)") so pre-#104 results with no
      // stable id normalize too — a bare prefix match ate staff-typed CUSTOM
      // items that happened to start with "Winter Wonderland" (S30 live bug:
      // "Winter Wonderland Display Package · …" rendered as just "Winter
      // Wonderland" on the portal). Same only-if-the-pattern-matched guard as
      // the mini-light strip below. Gingerbread shares this kind (RIDGE_RE
      // matches both words) and the same engine shape (#246).
      if (kind === 'ridge') {
        const bare =
          stripFootageSuffix(item.label, 'Winter Wonderland', true) ??
          stripFootageSuffix(item.label, 'Gingerbread', true);
        if (bare) {
          item.label = bare;
          item.detail = '';
        }
      }
      // Santa's Roofline (#246): the plain roofline family's own footage
      // suffix — same shape as Winter Wonderland/Gingerbread above, this is
      // the fix for a LEGACY pre-#104 quote (no rooflineOptions), whose single
      // billed roofline line survives buildPortalLineItems untouched and
      // otherwise carries footage straight to the customer.
      if (kind === 'roofline') {
        const bare = stripFootageSuffix(item.label, "Santa's Roofline", true);
        if (bare) {
          item.label = bare;
          item.detail = '';
        }
      }
      // Stake Lighting (Jason, portal-label-detail-strip): the customer card
      // shows just "Stake Lighting" — the engine's " – Nft (rate)" footage/
      // difficulty suffix (pricingEngine.ts calculateStakeLighting ~525) is
      // operator detail. Same engine-shape match as the #138 WW strip above so
      // a custom item named "Stake Lighting …" can never be truncated.
      if (kind === 'stake-lighting') {
        const bare = stripFootageSuffix(item.label, 'Stake Lighting', true);
        if (bare) {
          item.label = bare;
          item.detail = '';
        }
      }
      // Bistro Lighting (#246): the EVENT vertical's temporary bistro run
      // (event/pricing.ts calculateBistro) — no trailing parenthetical, unlike
      // the roofline family. A MANUAL/no-scene-link permanent-bistro run is
      // stripped earlier, in its own id-keyed branch above — but a
      // SCENE-LINKED permanent-bistro run carries a uuid id (see the #246 HIGH
      // note on that branch) and falls through to here instead, so this must
      // also try the "Permanent Bistro Lighting" prefix, not just event's
      // bare "Bistro Lighting" (prod-confirmed HIGH: quote 652c88f8-…, three
      // rows shipped with footage still attached before this fix).
      if (kind === 'bistro') {
        const bare =
          stripFootageSuffix(item.label, 'Permanent Bistro Lighting', false) ??
          stripFootageSuffix(item.label, 'Bistro Lighting', false);
        if (bare) {
          item.label = bare;
          item.detail = '';
        }
      }
      // Mini lights — Tree/Bush/Column/Railing/Curtain Lights (Jason,
      // portal-label-detail-strip): the customer card shows just the surface
      // name — the engine's wrap-style/string-count suffix is operator detail.
      // See MINI_LIGHT_KINDS/MINI_LIGHT_SUFFIX_RE above for why this is safe
      // against staff-typed CUSTOM items. Only strip when the suffix pattern
      // actually matched (stripped !== item.label) — an unexpected label shape
      // passes through unchanged instead of silently losing its detail.
      if (MINI_LIGHT_KINDS.has(kind)) {
        const stripped = item.label.replace(MINI_LIGHT_SUFFIX_RE, '');
        if (stripped !== item.label) {
          item.label = stripped;
          item.detail = '';
        }
      }
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

// The billable set of line-item ids for a quote "as sent" — every line item,
// EXCEPT that when a mutually-exclusive roofline group exists (#17 Phase 2)
// only the recommended/billed option counts (selecting BOTH Santa's AND
// Gingerbread would double-bill the front). Mirrors the `tierLineItems` gate
// filter in quoteRowToPortalQuote below. Exported so the staff-approve route
// (PS-C1/WT-L1) can freeze "the whole quote, as billed" into an approval
// snapshot's customerSelection without duplicating the roofline-exclusivity
// rule or risking a double-select.
export function billableLineItemIds(lineItems: PortalLineItem[], roofline?: PortalRoofline): string[] {
  if (!roofline) return lineItems.map((li) => li.id);
  return lineItems
    .filter((li) => !roofline.itemIds.includes(li.id) || li.id === roofline.recommendedItemId)
    .map((li) => li.id);
}

// Approved-quote fallback packageId for a snapshot with no customerSelection
// (the pre-fix staff-approve path — see the route's header comment) or a
// corrupted/legacy one missing packageId: resolve to an id that ACTUALLY
// EXISTS among this quote's derived packages, so the downstream seed
// (resolveApprovalSelectionSeed → computeInitialSelection in
// SelectionContext) never comes up empty. Hardcoding the holiday-only 'C'
// (the old behavior) rendered a $0 portal with every item OFF for any
// staff-approved event/bistro/no-back-permanent quote, because those
// verticals have no 'C' tier (PS-C1/WT-L1).
//
// Preference order: holiday's "everything" tier 'C' (byte-identical to the
// old default for holiday quotes) → 'D' (event/bistro's only tier, or
// permanent's Whole Home when present) → the package with the most included
// items (e.g. a no-back permanent quote offering only Front/Sides, where 'D'
// is intentionally omitted as redundant — see derivePackagesPermanent).
function pickFallbackApprovalPackageId(packages: PortalPackage[]): PackageId {
  if (packages.some((p) => p.id === 'C')) return 'C';
  if (packages.some((p) => p.id === 'D')) return 'D';
  if (packages.length > 0) {
    return packages.reduce((best, p) => (p.includedItemIds.length > best.includedItemIds.length ? p : best))
      .id;
  }
  return 'D';
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

// FIX4 (review HIGH, money): the amendment-consent card must show the SAME
// basis the SMS/email quote (amend/route.ts's notifiedTotal/notifiedBalance/
// notifiedDelta) — the invoice basis whenever a linked invoice exists (that
// is what the customer will actually be billed), the trail basis only when
// there is no invoice yet. Same tax-scaling formula amend/route.ts's re-sync
// and invoices.ts's createInvoiceFromJob/setInvoiceTaxOverride use (exact
// under the flat rate: total = taxable × (1+rate) ⇒ trailTotal/fullTotal =
// taxable ratio).
//
// Deliberately duplicated here rather than imported from invoices.ts:
// invoices.ts imports the Supabase SERVICE-role client, and this adapter is
// imported by src/components/quote/QuoteBuilder.tsx (a client component) —
// pulling that import in here would drag a server-only dependency into every
// client bundle that imports this adapter. Exported for direct unit tests.
export function invoiceBasisTotal(
  trailTotalUsd: number,
  fullTotalUsd: number,
  fullTaxAmountUsd: number,
  taxOverridden: boolean,
): number {
  if (!taxOverridden) return roundMoney(trailTotalUsd);
  const scaledTax =
    fullTotalUsd > 0
      ? roundMoney(fullTaxAmountUsd * (trailTotalUsd / fullTotalUsd))
      : roundMoney(fullTaxAmountUsd);
  return roundMoney(trailTotalUsd - scaledTax);
}

function buildApproval(
  row: QuoteRowForPortal,
  packages: PortalPackage[],
  // null = no linked invoice yet (job not complete) → trail basis throughout,
  // same as before this fix. Set from loader.ts (server-only) — never fetched
  // in this module itself; see the invoiceBasisTotal comment above for why.
  invoiceTaxOverridden: boolean | null,
): PortalApproval | undefined {
  if (!row.customer_approved_at) return undefined;
  const snap = row.approval_snapshot;
  // Even without a snapshot we know they approved — fall back to row.total
  // so the page still works for any old rows missing the snapshot column.
  const sel = snap?.customerSelection;
  if (!sel?.packageId) {
    // Regression tripwire (PS-C1/WT-L1): every approved quote should carry a
    // real customerSelection now that the staff-approve route freezes one.
    // Hitting this path means either an OLD pre-fix staff approval, or a
    // future regression that omits it again — log so it surfaces before a
    // customer sees a $0 portal.
    console.error(
      `[portal/adapter] approved quote ${row.id} has no customerSelection.packageId in its approval_snapshot — falling back to a derived package id`,
    );
  }
  const packageId = (sel?.packageId ?? pickFallbackApprovalPackageId(packages)) as PackageId;
  const amendment = latestConsentAmendment(snap?.amendments);
  const acceptedAmendment = amendment?.consent?.status === 'accepted' ? amendment : undefined;
  // Once re-consent is accepted, the amended total is the durable customer
  // agreement. Keep the booked portal aligned with billing instead of falling
  // back to the original approval total after the pending card disappears.
  const totalUsd =
    acceptedAmendment
      ? acceptedAmendment.new_total
      : typeof sel?.currentTotalUsd === 'number'
        ? sel.currentTotalUsd
        : (row.total ?? 0);
  const depositUsd =
    acceptedAmendment
      ? acceptedAmendment.deposit_applied
      : typeof sel?.currentDepositUsd === 'number'
        ? sel.currentDepositUsd
        // #177: this quote's deposit rate (default 50%), rounded to CENTS (was
        // whole dollars — a legacy/staff-approved snapshot could show a deposit
        // ~49¢ off).
        : roundMoney(totalUsd * effectiveDepositRate(row.inputs?.depositPercent));
  // #177 fix 2 — the FROZEN rate the customer actually approved with. Prefer
  // the snapshot's depositRate; fall back to the live inputs.depositPercent
  // (then BUSINESS_RULES.depositPercentage, via effectiveDepositRate's own
  // fallback) for a legacy snapshot written before this field existed.
  const depositRate =
    typeof sel?.depositRate === 'number'
      ? sel.depositRate
      : effectiveDepositRate(row.inputs?.depositPercent);
  return {
    approvedAt: snap?.approvedAt ?? row.customer_approved_at,
    depositPaidAt: row.deposit_paid_at ?? null,
    packageId,
    packageName: sel?.activeName?.trim() || `Package ${packageId}`,
    totalUsd,
    depositUsd,
    depositRate,
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
    // #163 — the frozen colour (approved with, or staff-applied via a colour
    // change request); the booked portal opens its picker/render on it.
    ...(typeof sel?.colorSchemeId === 'string' ? { colorSchemeId: sel.colorSchemeId } : {}),
    ...(Array.isArray(sel?.customPattern)
      ? { customPattern: sel.customPattern.filter((x): x is string => typeof x === 'string') }
      : {}),
    permanentWarranty: frozenWarranty(snap?.permanentWarranty),
    ...(() => {
      // isAmendmentConsentPending is true for BOTH 'pending' and 'declined'
      // (see amend.ts — a decline is "not accepted", same as never having
      // answered), which is exactly the population that still needs a card on
      // the portal: pending asks the question, declined shows the customer
      // their own answer instead of asking again. Read consent.status
      // directly here (not a new amend.ts predicate) — this is a pure
      // display-layer branch, not a money decision.
      if (!isAmendmentConsentPending(amendment)) return {};
      const declined = amendment!.consent?.status === 'declined';
      // FIX4: derive both totals on the SAME basis, from the SAME live
      // full-quote pricing (row.result), so newTotalUsd − deltaUsd always
      // equals previousTotalUsd exactly — the card can never show a delta
      // that doesn't reconcile with the totals either side of it.
      const fullTotal = row.result?.total ?? 0;
      const fullTax = row.result?.taxAmount ?? 0;
      const previousTotalUsd =
        invoiceTaxOverridden == null
          ? amendment!.previous_total
          : invoiceBasisTotal(amendment!.previous_total, fullTotal, fullTax, invoiceTaxOverridden);
      const newTotalUsd =
        invoiceTaxOverridden == null
          ? amendment!.new_total
          : invoiceBasisTotal(amendment!.new_total, fullTotal, fullTax, invoiceTaxOverridden);
      // Deposit paid is basis-independent (the actual dollar amount charged);
      // balance is derived from the (possibly invoice-basis) newTotalUsd so it
      // agrees with it, mirroring computeInvoiceTotals' own balance formula.
      const newBalanceUsd = roundMoney(Math.max(0, newTotalUsd - amendment!.deposit_applied));
      return {
        pendingAmendment: {
          amendedAt: amendment!.amended_at,
          reason: amendment!.reason,
          previousTotalUsd,
          newTotalUsd,
          deltaUsd: roundMoney(newTotalUsd - previousTotalUsd),
          depositAppliedUsd: amendment!.deposit_applied,
          newBalanceUsd,
          consentStatus: declined ? 'declined' : 'pending',
          ...(declined && amendment!.consent?.status === 'declined' && amendment!.consent.reason
            ? { declinedReason: amendment!.consent.reason }
            : {}),
          ...(declined && amendment!.consent?.status === 'declined'
            ? { declinedAt: amendment!.consent.declined_at }
            : {}),
        },
      };
    })(),
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
  // FIX4: the linked invoice's tax_overridden flag, when a job/invoice exists
  // for this quote — threaded in from loader.ts (server-only; this adapter
  // never reads the invoice itself, see invoiceBasisTotal's comment).
  // undefined/omitted (every pre-FIX4 caller) reads the same as null — no
  // invoice, trail basis — so this is backward-compatible.
  invoiceTaxOverridden?: boolean | null;
};

export function quoteRowToPortalQuote({
  row,
  photos,
  invoiceTaxOverridden = null,
}: AdapterInput): PortalQuote | null {
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
  // Permanent Bistro Lighting: ONE "what's included" package too (event's model —
  // see derivePackagesPermanentBistro), never the holiday tier ladder or
  // permanent's per-surface packages.
  const isPermanent = row.service_type === 'permanent';
  const isEvent = row.service_type === 'event';
  const isPermanentBistro = row.service_type === 'permanent_bistro';
  // Legacy Rebook (#155): ONE "Last Year's Design" package (everything on the
  // quote bundled) instead of the holiday tier ladder. Positive gate, checked
  // FIRST: the flag rides migrated HOLIDAY quotes, so the holiday fall-through
  // below would otherwise build A/B/C + the empty Build-Your-Own slot.
  const isLegacyRebook = row.legacy_rebook === true;
  // #199 F1: row.inputs?.depositPercent threaded to every branch — see
  // chargesFromResult's own comment (derivePackages.ts) for why the live
  // input must win over a possibly-stale result.depositRate.
  const allPackages = isLegacyRebook
    ? derivePackagesLegacyRebook(lineItems, row.result, row.inputs?.depositPercent)
    : isPermanent
      ? derivePackagesPermanent(lineItems, row.result, row.inputs?.depositPercent)
      : isEvent
        ? derivePackagesEvent(lineItems, row.result, row.inputs?.depositPercent)
        : isPermanentBistro
          ? derivePackagesPermanentBistro(lineItems, row.result, row.inputs?.depositPercent)
          : derivePackages(lineItems, row.result, roofline, row.inputs?.depositPercent);
  // The approval gate threshold — hoisted (was inline in the return below) so
  // the package filter next uses the IDENTICAL value the approve gate enforces.
  // $1,000 for holiday/event, the permanent quote's FROZEN rate-snapshot
  // minimumJobAmount (#88 — never live app_settings, the rate-drift guard;
  // falls back to the canonical $2,500 default if a permanent result somehow
  // lacks a snapshot), or the permanent bistro quote's FROZEN rate-snapshot
  // minimum (same rate-drift guard; falls back to 0 — gate OFF — if a bistro
  // result somehow lacks a snapshot, never the holiday $1,000 default).
  // 0 when EITHER (a) staff checked "waive the minimum" on this quote (#59 —
  // inputs.waiveMinimum), or (b) the quote's items already total under the
  // minimum (the existing auto-waive in minimumOrderSubtotal()). Enforced on
  // the portal, not in pricing. Uses tierLineItems so a two-roofline quote
  // isn't double-counted.
  const approvalGate = row.inputs?.waiveMinimum
    ? 0
    : minimumOrderSubtotal(
        tierLineItems,
        isPermanent
          ? (row.result.permanentRatesSnapshot?.minimumJobAmount ?? 2500)
          : isPermanentBistro
            ? (row.result.permanentBistroRatesSnapshot?.minimum ?? 0)
            : undefined,
      );
  // #134 (Jason S24): hide any package tile the customer can't approve AS
  // TAPPED — its selection basis (pre-tax items + the default-ON rush/takedown
  // fees, the SAME basis orderMinimumStatus gates on) lands under the gate, so
  // tapping it only walks the customer into the "add $X more" wall. Gate 0
  // (staff-waived / auto-waived) hides nothing. Three carve-outs, all from the
  // S24 adversarial review of this filter:
  //   • A placeholder tile with NO items always passes — holiday's 'D' is an
  //     EMPTY recommendation slot here (applyOurRecommendation populates it
  //     LATER, in the loader); filtering it out silently killed the whole #12
  //     staff-recommendation flow + the "Build Your Own" card. Tapping an
  //     empty D is a selection no-op, so it can never be a below-min trap.
  //   • Default-ON fees count toward the basis (orderMinimumStatus counts the
  //     live fee toggles, which seed from these defaults — a tile that clears
  //     the gate WITH the staff-seeded rush fee is approvable as tapped).
  //   • If filtering would remove EVERY real tile (reachable when the
  //     maintenance add-on lifts the quote past auto-waive while sitting in
  //     no package), keep them all — a portal with zero tiles is worse than
  //     below-min tiles, and the "tiles never all vanish" invariant holds.
  // #199 F1: this IS the live portal's `charges` prop (see `charges:
  // { ...jobCharges, manualDiscount }` below) — SelectionContext reads
  // jobCharges.depositRate directly as the customer's displayed pre-approval
  // deposit rate, so this is the critical call site for the NCE-tag-inert bug.
  const jobCharges = chargesFromResult(row.result, row.inputs?.depositPercent);
  const defaultOnFees =
    (jobCharges.rush.defaultOn ? jobCharges.rush.amount : 0) +
    (jobCharges.takedown.defaultOn ? jobCharges.takedown.amount : 0);
  const priceById = new Map(lineItems.map((li) => [li.id, li.price]));
  let packages = allPackages;
  if (approvalGate > 0) {
    const kept = allPackages.filter((pkg) => {
      if (pkg.includedItemIds.length === 0) return true; // placeholder slot (holiday 'D')
      const subtotal = pkg.includedItemIds.reduce((sum, id) => sum + (priceById.get(id) ?? 0), 0);
      return subtotal + defaultOnFees >= approvalGate;
    });
    packages = kept.some((pkg) => pkg.includedItemIds.length > 0) ? kept : allPackages;
  }
  // Same-price tier dedupe (operator screenshot: Tier 2 "Full Festive" and
  // Tier 3 "The Full Yule" both priced $2,185.88 — two identical-looking cards
  // confused the customer). Runs AFTER the #134 gate filter above, so equality
  // is judged only among tiles that would actually render. Keeps the FIRST of
  // any equal-priced run (A before B before C), so A===B===C collapses to just
  // A — this can never violate the "packages never all vanish" invariant above,
  // since the first of any tie is always kept. Three scope guards:
  //   • HOLIDAY ONLY (positive seam gate): holiday's A/B/C is a cumulative
  //     price ladder, where a tie means two identical-looking tiles. Permanent
  //     reuses the SAME letter ids for mutually-exclusive surfaces (Front /
  //     Front & Sides / Back) that legitimately tie on a symmetric house and
  //     are different products — never hide those. Event/bistro/legacy-rebook
  //     and any future vertical likewise never dedupe.
  //   • Package D (the empty Build-Your-Own placeholder, or a non-empty staff
  //     recommendation) is NEVER hidden here, same carve-out as #134.
  //   • The customer's APPROVED package is never hidden: the frozen approval
  //     seed points at it by id, and hiding it collapses the booked portal to
  //     an empty selection — the $0-portal failure pickFallbackApprovalPackageId
  //     exists to prevent. (Its total still counts as seen, so a later tile
  //     tying the approved one still dedupes.)
  if ((row.service_type ?? 'holiday') === 'holiday') {
    const approvedPackageId = row.customer_approved_at
      ? row.approval_snapshot?.customerSelection?.packageId
      : undefined;
    const seenPresetTotals = new Set<number>();
    packages = packages.filter((pkg) => {
      if (pkg.id !== 'A' && pkg.id !== 'B' && pkg.id !== 'C') return true;
      if (pkg.id === approvedPackageId) {
        seenPresetTotals.add(pkg.total);
        return true;
      }
      if (seenPresetTotals.has(pkg.total)) return false;
      seenPresetTotals.add(pkg.total);
      return true;
    });
  }
  // Computed up front so the seeded install-timing can prefer the customer's
  // APPROVED choice on a booked quote over the staff default (#40) — otherwise a
  // locked, approved portal could show a price based on the staff's offer rather
  // than what the customer actually confirmed.
  const approval = buildApproval(row, packages, invoiceTaxOverridden);
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
    customerId: row.customer_id ?? undefined,
    customer: {
      firstName: deriveFirstName(row.customer_name),
      fullName: row.customer_name ?? 'Anonymous',
      address: row.customer_address ?? '',
      // Ledger #87(a): the customer PDFs' RECIPIENT block. Already selected
      // by loadPortalQuote's query — just not previously mapped through.
      phone: row.customer_phone ?? '',
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
    charges: { ...jobCharges, manualDiscount },
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
    // Legacy rebook (#155): quote migrated from last year's Jobber data —
    // drives the Light Color band's rebook copy + the read-only What's
    // Included list. Positive gate; every other quote reads false.
    legacyRebook: row.legacy_rebook === true,
    // View-only portal (#176): drives the sticky bar's browsing-only strip.
    // Positive gate; every other quote reads false.
    viewOnly: row.view_only === true,
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
