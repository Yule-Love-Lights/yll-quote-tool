import { NextRequest, NextResponse } from 'next/server';
import { calculateQuote, QuoteInputs, MINI_LIGHT_TYPES } from '@/lib/pricing/pricingEngine';
import { saveQuote, updateQuote, getQuoteRaw, Customer } from '@/lib/quotes';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { getDesign, isValidDesignId } from '@/lib/designs';
import { applyProjectionToInputs } from '@/lib/design/projectScene';
import { asServiceType, DEFAULT_SERVICE_TYPE, type ServiceType } from '@/lib/serviceType';
import { calculatePermanentQuote } from '@/lib/permanent/pricing';
import { calculateEventQuote } from '@/lib/event/pricing';
import { getAppSettings } from '@/lib/appSettings';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
const VALID_TAKEDOWNS = ['included', 'premium'];
// Permanent Lighting (#88): the enum track fields on the permanent block.
const PERM_TRACK_STYLES = new Set(['single', 'parapet']);
const PERM_TRACK_COLORS = new Set(['9003', '9004', '9012', '8019']);

// Audit fix (quote-route-validation): strict canonical UUID match. The old
// loose /^[0-9a-f-]{36}$/i accepted 36 dashes or 36 hex chars, mis-routing
// save-vs-update. Anchor to the real 8-4-4-4-12 shape so only a genuine quote
// id triggers an in-place update.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Audit fix (quote-route-validation): cap per-unit input arrays so a
// multi-megabyte junk array can't be cast to QuoteInputs + persisted as jsonb
// or fed to calculateQuote. 500 is far above any real quote.
const MAX_ARRAY_LEN = 500;

// #102: per-quote custom $/ft override cap. A roofline/stake $/ft is realistically
// single-to-low-double digits; 1000 is far above any real rate and just blocks
// absurd/overflow values (the engine separately ignores ≤0/NaN, falling back to
// the difficulty table).
const MAX_CUSTOM_RATE = 1000;

// #104: per-quote line-TOTAL override caps. A line total (roofline can be a few
// thousand) is realistically well under this; the cap just blocks absurd/overflow
// values. reason is a short staff note.
const MAX_OVERRIDE_AMOUNT = 1_000_000;
const MAX_OVERRIDE_REASON_LEN = 500;

// Audit fix (quote-route-validation): allowed enum sets for the typed per-unit
// arrays, mirroring the pricingEngine types. A malformed element is a clean 400
// instead of an opaque downstream 500.
// W1-002: derive the valid set from the engine's canonical MINI_LIGHT_TYPES so
// this can never drift narrow of the MiniLightItem['type'] union again (the old
// hand-written Set was missing 'curtain', 400ing any design-linked quote with a
// curtain group on re-price).
const VALID_MINILIGHT_TYPES: ReadonlySet<string> = new Set(MINI_LIGHT_TYPES);
const VALID_MINILIGHT_WRAP_STYLES = new Set(['canopy', 'trunk']);
const VALID_SPRITZER_SIZES = new Set(['16', '24', '32']);
const VALID_WREATH_SIZES = new Set(['24noble', '30noble', '36noble', '48noble', '60noble', '72noble']);
const VALID_GARLAND_LENGTHS = new Set(['4.5ft', '9ft']);
const VALID_GARLAND_TYPES = new Set(['noble']);
const VALID_DECOR_TIERS = new Set(['bow', 'fullDecor']);

// W1-003: statuses whose totals are LOCKED against an in-place re-price. A booked
// (deposit-paid) order's totals can only change through the amend flow
// (/api/quotes/[id]/amend), which appends the amendment trail, re-syncs the
// invoice, and re-triggers customer consent; a terminal quote is closed. A plain
// what-if Calculate on such a quote must NOT silently rewrite result/total, so we
// 409 and point staff at the amend flow. (deriveStatus returns 'booked' whenever
// deposit_paid_at is set — the same booked signal the amend route itself uses.)
const REPRICE_LOCKED_STATUSES: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  'booked',
  'declined',
  'cancelled',
  'lost',
]);

function isNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const { customer, inputs, quoteId, designId, serviceType: rawServiceType, isTest: rawIsTest } =
    body as Record<string, unknown>;

  // Test Quote (ledger #93): optional boolean. Only honored on a NEW save
  // (saveQuote); the update branch never touches is_test (immutable). Anything
  // other than an explicit `true` is treated as a normal (non-test) quote.
  if (rawIsTest !== undefined && typeof rawIsTest !== 'boolean') {
    return NextResponse.json({ error: 'isTest must be a boolean if provided' }, { status: 400 });
  }
  const isTest = rawIsTest === true;

  // service_type is optional in the request; when present it must be one of
  // the known values. Absent → default to holiday on a new save, leave
  // untouched on an update (handled below).
  const serviceType = asServiceType(rawServiceType);
  if (rawServiceType !== undefined && serviceType === null) {
    return NextResponse.json(
      { error: "serviceType must be 'holiday', 'permanent', or 'event'" },
      { status: 400 },
    );
  }

  // Testing mode: customer fields (name, address, phone, email) are all
  // optional. We still accept the customer object so future fields can be
  // added without a breaking change, but we don't require any value.
  if (customer !== undefined && customer !== null && typeof customer !== 'object') {
    return NextResponse.json({ error: 'customer must be an object if provided' }, { status: 400 });
  }

  if (!inputs || typeof inputs !== 'object') {
    return NextResponse.json({ error: 'Missing quote inputs' }, { status: 400 });
  }
  const q = inputs as Record<string, unknown>;

  const footageFields = ['santasFootage', 'gingerbreadFootage', 'winterWonderlandFootage', 'stakeLightingFootage'] as const;
  for (const f of footageFields) {
    if (!isNonNegNumber(q[f])) {
      return NextResponse.json({ error: `${f} must be a non-negative number` }, { status: 400 });
    }
  }
  const difficultyFields = ['santasDifficulty', 'gingerbreadDifficulty', 'winterWonderlandDifficulty', 'stakeLightingDifficulty'] as const;
  for (const f of difficultyFields) {
    if (!VALID_DIFFICULTIES.includes(q[f] as string)) {
      return NextResponse.json({ error: `Invalid ${f}` }, { status: 400 });
    }
  }
  // #102: optional per-item-type custom $/ft. When present, must be a finite
  // number in [0, MAX_CUSTOM_RATE]; a clean 400 beats an opaque downstream NaN.
  const customRateFields = ['santasCustomRate', 'gingerbreadCustomRate', 'winterWonderlandCustomRate', 'stakeLightingCustomRate'] as const;
  for (const f of customRateFields) {
    const v = q[f];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_CUSTOM_RATE)) {
      return NextResponse.json(
        { error: `${f} must be a number between 0 and ${MAX_CUSTOM_RATE} if provided` },
        { status: 400 },
      );
    }
  }
  // #104: optional per-quote line-item TOTAL overrides — a map of stableId →
  // { amount, reason? }. Validate at the boundary so a malformed override is a
  // clean 400 rather than an opaque downstream NaN (the engine casts inputs).
  if (q.lineItemPriceOverrides !== undefined) {
    const ov = q.lineItemPriceOverrides;
    if (!isObj(ov) || Array.isArray(ov)) {
      return NextResponse.json({ error: 'lineItemPriceOverrides must be an object if provided' }, { status: 400 });
    }
    const keys = Object.keys(ov);
    if (keys.length > MAX_ARRAY_LEN) {
      return NextResponse.json({ error: 'too many lineItemPriceOverrides' }, { status: 400 });
    }
    for (const k of keys) {
      const entry = (ov as Record<string, unknown>)[k];
      if (!isObj(entry)) {
        return NextResponse.json({ error: `lineItemPriceOverrides.${k} must be an object` }, { status: 400 });
      }
      const amt = (entry as Record<string, unknown>).amount;
      if (!(typeof amt === 'number' && Number.isFinite(amt) && amt >= 0 && amt <= MAX_OVERRIDE_AMOUNT)) {
        return NextResponse.json(
          { error: `lineItemPriceOverrides.${k}.amount must be a number between 0 and ${MAX_OVERRIDE_AMOUNT}` },
          { status: 400 },
        );
      }
      const reason = (entry as Record<string, unknown>).reason;
      if (reason !== undefined && !(typeof reason === 'string' && reason.length <= MAX_OVERRIDE_REASON_LEN)) {
        return NextResponse.json(
          { error: `lineItemPriceOverrides.${k}.reason must be a string ≤ ${MAX_OVERRIDE_REASON_LEN} chars` },
          { status: 400 },
        );
      }
    }
  }

  if (!Array.isArray(q.miniLightItems) || !Array.isArray(q.spritzers) ||
      !Array.isArray(q.wreaths) || !Array.isArray(q.garland)) {
    return NextResponse.json({ error: 'miniLightItems, spritzers, wreaths, and garland must be arrays' }, { status: 400 });
  }
  if (q.customLineItems !== undefined && !Array.isArray(q.customLineItems)) {
    return NextResponse.json({ error: 'customLineItems must be an array if provided' }, { status: 400 });
  }
  if (q.bows !== undefined && !Array.isArray(q.bows)) {
    return NextResponse.json({ error: 'bows must be an array if provided' }, { status: 400 });
  }

  // Audit fix (quote-route-validation): bound every input array so a giant
  // junk payload can't be persisted as jsonb / fed to the pricing engine.
  const arrayFields = ['miniLightItems', 'spritzers', 'wreaths', 'garland', 'customLineItems', 'bows'] as const;
  for (const f of arrayFields) {
    const arr = q[f];
    if (Array.isArray(arr) && arr.length > MAX_ARRAY_LEN) {
      return NextResponse.json({ error: `${f} exceeds the ${MAX_ARRAY_LEN}-item limit` }, { status: 400 });
    }
  }

  // Audit fix (quote-route-validation): validate the shape of each element in
  // the typed per-unit arrays so a malformed element is a clean 400 instead of
  // an opaque 500 from calculateQuote. (customLineItems/bows are left to the
  // pricingEngine, which already filters them.)
  for (const item of q.miniLightItems as unknown[]) {
    if (!isObj(item) || !VALID_MINILIGHT_TYPES.has(item.type as string) ||
        !VALID_MINILIGHT_WRAP_STYLES.has(item.wrapStyle as string) ||
        !isNonNegNumber(item.stringCount)) {
      return NextResponse.json({ error: 'Invalid miniLightItems element' }, { status: 400 });
    }
  }
  for (const item of q.spritzers as unknown[]) {
    if (!isObj(item) || !VALID_SPRITZER_SIZES.has(item.size as string) ||
        !isNonNegNumber(item.quantity)) {
      return NextResponse.json({ error: 'Invalid spritzers element' }, { status: 400 });
    }
  }
  for (const item of q.wreaths as unknown[]) {
    if (!isObj(item) || !VALID_WREATH_SIZES.has(item.size as string) ||
        !VALID_DECOR_TIERS.has(item.tier as string) || !isNonNegNumber(item.quantity)) {
      return NextResponse.json({ error: 'Invalid wreaths element' }, { status: 400 });
    }
  }
  for (const item of q.garland as unknown[]) {
    if (!isObj(item) || !VALID_GARLAND_LENGTHS.has(item.length as string) ||
        !VALID_GARLAND_TYPES.has(item.type as string) ||
        !VALID_DECOR_TIERS.has(item.tier as string) || !isNonNegNumber(item.quantity)) {
      return NextResponse.json({ error: 'Invalid garland element' }, { status: 400 });
    }
  }

  if (!VALID_TAKEDOWNS.includes(q.takedown as string)) {
    return NextResponse.json({ error: 'Invalid takedown value' }, { status: 400 });
  }
  if (typeof q.rushFee !== 'boolean') {
    return NextResponse.json({ error: 'rushFee must be a boolean' }, { status: 400 });
  }

  // Permanent Lighting (#88): validate the optional permanent block at the
  // boundary so a malformed footage/track value is a clean 400, not an opaque
  // downstream NaN. Validated whenever present (independent of serviceType) —
  // the pricing engine also sanitizes, but a typed 400 beats a bad result.
  if (q.permanent !== undefined) {
    if (!isObj(q.permanent)) {
      return NextResponse.json({ error: 'permanent must be an object if provided' }, { status: 400 });
    }
    const pf = q.permanent;
    const permNumFields = [
      'frontFootage', 'leftFootage', 'rightFootage', 'backFootage',
      'frontCorners', 'leftCorners', 'rightCorners', 'backCorners', 'controllerToFirstLightFt',
    ] as const;
    for (const f of permNumFields) {
      if (!isNonNegNumber(pf[f])) {
        return NextResponse.json({ error: `permanent.${f} must be a non-negative number` }, { status: 400 });
      }
    }
    if (!PERM_TRACK_STYLES.has(pf.trackStyle as string)) {
      return NextResponse.json({ error: "permanent.trackStyle must be 'single' or 'parapet'" }, { status: 400 });
    }
    if (!PERM_TRACK_COLORS.has(pf.trackColor as string)) {
      return NextResponse.json({ error: 'Invalid permanent.trackColor' }, { status: 400 });
    }
    if (typeof pf.blackHousing !== 'boolean' || typeof pf.maintenanceAddOn !== 'boolean') {
      return NextResponse.json({ error: 'permanent.blackHousing and permanent.maintenanceAddOn must be booleans' }, { status: 400 });
    }
    for (const f of ['frontCustomRate', 'sidesCustomRate', 'backCustomRate'] as const) {
      const v = pf[f];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_CUSTOM_RATE)) {
        return NextResponse.json(
          { error: `permanent.${f} must be a number between 0 and ${MAX_CUSTOM_RATE} if provided` },
          { status: 400 },
        );
      }
    }
    if (!Array.isArray(pf.gaps)) {
      return NextResponse.json({ error: 'permanent.gaps must be an array' }, { status: 400 });
    }
    if (pf.gaps.length > MAX_ARRAY_LEN) {
      return NextResponse.json({ error: `permanent.gaps exceeds the ${MAX_ARRAY_LEN}-item limit` }, { status: 400 });
    }
    for (const g of pf.gaps as unknown[]) {
      if (!isObj(g) || !isNonNegNumber(g.lengthFt)) {
        return NextResponse.json({ error: 'Invalid permanent.gaps element (lengthFt must be a non-negative number)' }, { status: 400 });
      }
    }
  }

  try {
    let quoteInputs = inputs as QuoteInputs;
    // A valid quoteId means re-price that existing quote in place (the builder's
    // "recommend roofline" toggle, #17) instead of inserting a new row. Load the
    // stored row ONCE — reused for the reprice-lock check, the effective service
    // type, and the frozen permanent rate snapshot.
    const isUpdate = typeof quoteId === 'string' && UUID_RE.test(quoteId);
    const existing = isUpdate ? await getQuoteRaw(quoteId as string) : null;

    // W1-003: a booked (deposit-paid) or terminal quote must NOT be re-priced in
    // place — that silently rewrites result/total with no amendment trail, no
    // invoice re-sync, and no re-consent. Changing a booked order goes through the
    // amend flow instead. 409 when locked.
    if (isUpdate && existing && REPRICE_LOCKED_STATUSES.has(deriveStatus(existing))) {
      return NextResponse.json(
        {
          error:
            'This order is booked or closed and cannot be re-priced here. Use the amend flow (/api/quotes/[id]/amend) to change a booked order.',
          code: 'quote-locked',
        },
        { status: 409 },
      );
    }

    // The service type that drives PRICING: the request's when provided (a
    // deliberate pick/switch), else the STORED row's on an update, else the
    // default. This is the H2 guard — a permanent-inputs body that omits
    // serviceType must NOT fall through to the holiday engine; it resolves to the
    // stored 'permanent'. The same value is written back so stored ↔ result stay
    // consistent.
    const effectiveServiceType: ServiceType =
      serviceType ?? (existing ? asServiceType(existing.service_type) : null) ?? DEFAULT_SERVICE_TYPE;
    const isPermanent = effectiveServiceType === 'permanent';
    const isEvent = effectiveServiceType === 'event';

    // If a design is linked AND its scene has projectable per-unit items, the
    // DESIGN is the master list for those items (#27). Holiday + event both use
    // the design (event reuses the C9/mini/spritzer/curtain items); only permanent
    // (puck strands) is skipped — projectScene ignores permanent strands.
    if (!isPermanent && isValidDesignId(designId)) {
      const design = await getDesign(designId);
      if (design?.scene) {
        quoteInputs = applyProjectionToInputs(quoteInputs, design.scene);
      }
    }

    // Permanent rate table for pricing (H1 — the rate-drift guard): a re-price of
    // an EXISTING permanent quote prices from its FROZEN snapshot so a Settings
    // rate change can't re-price an outstanding quote; a NEW permanent quote reads
    // live settings. Falls back to live settings for a legacy row with no snapshot.
    const permRates = isPermanent
      ? existing?.result?.permanentRatesSnapshot ?? (await getAppSettings()).permanentRates
      : undefined;
    // Event rate table — the same rate-drift guard: re-price an EXISTING event
    // quote from its FROZEN snapshot; a NEW event quote reads live settings.
    const eventRates = isEvent
      ? existing?.result?.eventRatesSnapshot ?? (await getAppSettings()).eventRates
      : undefined;
    const price = (i: QuoteInputs) =>
      isPermanent
        ? calculatePermanentQuote(i, permRates)
        : isEvent
          ? calculateEventQuote(i, eventRates)
          : calculateQuote(i);

    const result = price(quoteInputs);
    // #104: a baseline result with the per-quote price overrides STRIPPED, so the
    // builder breakdown can show "custom · was $X" per overridden line. Display-only
    // (never saved; the persisted `result` keeps the overrides).
    const baseline = quoteInputs.lineItemPriceOverrides
      ? price({ ...quoteInputs, lineItemPriceOverrides: undefined })
      : result;
    const safeCustomer = (customer ?? {}) as Customer;

    // Actor audit trail (#90): stamp the creating operator on a NEW quote only
    // (created_by is create-attribution; a re-price must not rewrite it). null
    // while the auth gate is dormant (no session).
    const operator = await getOperator();
    // On update, only touch the customer columns when the request actually carried
    // a customer object — omitting it must not reset the stored name/address.
    const saved = isUpdate
      ? await updateQuote(
          quoteId as string,
          quoteInputs,
          result,
          customer ? safeCustomer : undefined,
          // Keep the stored service_type consistent with what we priced (H2).
          effectiveServiceType,
        )
      : await saveQuote(
          safeCustomer,
          quoteInputs,
          result,
          effectiveServiceType,
          isTest,
          operator?.id ?? null,
        );
    return NextResponse.json({
      customer: safeCustomer,
      result,
      baseline, // #104 — overrides-stripped, for the "was $X" display
      quoteId: saved?.id ?? null,
      persisted: saved !== null,
    });
  } catch (err) {
    console.error('Quote calculation error:', err);
    return NextResponse.json({ error: 'Failed to calculate quote' }, { status: 500 });
  }
}
