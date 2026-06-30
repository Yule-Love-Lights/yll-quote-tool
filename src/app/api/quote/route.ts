import { NextRequest, NextResponse } from 'next/server';
import { calculateQuote, QuoteInputs } from '@/lib/pricing/pricingEngine';
import { saveQuote, updateQuote, Customer } from '@/lib/quotes';
import { getDesign, isValidDesignId } from '@/lib/designs';
import { applyProjectionToInputs } from '@/lib/design/projectScene';
import { asServiceType, DEFAULT_SERVICE_TYPE } from '@/lib/serviceType';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
const VALID_TAKEDOWNS = ['included', 'premium'];

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

// Audit fix (quote-route-validation): allowed enum sets for the typed per-unit
// arrays, mirroring the pricingEngine types. A malformed element is a clean 400
// instead of an opaque downstream 500.
const VALID_MINILIGHT_TYPES = new Set(['tree', 'bush', 'column', 'railing']);
const VALID_MINILIGHT_WRAP_STYLES = new Set(['canopy', 'trunk']);
const VALID_SPRITZER_SIZES = new Set(['16', '24', '32']);
const VALID_WREATH_SIZES = new Set(['24noble', '30noble', '36noble', '48noble', '60noble', '72noble']);
const VALID_GARLAND_LENGTHS = new Set(['4.5ft', '9ft']);
const VALID_GARLAND_TYPES = new Set(['noble']);
const VALID_DECOR_TIERS = new Set(['bow', 'fullDecor']);

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

  try {
    let quoteInputs = inputs as QuoteInputs;
    // If a design is linked AND its scene has projectable per-unit items, the
    // DESIGN is the master list for those items (#27): replace the per-unit
    // inputs with the projection before pricing + saving. Roofline + custom
    // items + fees pass through. No design (or an empty/roofline-only design) =
    // the form's manual per-unit entry still drives the quote (decision 2a).
    if (isValidDesignId(designId)) {
      const design = await getDesign(designId);
      if (design?.scene) {
        quoteInputs = applyProjectionToInputs(quoteInputs, design.scene);
      }
    }
    const result = calculateQuote(quoteInputs);
    const safeCustomer = (customer ?? {}) as Customer;
    // A valid quoteId means re-price that existing quote in place (the
    // builder's "recommend roofline" toggle, #17) instead of inserting a new
    // row; otherwise save a fresh quote.
    const isUpdate = typeof quoteId === 'string' && UUID_RE.test(quoteId);
    // Actor audit trail (#90): stamp the creating operator on a NEW quote only
    // (created_by is create-attribution; a re-price must not rewrite it). null
    // while the auth gate is dormant (no session).
    const operator = await getOperator();
    // On update, only touch the customer columns when the request actually
    // carried a customer object — omitting it must not reset the stored
    // name/address to the Anonymous sentinels.
    const saved = isUpdate
      ? await updateQuote(
          quoteId as string,
          quoteInputs,
          result,
          customer ? safeCustomer : undefined,
          // undefined → leave the stored service_type untouched on update.
          serviceType ?? undefined,
        )
      : await saveQuote(
          safeCustomer,
          quoteInputs,
          result,
          serviceType ?? DEFAULT_SERVICE_TYPE,
          isTest,
          operator?.id ?? null,
        );
    return NextResponse.json({
      customer: safeCustomer,
      result,
      quoteId: saved?.id ?? null,
      persisted: saved !== null,
    });
  } catch (err) {
    console.error('Quote calculation error:', err);
    return NextResponse.json({ error: 'Failed to calculate quote' }, { status: 500 });
  }
}
