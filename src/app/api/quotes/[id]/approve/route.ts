// Customer-triggered quote approval.
// Called when the customer clicks "Approve" on the portal.
//
// POST /api/quotes/[id]/approve
// Body:
//   {
//     packageId: 'A'|'B'|'C'|'D',        // which package the customer landed on
//     selectedItemIds: string[],          // which line items are selected
//     activeName: string,                 // package display name ("Build Your Own" etc.)
//     currentTotal: number,               // dollars, what the customer saw
//     currentDeposit: number,             // dollars, the 50% deposit
//     rushSelected: boolean,              // customer's rush add-on toggle (#4)
//     takedownSelected: boolean,          // customer's premium-takedown toggle (#4)
//   }
// Response:
//   { ok: true, approvedAt: ISO, customerSmsSent, customerEmailSent, internalEmailSent }
//   { error: string, code?: string }
//
// Auth model: none. The quote ID itself (a 128-bit random UUID) is the
// capability token — if you have the URL, you can approve. This matches
// every other "shareable link" pattern (Stripe invoice links, DocuSign,
// Calendly booking confirmations).
//
// Idempotency: if customer_approved_at is already set, returns 409 with
// the prior approvedAt. The UI treats this as "already booked" — not an
// error — and routes the customer to /portal/[id]/approved anyway. This
// also guarantees the notifications below fire at most once.
//
// TEMPORARY (pre-Valor) deposit flow — what happens here:
//   1. Load quote row from DB
//   2. Build + save the approval_snapshot + customer_approved_at FIRST, so the
//      approval is never lost even if the messaging below fails
//   3. Text + email the CUSTOMER: "you're approved — we'll reach out to collect
//      your 50% deposit and lock in your install date"
//   4. Email OURSELVES (the sales@ GHL contact) to go collect the deposit
//   All messaging is best-effort and non-fatal. Per Jason there is NO GHL stage
//   move on approve — the card stays at "Bid Sent"; the internal email is the
//   staff signal. When Valor lands (#38), the payment step runs before this and
//   the receipt + any GHL move fire on payment-confirmed instead.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  sendSms,
  sendEmail,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import {
  APPROVAL_EMAIL_SUBJECT,
  approvalSmsBody,
  approvalEmailHtml,
  internalApprovalEmailSubject,
  internalApprovalEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { canTransition, deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import {
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  isKnownColorSchemeId,
  isPermanentColorSchemeId,
  PERMANENT_COLOR_SCHEMES,
  sanitizeCustomPattern,
} from '@/lib/design/colorSchemes';
import { getAppSettings } from '@/lib/appSettings';
import { resolveColorChoice } from '@/lib/inventory/resolveInstalls';
import { isValorCheckoutEnabled } from '@/lib/integrations/valorCheckout';
import type { QuoteInputs, QuoteResult } from '@/lib/pricing/pricingEngine';
// Audit fix (g1-route): server-side recompute of the approved selection mirrors
// exactly what the portal's SelectionContext displays, so we never freeze a
// client-tampered total/deposit/discount into the authoritative snapshot.
import { buildPortalLineItems } from '@/lib/portal/adapter';
import {
  chargesFromResult,
  effectiveCharges,
  priceSelection,
  installDiscountRate,
  minimumOrderSubtotal,
  orderMinimumStatus,
} from '@/lib/portal/derivePackages';
// #110 W1-064: shared plain round-to-cents (was copy-pasted here / derivePackages).
// Aliased to `round2` so call sites are byte-identical.
import { roundMoney as round2 } from '@/lib/money';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  total: number | null;
  result: QuoteResult | null;
  // The saved pricing inputs (jsonb) — needed for the server recompute: the
  // per-item `recommended` flag (custom rows), the staff manual discount, and
  // the waive-minimum override all live here (audit fix g1-route).
  inputs: QuoteInputs | null;
  highlevel_contact_id: string | null;
  customer_approved_at: string | null;
  // Bug fix (B2): needed for the status gate — we must derive the current
  // status and reject illegal transitions (declined/cancelled/lost can't
  // be re-approved).
  status: QuoteStatus | null;
  deposit_paid_at: string | null;
  viewed_at: string | null;
  // #93 — whether staff sent the quote before this approval. Recorded as a
  // snapshot flag so a deliberate in-person close is distinguishable from a
  // stray pre-send approval on a leaked link (audit fix g1-route).
  quote_sent_at: string | null;
  // Test Quote (ledger #93, the same task): true ⇒ record the approval snapshot
  // but suppress every customer/staff notification (simulated approval).
  is_test: boolean;
  // #88 Permanent Lighting: 'permanent' forces holiday fees off in the server
  // recompute + gates on the frozen rate-snapshot minimum instead of $1,000.
  service_type: string | null;
};

type ApproveBody = {
  packageId?: 'A' | 'B' | 'C' | 'D';
  selectedItemIds?: string[];
  activeName?: string;
  currentTotal?: number;
  currentDeposit?: number;
  rushSelected?: boolean;
  takedownSelected?: boolean;
  colorSchemeId?: string;
  customPattern?: unknown; // #49 — build-your-own pattern (sanitized server-side)
  installTiming?: 'none' | 'september' | 'october';
  installDiscountUsd?: number;
  // #83 Slice B — optional e-signature captured at approval. Backward-compatible:
  // older portal clients omit it and the snapshot records signature: null.
  signature?: unknown;
};

// #83 Slice B — the e-signature record frozen into approval_snapshot.signature.
// kind 'typed' = the customer typed their name; 'drawn' = a canvas data-URL.
// signed_at + ip are server-stamped (never client-trusted). null when no
// signature was provided.
type SignatureSnapshot = {
  name: string;
  kind: 'typed' | 'drawn';
  value: string;
  signed_at: string; // ISO timestamp (server)
  ip: string | null; // from x-forwarded-for / x-real-ip, best-effort
};

const SIGNATURE_NAME_MAX = 200;
// A drawn signature is a base64 PNG/JPEG data-URL; a typed one is just the name.
// Cap the value so a giant canvas export can't bloat the row (a normal small
// signature canvas PNG is well under this).
const SIGNATURE_VALUE_MAX = 200_000;

/**
 * Parse + validate the optional signature from the request body.
 * Returns:
 *   - { ok: true, signature: null }            when none was provided (back-compat)
 *   - { ok: true, signature: SignatureSnapshot } when a valid one was provided
 *   - { ok: false }                            when one was provided but malformed
 * server-stamps signed_at + ip (caller passes the request ip).
 */
function parseSignature(
  raw: unknown,
  ip: string | null,
): { ok: true; signature: SignatureSnapshot | null } | { ok: false } {
  if (raw == null) return { ok: true, signature: null };
  if (typeof raw !== 'object') return { ok: false };
  const s = raw as Record<string, unknown>;
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  const kind = s.kind;
  const value = typeof s.value === 'string' ? s.value.trim() : '';
  if (!name || name.length > SIGNATURE_NAME_MAX) return { ok: false };
  if (kind !== 'typed' && kind !== 'drawn') return { ok: false };
  if (!value || value.length > SIGNATURE_VALUE_MAX) return { ok: false };
  return {
    ok: true,
    signature: { name, kind, value, signed_at: new Date().toISOString(), ip },
  };
}

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim() || null;
  return req.headers.get('x-real-ip')?.trim() || null;
}

// The snapshot shape — stored in the approval_snapshot jsonb column.
// Kept self-describing so when we read it later we know what it contains
// without cross-referencing code. Not exported because nothing else reads
// this type right now — admin UI can treat it as `unknown` for display.
type ApprovalSnapshot = {
  version: 1;
  approvedAt: string;              // ISO timestamp
  customerSelection: {
    packageId: 'A' | 'B' | 'C' | 'D';
    activeName: string;
    selectedItemIds: string[];
    currentTotalUsd: number;
    currentDepositUsd: number;
    rushSelected: boolean;      // #4 — customer's rush add-on choice
    takedownSelected: boolean;  // #4 — customer's premium-takedown choice
    colorSchemeId: string;      // #10 — customer's light color/pattern choice
    customPattern: string[];    // #49 — build-your-own pattern (color ids), [] unless colorSchemeId === 'custom'
    colorIds: string[] | null;  // #101 — the RESOLVED effective colors, frozen at approve-time (null = as-designed) so a later swatch edit can't retro-change this order's materials
    installTiming: 'none' | 'september' | 'october'; // #40 — early-install choice
    installDiscountUsd: number; // #40 — dollars discounted by the early-install choice
  };
  // Audit fix (g1-route): set when the server could NOT recompute the selection
  // (quote.result was null) and fell back to the client-supplied figures. The
  // figures above are then NOT server-verified — staff/dashboard should treat
  // them with caution. False/absent on a normal recomputed approval.
  serverRecomputed: boolean;
  // #93 — true when the customer approved a quote staff had not yet "sent".
  // NOT a block (the dashboard supports a deliberate offline/in-person close);
  // a marker so staff can distinguish that from a stray pre-send approval.
  approvedWhileUnsent: boolean;
  customer: {
    fullName: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  // Full pricing result as it existed at approval time. If an admin
  // later edits the quote, this snapshot remembers the original.
  pricing: QuoteResult | null;
  // #83 Slice B — the e-signature the customer gave at approval (typed or drawn).
  // null when none was captured (older clients / not provided). The signature
  // attests to this exact frozen snapshot.
  signature: SignatureSnapshot | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }

  // Modest rate limit — a customer isn't going to click this 20×/min,
  // but we want to stop bots from spamming the endpoint.
  const rl = rateLimitResponse(req, { bucket: 'quote-approve', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: ApproveBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate the selection shape. We allow light defaulting because the
  // portal might send a partial selection (e.g., currentTotal missing if
  // client-side state hasn't settled) — but the packageId must be present.
  const packageId = body.packageId;
  if (packageId !== 'A' && packageId !== 'B' && packageId !== 'C' && packageId !== 'D') {
    return NextResponse.json({ error: 'packageId must be A, B, C, or D' }, { status: 400 });
  }
  const selectedItemIds = Array.isArray(body.selectedItemIds)
    ? body.selectedItemIds.filter((x): x is string => typeof x === 'string').slice(0, 200)
    : [];
  const activeName = typeof body.activeName === 'string' ? body.activeName.slice(0, 200) : '';
  const currentTotal = typeof body.currentTotal === 'number' && body.currentTotal >= 0 ? body.currentTotal : 0;
  const currentDeposit = typeof body.currentDeposit === 'number' && body.currentDeposit >= 0 ? body.currentDeposit : 0;
  // #4 — the customer's rush / premium-takedown add-on choices. Recorded in
  // the snapshot (the authoritative record of what they approved); the
  // toggle-inclusive amount is already in currentTotal/currentDeposit.
  const reqRushSelected = body.rushSelected === true;
  const reqTakedownSelected = body.takedownSelected === true;
  // #10 / #88 P6b-2 — load the LIVE operator swatch list now, but validate +
  // resolve the customer's light-color choice further BELOW (once service_type is
  // known): a PERMANENT quote accepts a fixed permanent-only scheme set, a holiday
  // quote the operator's live swatch list.
  const { swatches } = await getAppSettings();
  // #40 — the customer's early-install timing choice + the resulting discount.
  // Recorded in the snapshot (the authoritative record of what they approved);
  // the discounted amount is already baked into currentTotal/currentDeposit.
  const reqInstallTiming =
    body.installTiming === 'september' || body.installTiming === 'october'
      ? body.installTiming
      : 'none';
  const installDiscountUsd =
    typeof body.installDiscountUsd === 'number' && body.installDiscountUsd >= 0
      ? body.installDiscountUsd
      : 0;

  // #83 Slice B — optional e-signature. Validated up front so a malformed one
  // fails fast (400) before any DB work. Absent ⇒ signature stays null
  // (backward-compatible with older portal clients).
  const sigParse = parseSignature(body.signature, clientIp(req));
  if (!sigParse.ok) {
    return NextResponse.json(
      { error: 'Invalid signature', code: 'bad-signature' },
      { status: 400 },
    );
  }
  const signature = sigParse.signature;

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, total, result, inputs, highlevel_contact_id, customer_approved_at, status, deposit_paid_at, viewed_at, quote_sent_at, is_test, service_type',
    )
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Idempotency — customer already approved. Return 409 with prior data
  // so the client can route to the celebration page anyway. This also
  // ensures the notifications below never double-fire.
  if (quote.customer_approved_at) {
    return NextResponse.json(
      {
        error: 'Quote already approved',
        code: 'already-approved',
        approvedAt: quote.customer_approved_at,
      },
      { status: 409 },
    );
  }

  // Bug fix (B2): status machine gate — mirrors staff-approve's canTransition
  // guard. Derive the current status (explicit persisted status wins for branch/
  // terminal states; timestamps are the fallback for legacy rows). Then reject
  // when the transition to 'approved' is not legal. This closes the window where
  // a declined/cancelled/lost quote (customer_approved_at IS NULL, no guard) could
  // be re-approved + re-booked with a real deposit charge.
  const currentStatus = deriveStatus({
    quote_sent_at: quote.quote_sent_at,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
    viewed_at: quote.viewed_at,
    status: quote.status,
  });
  if (!canTransition(currentStatus, 'approved')) {
    return NextResponse.json(
      {
        error: `Quote cannot be approved from status '${currentStatus}'`,
        code: 'illegal-transition',
        currentStatus,
      },
      { status: 409 },
    );
  }

  // Permanent (#88 P6) + Event (#96 Phase B): neither vertical carries the holiday
  // rush / premium-takedown / early-install fees. Force them OFF here so a forged
  // approve body can't add a holiday fee to such an order — the same guarantee
  // calculatePermanentQuote / calculateEventQuote make at pricing time. Holiday
  // quotes use the customer's requested toggles unchanged. These effective values
  // flow into the recompute AND the frozen approval snapshot below.
  const isPermanent = quote.service_type === 'permanent';
  const isEvent = quote.service_type === 'event';
  const noHolidayFees = isPermanent || isEvent;
  const rushSelected = noHolidayFees ? false : reqRushSelected;
  const takedownSelected = noHolidayFees ? false : reqTakedownSelected;
  const installTiming: 'none' | 'september' | 'october' = noHolidayFees ? 'none' : reqInstallTiming;

  // #10 / #88 P6b-2 — resolve + freeze the light-color choice now that we know the
  // service type. Permanent (RGB pucks) offers a FIXED curated preview set
  // (PERMANENT_COLOR_SCHEMES) — independent of the operator's holiday swatch
  // curation and with NO build-your-own — so a permanent customer's choice stays
  // valid + freezable even if staff removed 'warm-white' from the Christmas
  // swatches; holiday validates against the live operator swatch list. Either way
  // the chosen id + its RESOLVED colors are frozen into the snapshot so a later
  // Settings edit can't retro-change what THIS customer approved (#101 invariant).
  const activeSchemes = isPermanent ? PERMANENT_COLOR_SCHEMES : swatches.schemes;
  const requestedSchemeId = isPermanent
    ? isPermanentColorSchemeId(body.colorSchemeId)
      ? body.colorSchemeId
      : DEFAULT_COLOR_SCHEME_ID
    : isKnownColorSchemeId(body.colorSchemeId, swatches.schemes)
      ? body.colorSchemeId
      : DEFAULT_COLOR_SCHEME_ID;
  // Build-your-own is holiday-only; a permanent quote never carries a custom pattern.
  const customPattern =
    !isPermanent && requestedSchemeId === CUSTOM_SCHEME_ID
      ? sanitizeCustomPattern(body.customPattern, swatches.buildableColorIds)
      : [];
  // Collapse an empty custom selection back to the default so the frozen snapshot
  // is self-consistent: 'custom' with zero colors renders identically to
  // 'as-designed', so we store 'as-designed' rather than a contradictory record.
  const colorSchemeId =
    requestedSchemeId === CUSTOM_SCHEME_ID && customPattern.length === 0
      ? DEFAULT_COLOR_SCHEME_ID
      : requestedSchemeId;

  // ── Server-side recompute (audit fix g1-route, merge of #12/#13/#30/#31/
  // #39/#63/#74/#79) ────────────────────────────────────────────────────────
  // The client POSTs currentTotal/currentDeposit/installDiscountUsd/selectedItem-
  // Ids, but those are customer-controllable and this snapshot is the
  // authoritative record (echoed back to the customer AND the staff "go collect
  // the deposit" email). So we recompute the figures server-side, mirroring the
  // portal's SelectionContext exactly: rebuild the line items from quote.result,
  // intersect the selection against the REAL ids, derive the discount, and price
  // via the same priceSelection() the portal renders. The client numbers are
  // only used as a sanity check (warn on divergence) and as a fallback when the
  // quote has no pricing result.
  //
  // #15 — the $1,000 order-minimum is enforced here too, against the server
  // subtotal (it was previously client-only / bypassable via a direct POST).
  let serverRecomputed = false;
  let snapshotSelectedItemIds = selectedItemIds;
  let snapshotTotalUsd = currentTotal;
  let snapshotDepositUsd = currentDeposit;
  let snapshotInstallDiscountUsd = installDiscountUsd;

  if (quote.result) {
    const { lineItems, roofline } = buildPortalLineItems(quote.result, quote.inputs);
    const realIds = new Set(lineItems.map((li) => li.id));
    // Drop any unknown / tampered ids the client sent (#13/#31).
    const validIds = selectedItemIds.filter((sid) => realIds.has(sid));
    const selectedSet = new Set(validIds);
    const serverSubtotal = lineItems.reduce(
      (sum, li) => (selectedSet.has(li.id) ? sum + li.price : sum),
      0,
    );

    // Discount: one per quote — a staff manual discount (#40) OR the customer's
    // early-install pick — same precedence the portal uses (manual wins, picker
    // hidden). installDiscountUsd is derived from the server subtotal, never the
    // client value.
    const d = quote.inputs?.discount;
    const hasManual = !!d && d.amount > 0;
    const discountRate = hasManual
      ? d!.type === 'percentage'
        ? d!.amount
        : 0
      : installDiscountRate(installTiming);
    const discountFlat = hasManual && d!.type === 'flat' ? d!.amount : 0;
    // Bug fix (audit W4-017): mirror the SAME hasManual guard used for discountRate
    // above. A manual staff discount wins over the early-install pick (one discount
    // per quote), so when hasManual is true the install discount was NEVER applied
    // to the price — stamping a non-zero installDiscountUsd here would freeze a
    // dollar figure into the snapshot that doesn't match what was actually billed.
    snapshotInstallDiscountUsd =
      hasManual || installTiming === 'none'
        ? 0
        : round2(serverSubtotal * installDiscountRate(installTiming));

    const config = chargesFromResult(quote.result);
    const breakdown = priceSelection(
      serverSubtotal,
      effectiveCharges(config, rushSelected, takedownSelected, discountRate, discountFlat),
    );

    // #15 — order-minimum gate. The minimum auto-waives for a quote whose items
    // total under $1,000, and staff can waive it per-quote (inputs.waiveMinimum).
    // We measure the same pre-tax basis (subtotal + fees) the portal gates on.
    //
    // Audit fix (g1-route): the THRESHOLD must be derived from the SAME line-item
    // set the portal uses (adapter.ts ~319). The portal sums `tierLineItems` —
    // the full list with the NON-recommended roofline option dropped — so a quote
    // offering both Santa's + Gingerbread isn't double-counted into clearing a
    // minimum the customer can only pick one roofline toward. Summing the full
    // `lineItems` here (both rooflines) could push a quote's total >= $1,000 and
    // make the server REJECT an approval the portal would have auto-waived and
    // ALLOWED — server stricter than portal, exactly the disagreement to avoid.
    // Mirror the portal's filter so the gates can never diverge.
    const tierLineItems = roofline
      ? lineItems.filter(
          (li) => !(roofline.itemIds.includes(li.id) && li.id !== roofline.recommendedItemId),
        )
      : lineItems;
    // Permanent (#88 H3): gate on the FROZEN rate-snapshot minimum ($2,500 default),
    // never live settings — the same threshold the portal adapter uses. Holiday
    // passes undefined → the $1,000 BUSINESS_RULES default.
    const minimum = quote.inputs?.waiveMinimum
      ? 0
      : minimumOrderSubtotal(
          tierLineItems,
          isPermanent ? (quote.result.permanentRatesSnapshot?.minimumJobAmount ?? 2500) : undefined,
        );
    const { meetsMinimum } = orderMinimumStatus(breakdown, minimum);
    if (!meetsMinimum) {
      return NextResponse.json(
        { error: 'Selection is below the order minimum', code: 'below-minimum' },
        { status: 400 },
      );
    }

    // Reject a junk / empty selection that prices to nothing.
    if (breakdown.total <= 0 || breakdown.deposit <= 0) {
      return NextResponse.json(
        { error: 'Selection has no priceable items', code: 'empty-selection' },
        { status: 400 },
      );
    }

    // Warn (don't fail) when the client total disagrees by more than a cent —
    // surfaces a portal⇄server pricing drift without blocking a real customer.
    if (Math.abs(breakdown.total - currentTotal) > 0.01) {
      console.warn(
        '[api/quotes/:id/approve] client/server total mismatch:',
        id,
        'client=',
        currentTotal,
        'server=',
        breakdown.total,
      );
    }

    serverRecomputed = true;
    snapshotSelectedItemIds = validIds;
    snapshotTotalUsd = breakdown.total;
    snapshotDepositUsd = breakdown.deposit;
  }

  // Freeze the approval snapshot FIRST, before any messaging. This preserves
  // the customer's consent even if the notifications below fail — we never
  // want to lose the fact that they approved.
  const approvedAt = new Date().toISOString();
  const snapshot: ApprovalSnapshot = {
    version: 1,
    approvedAt,
    customerSelection: {
      packageId,
      activeName,
      // All four figures below are the server-recomputed values when
      // quote.result existed (serverRecomputed === true); otherwise they fall
      // back to the validated client values (serverRecomputed === false).
      selectedItemIds: snapshotSelectedItemIds,
      currentTotalUsd: snapshotTotalUsd,
      currentDepositUsd: snapshotDepositUsd,
      rushSelected,
      takedownSelected,
      colorSchemeId,
      customPattern,
      // #101 — freeze the resolved colors (from the active scheme list — permanent
      // or holiday) so #92 materials always match what the customer saw, even
      // after a Settings edit.
      colorIds: resolveColorChoice(colorSchemeId, customPattern, activeSchemes),
      installTiming,
      installDiscountUsd: snapshotInstallDiscountUsd,
    },
    serverRecomputed,
    approvedWhileUnsent: !quote.quote_sent_at,
    customer: {
      fullName: quote.customer_name,
      address: quote.customer_address,
      phone: quote.customer_phone,
      email: quote.customer_email,
    },
    pricing: quote.result,
    signature,
  };

  // Audit fix (g1-route, #43): GUARDED conditional update closes the read-then-
  // write TOCTOU. The early SELECT above is a fast-path 409; this `.is(...,null)`
  // makes the write itself the race winner — two concurrent POSTs that both
  // passed the SELECT can't both land here, because only the first matches the
  // `customer_approved_at IS NULL` predicate. `.select('id')` returns the
  // affected rows so we can tell whether WE won.
  //
  // Bug fix (B2): also exclude terminal states in the atomic write so a
  // concurrent decline/cancel that fires between our SELECT and this UPDATE
  // can't be raced past. A row whose status just moved to 'declined',
  // 'cancelled', or 'lost' will no longer match and we get 0 updated rows →
  // safe 409 for the concurrent caller.
  //
  // Bug fix (W1-014): use the OR-with-null idiom instead of a bare `.not('status',
  // 'in', …)`. In Postgres `NOT (status IN (…))` evaluates to NULL — not TRUE —
  // when status IS NULL, so a bare `.not` filter SILENTLY EXCLUDES legacy/NULL-
  // status rows, matching 0 rows and returning a false 409 with nothing recorded
  // (the deriveStatus fast path already admits NULL rows, so the two disagreed).
  // `.or('status.not.in.(…),status.is.null')` explicitly admits the NULL-status
  // row while still excluding the terminal states — the same idiom the decline
  // route uses (decline/route.ts) to guard its own NULL-status rows.
  const { data: updatedRows, error: snapshotErr } = await sb
    .from('quotes')
    .update({
      customer_approved_at: approvedAt,
      approval_snapshot: snapshot,
      // Advance the explicit lifecycle status alongside the timestamp (ledger
      // #83). The deposit webhook flips it to 'booked' on payment; until then an
      // approved-not-yet-paid quote reads 'approved'.
      status: 'approved',
    })
    .eq('id', id)
    .is('customer_approved_at', null)
    .or('status.not.in.("declined","cancelled","lost"),status.is.null')
    .select('id');

  if (snapshotErr) {
    console.error('[api/quotes/:id/approve] snapshot save failed:', snapshotErr);
    return NextResponse.json(
      { error: `Failed to record approval: ${snapshotErr.message}` },
      { status: 500 },
    );
  }

  // No rows updated → another concurrent caller won the approval race. Return
  // 409 and SKIP all messaging so the notifications fire at most once.
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json(
      { error: 'Quote already approved', code: 'already-approved' },
      { status: 409 },
    );
  }

  // Approval is now recorded. Notify the customer and ourselves — all
  // best-effort, because a messaging hiccup must never undo the approval.
  let customerSmsSent = false;
  let customerEmailSent = false;
  let internalEmailSent = false;
  let messageError: string | undefined;

  // Test Quote (#93): suppress ALL real notifications (customer SMS/email AND
  // the internal "go collect the deposit" staff email). The approval snapshot
  // above is still written — that's the authoritative record the simulated
  // portal flow needs; only the external messaging is skipped.
  if (!quote.is_test && isHighLevelConfigured()) {
    const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    const portalUrl = `${baseUrl}/portal/${id}`;
    const adminUrl = `${baseUrl}/quote/${id}`;
    const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
    // Audit fix (g1-route): use the SAME recomputed figures we froze into the
    // snapshot, not quote.result's whole-quote total/deposit. The snapshot is
    // the per-SELECTION price the customer approved; the internal "go collect
    // the deposit" email must quote that same number, not a divergent one.
    const depositUsd = snapshotDepositUsd;
    const totalUsd = snapshotTotalUsd;

    // 1. Customer — confirm approval + that we'll reach out for the deposit.
    //    SMS needs the contact to have a phone (real customers do); a 422 there
    //    is non-fatal. Both messages land in the GHL Conversations tab.
    //    #38: SKIPPED when the embedded checkout is ON — the customer pays their
    //    deposit online next and gets their receipt from the payment-confirmed
    //    webhook instead, so this "we'll reach out to collect it" message would
    //    be wrong. With the checkout OFF (today) it fires as the placeholder.
    if (!isValorCheckoutEnabled() && quote.highlevel_contact_id) {
      try {
        await sendSms({
          contactId: quote.highlevel_contact_id,
          message: approvalSmsBody(firstName, depositUsd, phone),
          fromNumber,
        });
        customerSmsSent = true;
      } catch (err) {
        console.warn('[api/quotes/:id/approve] customer SMS failed:', hlErrorMessage(err));
        messageError = hlErrorMessage(err);
      }
      try {
        await sendEmail({
          contactId: quote.highlevel_contact_id,
          subject: APPROVAL_EMAIL_SUBJECT,
          html: approvalEmailHtml(firstName, depositUsd, portalUrl, phone),
          emailFrom,
        });
        customerEmailSent = true;
      } catch (err) {
        console.warn('[api/quotes/:id/approve] customer email failed:', hlErrorMessage(err));
        messageError = (messageError ? `${messageError}; ` : '') + hlErrorMessage(err);
      }
    }

    // 2. Ourselves — email the "go collect the deposit" notification to the
    //    internal GHL contact (sales@, HIGHLEVEL_INTERNAL_CONTACT_ID). Skipped
    //    cleanly if the var isn't set.
    //    #38: SKIPPED when the online checkout is ON — staff shouldn't get an
    //    "approved, go collect" email on the click. The customer pays online
    //    next, and the webhook sends the staff "✅ deposit received" alert on the
    //    actual payment instead. With checkout OFF (placeholder) it still fires.
    const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    if (!isValorCheckoutEnabled() && internalContactId) {
      try {
        await sendEmail({
          contactId: internalContactId,
          subject: internalApprovalEmailSubject(quote.customer_name),
          html: internalApprovalEmailHtml({
            customerName: quote.customer_name,
            address: quote.customer_address,
            phone: quote.customer_phone,
            email: quote.customer_email,
            totalUsd,
            depositUsd,
            packageName: activeName || `Package ${packageId}`,
            installTiming,
            rushSelected,
            takedownSelected,
            portalUrl,
            adminUrl,
          }),
          emailFrom,
        });
        internalEmailSent = true;
      } catch (err) {
        console.warn('[api/quotes/:id/approve] internal email failed:', hlErrorMessage(err));
        messageError = (messageError ? `${messageError}; ` : '') + hlErrorMessage(err);
      }
    }
  }

  // Audit fix (g1-route, #18/#83): durable staff signal when the approval was
  // recorded but the internal "go collect the deposit" email never went out —
  // GHL unconfigured, HIGHLEVEL_INTERNAL_CONTACT_ID unset, or a thrown send. The
  // ok:true response goes to the customer's browser, not staff, so without this
  // marker an orphaned approval (deposit owed, nobody told) is invisible. A
  // future dashboard queue surfaces these rows (separate Naldo task). The marker
  // write is itself best-effort — its failure only logs, never undoes anything.
  // Skipped cleanly when the embedded checkout is on (no internal email is sent
  // on approve then; the payment webhook is the staff signal instead).
  // Test Quote (#93): a suppressed internal email is EXPECTED, not a failure —
  // never write the orphaned-approval marker for a simulated approval.
  const notifyOk = isValorCheckoutEnabled() || internalEmailSent;
  if (!notifyOk && !quote.is_test) {
    const { error: markErr } = await sb
      .from('quotes')
      .update({
        approval_notify_failed_at: new Date().toISOString(),
        approval_notify_error: messageError ?? 'internal notification not sent',
      })
      .eq('id', id);
    if (markErr) {
      console.warn('[api/quotes/:id/approve] notify-marker write failed:', markErr.message);
    }
  }

  return NextResponse.json({
    ok: true,
    approvedAt,
    customerSmsSent,
    customerEmailSent,
    internalEmailSent,
    messageError,
  });
}
