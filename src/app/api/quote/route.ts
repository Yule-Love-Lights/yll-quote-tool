import { NextRequest, NextResponse, after } from 'next/server';
import { calculateQuote, QuoteInputs, MINI_LIGHT_TYPES, normalizedDepositOverride } from '@/lib/pricing/pricingEngine';
import { saveQuote, updateQuote, getQuoteRaw, Customer } from '@/lib/quotes';
import { deriveStatus, repriceSignalCanFire, type QuoteStatus } from '@/lib/quoteStatus';
import { getDesign, isValidDesignId } from '@/lib/designs';
import { applyProjectionToInputs } from '@/lib/design/projectScene';
import {
  asServiceType,
  DEFAULT_SERVICE_TYPE,
  canCarryNceOrYllNeighborTag,
  type ServiceType,
} from '@/lib/serviceType';
import { calculatePermanentQuote } from '@/lib/permanent/pricing';
import { calculateEventQuote } from '@/lib/event/pricing';
import { calculatePermanentBistro } from '@/lib/permanentBistro/pricing';
import { getAppSettings } from '@/lib/appSettings';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { pushEventDateToGhl, formatEventDateForGhl } from '@/lib/integrations/ghlEventDate';
import {
  completeQuoteBuildSession,
  linkQuoteBuildSession,
  quoteBuildSessionTargetState,
  startQuoteBuildSession,
} from '@/lib/quoteBuildTiming';
import type { QuoteBuildStartReason } from '@/lib/quoteBuildTimerClient';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { roundMoney } from '@/lib/money';
import { resolveAgreedTotal, type AgreedTotalSnapshot } from '@/lib/agreedTotal';
import { latestConsentAmendment } from '@/lib/amend';

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

// item-numbering-rename: per-quote label override cap. Matches the existing
// MAX_STRING_LEN convention (src/app/api/quotes/[id]/selection/route.ts) for
// a short staff-typed name.
const MAX_LABEL_OVERRIDE_LEN = 200;

// #leads "Create quote" link: a HighLevel contact id is an opaque short
// string (GHL's own ids run well under this) — cap it generously so a clean
// 400 beats persisting an oversized/garbage value into highlevel_contact_id.
const MAX_HL_CONTACT_ID_LEN = 100;
const QUOTE_BUILD_START_REASONS: QuoteBuildStartReason[] = ['contact_selected', 'prefilled_open'];

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
  'abandoned',
]);

function isNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Row 331+341: server-side halves of the post-approval freeze on line PRICE
// overrides, line LABEL overrides, and permanent-bistro per-run FOOTAGE — a
// browser guard is never a guard (AGENTS.md), and this route is directly
// POST-able on its own. Mirrors the #177 fix 3b deposit-percent freeze
// exactly: each compares the INCOMING value against what's actually stored
// so an unrelated field edit on an approved-but-unbooked quote still saves
// normally (this route's existing intended behavior — see the #177 comment
// at the call site below), and only a REAL change 409s.
function priceOverridesEqual(a: unknown, b: unknown): boolean {
  const av = isObj(a) ? a : {};
  const bv = isObj(b) ? b : {};
  const ak = Object.keys(av);
  const bk = Object.keys(bv);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => {
    const x = av[k];
    const y = bv[k];
    if (!isObj(x) || !isObj(y)) return false;
    return x.amount === y.amount && (x.reason ?? '') === (y.reason ?? '');
  });
}

function labelOverridesEqual(a: unknown, b: unknown): boolean {
  const av = isObj(a) ? a : {};
  const bv = isObj(b) ? b : {};
  const ak = Object.keys(av);
  const bk = Object.keys(bv);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => av[k] === bv[k]);
}

// Compared by stable run id → footage, order-independent (an id-less bistro
// line has no editable footage input on the client — see updateBistroRunFootage
// — so it never appears in a diff that matters here). A run added or removed
// changes the map's size, which counts as a change same as an edited footage.
function bistroFootageEqual(a: unknown, b: unknown): boolean {
  const toMap = (v: unknown): Map<string, number> => {
    const m = new Map<string, number>();
    if (!Array.isArray(v)) return m;
    for (const item of v) {
      if (isObj(item) && typeof item.id === 'string' && typeof item.footage === 'number') {
        m.set(item.id, item.footage);
      }
    }
    return m;
  };
  const am = toMap(a);
  const bm = toMap(b);
  if (am.size !== bm.size) return false;
  for (const [id, footage] of am) {
    if (bm.get(id) !== footage) return false;
  }
  return true;
}

export async function POST(req: NextRequest) {
  const quoteSaveStartedAt = new Date().toISOString();
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

  const {
    customer,
    inputs,
    quoteId,
    designId,
    serviceType: rawServiceType,
    isTest: rawIsTest,
    amendReprice: rawAmendReprice,
    referredByCustomerId: rawReferredByCustomerId,
    highlevelContactId: rawHighlevelContactId,
    legacyRebook: rawLegacyRebook,
    isNce: rawIsNce,
    quoteBuildTimerId: rawQuoteBuildTimerId,
    quoteBuildStartReason: rawQuoteBuildStartReason,
  } = body as Record<string, unknown>;

  const hasQuoteBuildTimer = rawQuoteBuildTimerId !== undefined || rawQuoteBuildStartReason !== undefined;
  if (hasQuoteBuildTimer) {
    if (typeof rawQuoteBuildTimerId !== 'string' || !UUID_RE.test(rawQuoteBuildTimerId)) {
      return NextResponse.json({ error: 'quoteBuildTimerId must be a valid UUID' }, { status: 400 });
    }
    if (
      typeof rawQuoteBuildStartReason !== 'string' ||
      !QUOTE_BUILD_START_REASONS.includes(rawQuoteBuildStartReason as QuoteBuildStartReason)
    ) {
      return NextResponse.json(
        { error: 'quoteBuildStartReason must be contact_selected or prefilled_open' },
        { status: 400 },
      );
    }
  }
  const quoteBuildTimerId = typeof rawQuoteBuildTimerId === 'string' ? rawQuoteBuildTimerId : null;
  const quoteBuildStartReason = typeof rawQuoteBuildStartReason === 'string'
    ? rawQuoteBuildStartReason as QuoteBuildStartReason
    : null;

  // Amend deadlock fix: an explicit, operator-only re-price mode for a BOOKED order.
  // Only an exact `true` enables it; any other value falls through to the normal
  // (locked) behavior. See the reprice-lock block below for the full rationale.
  const amendReprice = rawAmendReprice === true;

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
      { error: "serviceType must be 'holiday', 'permanent', 'event', or 'permanent_bistro'" },
      { status: 400 },
    );
  }

  // Referral program (#41 "mention" attribution): an existing customer picked
  // as "Referred by" in the builder. Optional; only honored on a NEW save
  // (saveQuote) — an update never re-attributes a referral.
  if (rawReferredByCustomerId !== undefined && typeof rawReferredByCustomerId !== 'string') {
    return NextResponse.json({ error: 'referredByCustomerId must be a string if provided' }, { status: 400 });
  }
  if (typeof rawReferredByCustomerId === 'string' && !UUID_RE.test(rawReferredByCustomerId)) {
    return NextResponse.json({ error: 'referredByCustomerId must be a valid UUID' }, { status: 400 });
  }
  const referredByCustomerId = typeof rawReferredByCustomerId === 'string' ? rawReferredByCustomerId : null;

  // #leads "Create quote" link + #214 live-session link: the builder
  // session's HighLevel contact id. Opaque untrusted string — type + length
  // only (no format assumed, unlike the UUID-shaped referredByCustomerId
  // above). On a NEW save it lands in the insert (saveQuote). On an UPDATE
  // it is (since #214) threaded to updateQuote as IDENTITY input only —
  // updateQuote still never writes the highlevel_contact_id column (the
  // operator's HL-autocomplete pick/clear, via /api/integrations/highlevel/
  // attach, stays that column's only post-insert writer). Tri-state: string
  // = linked this session · explicit null = the session has NO contact
  // (cleared / never linked — do NOT fall back to the stored id) ·
  // absent/undefined = caller doesn't know (legacy) → updateQuote falls
  // back to the stored id.
  if (
    rawHighlevelContactId !== undefined &&
    rawHighlevelContactId !== null &&
    typeof rawHighlevelContactId !== 'string'
  ) {
    return NextResponse.json({ error: 'highlevelContactId must be a string or null if provided' }, { status: 400 });
  }
  if (typeof rawHighlevelContactId === 'string' && rawHighlevelContactId.length > MAX_HL_CONTACT_ID_LEN) {
    return NextResponse.json(
      { error: `highlevelContactId exceeds the ${MAX_HL_CONTACT_ID_LEN}-character limit` },
      { status: 400 },
    );
  }
  const highlevelContactIdTrimmed =
    typeof rawHighlevelContactId === 'string' ? rawHighlevelContactId.trim() : '';
  const highlevelContactId = highlevelContactIdTrimmed ? highlevelContactIdTrimmed : null;
  // The tri-state form updateQuote takes (undefined preserved; blank → null).
  const hlContactIdForUpdate: string | null | undefined =
    rawHighlevelContactId === undefined ? undefined : highlevelContactId;

  // NCE + YLL Neighbor tags (#198): the builder's chip strip sends the CURRENT
  // chip state on every save (both new + edit mode) — optional booleans, same
  // shape as isTest above. Unlike isTest, BOTH are honored on the update path
  // too (see saveQuote/updateQuote's own param docs) so a reopened quote's
  // toggled chip actually persists.
  if (rawLegacyRebook !== undefined && typeof rawLegacyRebook !== 'boolean') {
    return NextResponse.json({ error: 'legacyRebook must be a boolean if provided' }, { status: 400 });
  }
  const legacyRebook = typeof rawLegacyRebook === 'boolean' ? rawLegacyRebook : undefined;
  if (rawIsNce !== undefined && typeof rawIsNce !== 'boolean') {
    return NextResponse.json({ error: 'isNce must be a boolean if provided' }, { status: 400 });
  }
  const isNce = typeof rawIsNce === 'boolean' ? rawIsNce : undefined;

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
  // #177: optional per-quote deposit percent override. When present, must be
  // an integer 1-100; a clean 400 beats a silently-defaulted bad value (the
  // engine's effectiveDepositRate also clamps defensively, for a legacy row).
  if (q.depositPercent !== undefined) {
    const v = q.depositPercent;
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100)) {
      return NextResponse.json(
        { error: 'depositPercent must be an integer between 1 and 100 if provided' },
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
  // item-numbering-rename: optional per-quote label overrides — a map of
  // stableId → renamed label. Mirrors the lineItemPriceOverrides validation
  // above. An empty string is accepted through (the engine/adapter treat a
  // blank/whitespace-only value as "no override", same as omitting the key).
  if (q.labelOverrides !== undefined) {
    const ov = q.labelOverrides;
    if (!isObj(ov) || Array.isArray(ov)) {
      return NextResponse.json({ error: 'labelOverrides must be an object if provided' }, { status: 400 });
    }
    const keys = Object.keys(ov);
    if (keys.length > MAX_ARRAY_LEN) {
      return NextResponse.json({ error: 'too many labelOverrides' }, { status: 400 });
    }
    for (const k of keys) {
      const v = (ov as Record<string, unknown>)[k];
      if (typeof v !== 'string' || v.length > MAX_LABEL_OVERRIDE_LEN) {
        return NextResponse.json(
          { error: `labelOverrides.${k} must be a string ≤ ${MAX_LABEL_OVERRIDE_LEN} chars` },
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
    // #192 — per-side track style override (optional). An unknown key is
    // silently ignored (mirrors sideSource's leniency); a PRESENT recognized
    // side key must carry a valid TrackStyle value.
    if (pf.trackStyleBySide !== undefined) {
      if (!isObj(pf.trackStyleBySide) || Array.isArray(pf.trackStyleBySide)) {
        return NextResponse.json({ error: 'permanent.trackStyleBySide must be an object if provided' }, { status: 400 });
      }
      for (const side of ['front', 'left', 'right', 'back'] as const) {
        const v = (pf.trackStyleBySide as Record<string, unknown>)[side];
        if (v !== undefined && !PERM_TRACK_STYLES.has(v as string)) {
          return NextResponse.json(
            { error: `permanent.trackStyleBySide.${side} must be 'single' or 'parapet' if provided` },
            { status: 400 },
          );
        }
      }
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
    // #140: the Extensions/Splitters card fields (all optional; BOM-only).
    if (
      pf.accessoriesSource !== undefined &&
      pf.accessoriesSource !== 'auto' &&
      pf.accessoriesSource !== 'manual'
    ) {
      return NextResponse.json({ error: "permanent.accessoriesSource must be 'auto' or 'manual' if provided" }, { status: 400 });
    }
    if (pf.extensions !== undefined) {
      if (!isObj(pf.extensions)) {
        return NextResponse.json({ error: 'permanent.extensions must be an object if provided' }, { status: 400 });
      }
      for (const k of ['e3', 'e5', 'e10', 'e25'] as const) {
        if (!isNonNegNumber((pf.extensions as Record<string, unknown>)[k])) {
          return NextResponse.json({ error: `permanent.extensions.${k} must be a non-negative number` }, { status: 400 });
        }
      }
    }
    for (const f of ['splittersNeeded', 'jumpBoosters'] as const) {
      if (pf[f] !== undefined && !isNonNegNumber(pf[f])) {
        return NextResponse.json({ error: `permanent.${f} must be a non-negative number if provided` }, { status: 400 });
      }
    }
  }

  // Event Lighting (#96) — audit fixes: validate the optional event block at
  // the boundary, mirroring the permanent block above. Validated whenever
  // present (independent of serviceType) — a malformed bistro entry or
  // inverted date trio should be a clean 400, not a bad downstream result.
  if (q.event !== undefined) {
    if (!isObj(q.event)) {
      return NextResponse.json({ error: 'event must be an object if provided' }, { status: 400 });
    }
    const ev = q.event;

    // Fix #9 (unbounded array): cap + validate bistro, mirroring
    // permanent.gaps above. barrelBoxes is a plain count on the event block
    // (EventInputFields), not per-bistro-line.
    if (ev.bistro !== undefined) {
      if (!Array.isArray(ev.bistro)) {
        return NextResponse.json({ error: 'event.bistro must be an array if provided' }, { status: 400 });
      }
      if (ev.bistro.length > MAX_ARRAY_LEN) {
        return NextResponse.json({ error: `event.bistro exceeds the ${MAX_ARRAY_LEN}-item limit` }, { status: 400 });
      }
      for (const b of ev.bistro as unknown[]) {
        if (!isObj(b) || !isNonNegNumber(b.footage)) {
          return NextResponse.json(
            { error: 'Invalid event.bistro element (footage must be a non-negative number)' },
            { status: 400 },
          );
        }
      }
    }
    if (ev.barrelBoxes !== undefined && !isNonNegNumber(ev.barrelBoxes)) {
      return NextResponse.json(
        { error: 'event.barrelBoxes must be a non-negative number if provided' },
        { status: 400 },
      );
    }

    // Fix #5 (server half, inverted dates): the 3 dates are OPTIONAL staff
    // metadata (EventInputFields — NOT priced, never required here); validate
    // format + order only when present. ISO yyyy-mm-dd is a fixed-width,
    // zero-padded string, so plain string comparison IS date-order comparison
    // — no timezone-sensitive Date math needed for the ordering check.
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const eventDateFields = ['installDate', 'eventDate', 'takedownDate'] as const;
    for (const f of eventDateFields) {
      const v = ev[f];
      if (v !== undefined && (typeof v !== 'string' || !ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v)))) {
        return NextResponse.json(
          { error: `event.${f} must be an ISO yyyy-mm-dd date string if provided` },
          { status: 400 },
        );
      }
    }
    const install = ev.installDate as string | undefined;
    const eventDate = ev.eventDate as string | undefined;
    const takedown = ev.takedownDate as string | undefined;
    if (install !== undefined && eventDate !== undefined && install > eventDate) {
      return NextResponse.json({ error: 'event.installDate must not be after event.eventDate' }, { status: 400 });
    }
    if (eventDate !== undefined && takedown !== undefined && eventDate > takedown) {
      return NextResponse.json({ error: 'event.eventDate must not be after event.takedownDate' }, { status: 400 });
    }
    if (install !== undefined && takedown !== undefined && install > takedown) {
      return NextResponse.json({ error: 'event.installDate must not be after event.takedownDate' }, { status: 400 });
    }
  }

  // Permanent Bistro Lighting (#117) — validate the optional permanentBistro
  // block at the boundary, mirroring the permanent/event blocks above.
  // Validated whenever present (independent of serviceType) — a malformed
  // bistro entry or negative pole count should be a clean 400, not a bad
  // downstream result.
  if (q.permanentBistro !== undefined) {
    if (!isObj(q.permanentBistro)) {
      return NextResponse.json({ error: 'permanentBistro must be an object if provided' }, { status: 400 });
    }
    const pb = q.permanentBistro;
    if (pb.bistro !== undefined) {
      if (!Array.isArray(pb.bistro)) {
        return NextResponse.json({ error: 'permanentBistro.bistro must be an array if provided' }, { status: 400 });
      }
      if (pb.bistro.length > MAX_ARRAY_LEN) {
        return NextResponse.json({ error: `permanentBistro.bistro exceeds the ${MAX_ARRAY_LEN}-item limit` }, { status: 400 });
      }
      for (const b of pb.bistro as unknown[]) {
        if (!isObj(b) || !isNonNegNumber(b.footage)) {
          return NextResponse.json(
            { error: 'Invalid permanentBistro.bistro element (footage must be a non-negative number)' },
            { status: 400 },
          );
        }
      }
    }
    if (pb.poles !== undefined && !isNonNegNumber(pb.poles)) {
      return NextResponse.json(
        { error: 'permanentBistro.poles must be a non-negative number if provided' },
        { status: 400 },
      );
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

    // Fail-CLOSED guard (audit fix): an update targets an EXISTING row (the builder
    // loaded that quote to edit it). getQuoteRaw returns null for BOTH a genuinely
    // missing row AND a transient read error, so falling through here would skip the
    // reprice-lock, the rate-drift snapshot guard, and the stored-service-type
    // fallback and then let updateQuote overwrite inputs/result. Stop instead of
    // silently proceeding. (A proper 503-on-read-error vs 404-on-missing split needs
    // getQuoteRaw to distinguish the two — see notes; it is out of this unit's file
    // scope. Until then both collapse to a safe, non-destructive 404.)
    if (isUpdate && !existing) {
      return NextResponse.json(
        { error: 'Quote not found', code: 'quote-not-found' },
        { status: 404 },
      );
    }

    // W1-003: a booked (deposit-paid) or terminal quote must NOT be re-priced in
    // place — that silently rewrites result/total with no amendment trail, no
    // invoice re-sync, and no re-consent. Changing a booked order goes through the
    // amend flow instead. 409 when locked.
    //
    // Amend deadlock fix: the amend flow (/api/quotes/[id]/amend) measures the change
    // as result.total − snapshot.pricing.total, but this very lock freezes a booked
    // order's result, so the amend delta is ALWAYS 0 and every post-booking amend
    // 409s "no-change" forever — the extra charge can never be added. An explicit,
    // operator-only `amendReprice` re-price is therefore allowed for a BOOKED order:
    // it updates result/inputs in place (updateQuote writes only inputs/result/total/
    // service_type — never deposit_paid_at or status, so the lifecycle stays booked),
    // which the operator immediately follows with the amend record. Terminal statuses
    // (declined/cancelled/abandoned) stay hard-locked — a dead order is never re-priced.
    //
    // Row 331+341 fix (premerge finding 1): amendRepriceAllowed is hoisted out of
    // this if-block (was previously scoped only here) so the price/label/bistro-
    // footage freeze below can carve out the SAME operator-only amend path. Without
    // this, a booked order needing a price/label/footage correction had no path at
    // all — the amend flow's own documented mechanism ("edit in the builder +
    // Calculate, then record the amendment", amend/route.ts:9-15) IS these three
    // surfaces, and they 409'd unconditionally.
    let amendRepriceAllowed = false;
    if (isUpdate && existing) {
      const currentStatus = deriveStatus(existing);
      amendRepriceAllowed = amendReprice && currentStatus === 'booked';
      if (REPRICE_LOCKED_STATUSES.has(currentStatus) && !amendRepriceAllowed) {
        return NextResponse.json(
          {
            error:
              'This order is booked or closed and cannot be re-priced here. Use the amend flow (/api/quotes/[id]/amend) to change a booked order.',
            code: 'quote-locked',
          },
          { status: 409 },
        );
      }
    }

    // #177 fix 3b: the deposit percent is FROZEN into the approval snapshot the
    // moment a customer approves — a later edit here must not silently drift
    // what was already signed. Scoped ONLY to depositPercent changing: unlike
    // the REPRICE_LOCKED_STATUSES block above, an approved-but-not-yet-booked
    // quote can still be re-priced through this route for every OTHER field
    // (existing intended behavior — approved isn't in REPRICE_LOCKED_STATUSES).
    if (isUpdate && existing?.customer_approved_at) {
      // #226 fix: normalize BOTH sides through the same "actual override"
      // predicate effectiveDepositRate uses, instead of a bare `typeof ===
      // 'number'` check. A stored explicit 0 (written by the NCE-off reset)
      // and an incoming `undefined` (the real client can never emit an
      // explicit 0 — see quoteForm.ts's buildQuoteInputs) both mean "no
      // override, use the 50% default" and must compare EQUAL here so an
      // unrelated field edit on an approved-but-unbooked quote doesn't 409.
      // A genuine change (e.g. 40 → 25, or 40 → blank) still normalizes to
      // two DIFFERENT values and still 409s — the #177 freeze is unweakened.
      const incomingDepositPercent = normalizedDepositOverride(
        typeof q.depositPercent === 'number' ? q.depositPercent : undefined,
      );
      const storedDepositPercent = normalizedDepositOverride(
        typeof existing.inputs?.depositPercent === 'number' ? existing.inputs.depositPercent : undefined,
      );
      if (incomingDepositPercent !== storedDepositPercent) {
        return NextResponse.json(
          {
            error:
              'This quote has already been approved — the deposit percent is locked and cannot be changed here. Use the amend flow to change it.',
            code: 'deposit-percent-locked',
          },
          { status: 409 },
        );
      }
    }

    // Row 331+341: the same #177-shaped freeze for a line's PRICE override, its
    // LABEL override, and a permanent-bistro run's FOOTAGE — all three auto-
    // persist through this exact route (EditablePrice/EditableLabel commit
    // immediately on blur/Enter; #244's per-run bistro footage saves on the
    // next Calculate) with nothing stopping a staffer from silently changing
    // what the customer already signed. Bistro footage additionally feeds the
    // materials/BOM basis for an already-sold job (row 341). is_test exempt,
    // matching every other freeze in this file (#251/#177) — a test quote
    // stays fully editable regardless of lifecycle stamps.
    //
    // Premerge finding 1 fix: carve out the SAME operator-only amendReprice path
    // the sibling REPRICE_LOCKED_STATUSES guard above allows for a booked order.
    // Without this, the sanctioned amend mechanism for a booked order (edit these
    // exact three fields in the builder + Calculate, then record the amendment —
    // see amend/route.ts:9-15) 409'd with no path at all. amendRepriceAllowed is
    // only true when amendReprice===true AND the order is already 'booked', so an
    // approved-but-not-yet-booked quote (no amend record possible — see finding 2
    // below) is UNAFFECTED by this carve-out and stays hard-locked here.
    if (isUpdate && existing?.customer_approved_at && !existing.is_test && !amendRepriceAllowed) {
      const storedInputs = existing.inputs ?? {};
      if (!priceOverridesEqual(q.lineItemPriceOverrides, storedInputs.lineItemPriceOverrides)) {
        return NextResponse.json(
          {
            error:
              'This quote has already been approved — line prices are locked. A price change needs re-approval: decline the quote, revive it, make the change, and re-send. (A booked order is amended via the builder instead.)',
            code: 'price-override-locked',
          },
          { status: 409 },
        );
      }
      if (!labelOverridesEqual(q.labelOverrides, storedInputs.labelOverrides)) {
        return NextResponse.json(
          {
            error:
              'This quote has already been approved — line item names are locked. A rename needs re-approval: decline the quote, revive it, make the change, and re-send.',
            code: 'label-override-locked',
          },
          { status: 409 },
        );
      }
      const incomingBistro = isObj(q.permanentBistro) ? q.permanentBistro.bistro : undefined;
      if (!bistroFootageEqual(incomingBistro, storedInputs.permanentBistro?.bistro)) {
        return NextResponse.json(
          {
            error:
              'This quote has already been approved — bistro run footage is locked. A footage change needs re-approval: decline the quote, revive it, make the change, and re-send.',
            code: 'bistro-footage-locked',
          },
          { status: 409 },
        );
      }
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
    const isPermanentBistro = effectiveServiceType === 'permanent_bistro';

    // #243 (domain rule locked 2026-08-11): server-side defense-in-depth —
    // the builder already hides the NCE/YLL Neighbor chips and clears them on
    // a service-type switch (QuoteBuilder.tsx), but THIS route is the actual
    // write path both a new-quote insert and an existing-quote update funnel
    // through, and it's directly POST-able on its own. Only an EXPLICIT
    // `true` request is clamped to false — `undefined` (chip untouched /
    // "leave the stored value alone" on an update, per resolveTagPayload)
    // passes through unchanged, so this can never silently correct an
    // EXISTING violating row's tag as a side effect of an unrelated save; it
    // only refuses a NEW attempt to set the tag on an ineligible quote.
    // Silent clamp, not a 400 — matches the locked "silently do not inherit,
    // no disabled-with-reason UI" design for this feature (the two admin
    // toggle routes DO 400, because those are single-purpose staff clicks
    // that need feedback; this is the general Calculate/Save path, where a
    // hypothetical client bug sending a stale true alongside an otherwise
    // legitimate save shouldn't fail the whole thing).
    const eligibleForTags = canCarryNceOrYllNeighborTag(effectiveServiceType);
    const gatedLegacyRebook = !eligibleForTags && legacyRebook === true ? false : legacyRebook;
    const gatedIsNce = !eligibleForTags && isNce === true ? false : isNce;

    // #243 money HIGH fix (lens review, row 243): the clamp two lines up only
    // corrects the is_nce COLUMN — quoteInputs.depositPercent (the field
    // effectiveDepositRate/computeTotalsTail actually price off) came straight
    // from the request body untouched. A request with serviceType:'permanent',
    // isNce:true, depositPercent:40 would persist is_nce:false (correctly
    // gated) AND depositPercent:40 — a real-money permanent job billed at
    // NCE's 40% barter rate, with no tag left on the row to explain why.
    // Mirrors rebook.ts's buildRebookInsert/applyNceDepositDefault exactly:
    // `gateForcedNceOff` is the identical predicate rebook.ts uses
    // (`srcIsNce && !isNce`, i.e. "the tag gate itself is what forced this
    // false") — that gate firing is itself as strong an "this NCE state is
    // invalid" signal as rebook's own resetOnOff case, so it resets the
    // deposit the same way. Like applyNceDepositDefault, this only resets an
    // EXACT 40 — any other stored value (a hand-typed 25%, a coincidentally-
    // negotiated 35%) is left alone, so a legitimate staff override on an
    // ineligible-for-NCE quote survives untouched (the server has no
    // `wasRuleSet` bit the way quoteForm.ts's resolveNceDepositPercent does;
    // "exactly 40" is the same approximation rebook.ts already ships with).
    // Writes an explicit 0, never deletes the key — normalizedDepositOverride
    // (pricingEngine.ts, #226) already treats an explicit 0 identically to
    // "no override" (falls through to the 50% default), matching
    // applyNceDepositDefault's own OFF branch. Must land before price()
    // below so both the priced result.depositRate snapshot and the saved
    // inputs reflect the correction.
    //
    // Delta-verify MED (sibling-guard parity): gated on the quote NOT being
    // approved yet, matching the rule the sibling NCE toggle route already
    // states in its own header — "pre-approval only (customer_approved_at
    // null — the #177 freeze owns an approved/booked quote's deposit)". The
    // #177 freeze block above only 409s when the INCOMING depositPercent
    // DIFFERS from the stored one, so a plain reopen-and-resave of an
    // already-approved quote that carries a pre-existing violation (is_nce
    // true + 40 on an ineligible service type) sails through it — and without
    // this guard the reset would then silently move an APPROVED customer's
    // deposit from 40% to the 50% default, with only a console.warn as a
    // trace. A pre-existing violation on an approved quote is a data problem
    // for a human to resolve deliberately, not something a routine re-save
    // should rewrite underneath them. Prod currently has zero such rows.
    const gateForcedNceOff = !eligibleForTags && isNce === true;
    if (gateForcedNceOff && quoteInputs.depositPercent === 40 && !existing?.customer_approved_at) {
      console.warn(
        `[quote/route] #243 gate: clamped is_nce off for ineligible serviceType=${effectiveServiceType} on quoteId=${
          typeof quoteId === 'string' ? quoteId : '(new)'
        } — also reset a carried depositPercent=40 to 0 (see rebook.ts's gateForcedNceOff for the same rule).`,
      );
      quoteInputs = { ...quoteInputs, depositPercent: 0 };
    }

    // If a design is linked AND its scene has projectable per-unit items, the
    // DESIGN is the master list for those items (#27). Holiday + event both use
    // the design (event reuses the C9/mini/spritzer/curtain items); permanent
    // (puck strands) is skipped — projectScene ignores permanent strands.
    // Permanent Bistro (#117) is ALSO skipped: bistro footage now bills from the
    // client-sent satellite-derived inputs.permanentBistro.bistro (true-scale
    // polylines drawn on the satellite tab), never from the design's street-photo
    // scene — the Design tab's bistro strand there is visual-only for the portal.
    // Without this exemption, any leftover bistro strand on the street photo would
    // silently clobber the satellite footage on every Calculate.
    if (!isPermanent && !isPermanentBistro && isValidDesignId(designId)) {
      const design = await getDesign(designId);
      if (design?.scene) {
        quoteInputs = applyProjectionToInputs(quoteInputs, design.scene, effectiveServiceType);
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
    // Permanent Bistro rate table — same rate-drift guard as permanent/event:
    // re-price an EXISTING permanent_bistro quote from its FROZEN snapshot; a
    // NEW one reads live settings.
    const bistroRates = isPermanentBistro
      ? existing?.result?.permanentBistroRatesSnapshot ?? (await getAppSettings()).permanentBistroRates
      : undefined;
    const price = (i: QuoteInputs) =>
      isPermanent
        ? calculatePermanentQuote(i, permRates)
        : isEvent
          ? calculateEventQuote(i, eventRates)
          : isPermanentBistro
            ? calculatePermanentBistro(i, bistroRates)
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
          // Referral program (#41 adversarial-review fix): updateQuote now
          // honors this too (create-once, idempotent) — see its own doc
          // comment for why an update needs a fresh pre-read of its own.
          referredByCustomerId,
          // NCE + YLL Neighbor tags (#198): these ARE honored on the update
          // path — undefined (not sent / chip strip not touched) leaves the
          // stored value untouched. #243: the GATED values — see the gate's
          // own comment above effectiveServiceType for why undefined passes
          // through unclamped.
          gatedLegacyRebook,
          gatedIsNce,
          // #214: the session's live HL link, tri-state (see the validation
          // block above) — identity-resolution input only; updateQuote never
          // writes the highlevel_contact_id column.
          hlContactIdForUpdate,
        )
      : await saveQuote(
          safeCustomer,
          quoteInputs,
          result,
          effectiveServiceType,
          isTest,
          operator?.id ?? null,
          referredByCustomerId,
          // #leads "Create quote" link: written into the insert here. (Since
          // #214 the update path ALSO receives it — as identity input only,
          // never a column write, so an existing quote's linked contact
          // still can't be clobbered by a resave.)
          highlevelContactId,
          // NCE + YLL Neighbor tags (#198): the builder's chip strip's
          // current state at first save; undefined → saveQuote's own
          // default (false). #243: the GATED values — see the gate's own
          // comment above effectiveServiceType.
          gatedLegacyRebook,
          gatedIsNce,
        );

    if (saved && quoteBuildTimerId && quoteBuildStartReason && operator) {
      const timerTargetEligible = isUpdate
        ? existing?.is_test === false && existing.view_only === false && deriveStatus(existing) === 'draft'
        : !isTest;
      if (timerTargetEligible) {
        const started = await startQuoteBuildSession({
          timerId: quoteBuildTimerId,
          startReason: quoteBuildStartReason,
          operator,
          quoteId: saved.id,
          startedAt: quoteSaveStartedAt,
        });
        let linked = false;
        if (
          started.ok &&
          started.row.id === quoteBuildTimerId &&
          (started.row.quote_id === null || started.row.quote_id === saved.id)
        ) {
          linked = started.row.quote_id === saved.id || await linkQuoteBuildSession({
            timerId: quoteBuildTimerId,
            quoteId: saved.id,
            operatorId: operator.id,
          });
        }
        if (linked) {
          const latestTarget = await quoteBuildSessionTargetState(saved.id);
          if (latestTarget?.kind === 'sent' && started.ok && started.row.sent_at == null) {
            await completeQuoteBuildSession({
              quoteId: saved.id,
              timerId: quoteBuildTimerId,
              operatorId: operator.id,
              sentAt: latestTarget.sentAt,
            });
          }
        } else {
          console.warn('[quote/route] quote build timer could not be linked after save');
        }
      }
    }

    // Row 344 Part B: a scene-driven reprice of an APPROVED, NOT-YET-BOOKED
    // quote. deposit%/price-override/label-override/bistro-footage are
    // already hard-locked above (the #177 / row-331 freezes); this covers
    // every OTHER field that can move `result.total` here — PermanentSection
    // per-side footage/corners, holiday roofline footage, and any
    // design-projected change. That LAST category includes a mini-light
    // GROUPING edit (editor.ts's groupSelectedMini): grouping only touches
    // the SCENE via its own scheduleSave() and has no billing effect on its
    // own — the billed count only changes once the next Calculate re-projects
    // the scene through applyProjectionToInputs (above) and reaches this
    // exact route — so this one check covers both of row 344's named
    // triggers, not just the footage fields.
    //
    // Deliberately NOT a refusal: staff legitimately correct a footage/
    // measurement error on an approved-not-booked quote, and the sanctioned
    // amend flow requires deposit_paid_at, so it can't reach this pre-booking
    // window at all — there is no other path. Until now this happened with
    // NO staff-facing signal and NO audit trail (only a console.warn existed
    // for an unrelated NCE-tag gate a few lines above, not this case). is_test
    // exempt, matching every other freeze/signal in this file.
    let repricedAfterApproval:
      | {
          previousTotalUsd: number;
          newTotalUsd: number;
          deltaUsd: number;
          portalShowsFrozenPrice: boolean;
          // Second fix round (staff-lens HIGH): the REASON portalShowsFrozenPrice
          // is false, distinguished for QuoteBuilder.tsx's notice — an accepted
          // amendment (always a BOOKED quote; the remedy is the amend flow, since
          // decline/revive/re-send structurally refuses a booked order) vs a
          // missing frozen-pricing snapshot (remedy depends on status; see the
          // notice copy).
          hasAcceptedAmendment: boolean;
        }
      | undefined;
    // Fix round (technical-lens MED): the ORIGINAL gate here (`!existing
    // .deposit_paid_at`) covered only the approved-not-booked window. But
    // QuoteBuilder.tsx sends `amendReprice: true` on EVERY save of a booked
    // quote (not only the one save that immediately follows an accepted
    // amendment), and this route's own `amendRepriceAllowed` carve-out
    // (above) lets that save through the REPRICE_LOCKED_STATUSES freeze — so
    // a booked quote CAN reach this point too, whenever amendRepriceAllowed
    // let it. Once ANY amendment has been accepted, adapter.ts's
    // quoteRowToPortalQuote treats row.result as UNCONDITIONALLY authoritative
    // going forward (see its own latestAcceptedAmendment comment) — so a
    // further scene edit that changes the total WITHOUT then being recorded
    // through the sanctioned /amend + /amend-consent flow silently changes
    // what the portal shows, with no staff signal and no consent trail.
    //
    // Second fix round (technical-lens HIGH): the gate itself now reads
    // repriceSignalCanFire(deriveStatus(existing)) — lib/quoteStatus.ts's
    // shared predicate ('approved' or 'booked') — the SAME one the admin
    // quote detail page's "Repriced since approval" pill reads, so the
    // write-fires condition here and the pill-shows condition there can
    // never independently drift apart again. (They did, once: this gate
    // widened to cover 'booked' one fix round before the pill did, and the
    // pill went dark for exactly the booked-and-amended case this gate
    // exists to cover.) Safe to derive from status alone here because of an
    // invariant the EARLIER REPRICE_LOCKED_STATUSES check already
    // established: a 'booked' status can only reach this line when
    // amendRepriceAllowed was true (a false amendRepriceAllowed on a
    // booked/terminal status already 409'd above) — so
    // `deriveStatus(existing) === 'booked'` at this point implies the bypass
    // was used, no separate check needed.
    if (
      saved &&
      isUpdate &&
      existing?.customer_approved_at &&
      repriceSignalCanFire(deriveStatus(existing)) &&
      !existing.is_test
    ) {
      const newTotalUsd = roundMoney(result.total);
      // Cheap pre-check against the request-start `existing` snapshot, purely
      // to decide whether this save is even a CANDIDATE — avoids an extra DB
      // round-trip on the overwhelmingly common case (a save that doesn't
      // reprice anything). Nothing derived from this pre-check is shown to
      // staff or persisted; see the fresh recompute below.
      const preliminaryPrevious = resolveAgreedTotal(
        existing.approval_snapshot as AgreedTotalSnapshot,
        existing.result ?? { total: existing.total ?? 0 },
      );
      // Sub-cent float noise is not a real reprice (mirrors amend.ts's own
      // ONE_CENT threshold for the same reason).
      if (Math.abs(roundMoney(newTotalUsd - preliminaryPrevious)) >= 0.01) {
        // Second fix round (technical-lens MED): the first fix round computed
        // previousTotalUsd/hasAcceptedAmendment/portalShowsFrozenPrice from
        // `existing` (request-start) for the STAFF-FACING NOTICE, then
        // separately re-fetched approval_snapshot FRESH, right before the
        // write, only as the CAS merge target — so a concurrent
        // approval_snapshot writer landing in that window (another staffer
        // recording+accepting an amendment, a customer's colour-change
        // request) could make the notice staff saw and the entry actually
        // persisted describe two DIFFERENT bases. The CAS itself was always
        // safe (it can't clobber the concurrent write), but the STORY told
        // about it could go stale.
        //
        // Fixed by fetching once, here, and deriving BOTH the notice and the
        // audit entry from this SAME snapshot. `existing`-basis numbers are
        // the fallback only when the service client is unavailable or this
        // fetch errors — preserving "the signal never silently depends on
        // the audit write succeeding" for that narrow case, where there is
        // no persisted entry to disagree with in the first place.
        const sb = getSupabaseServiceClient();
        let basisSnapshot = existing.approval_snapshot;
        let fetchFailed = false;
        if (sb) {
          const { data: freshRow, error: freshErr } = await sb
            .from('quotes')
            .select('approval_snapshot')
            .eq('id', quoteId as string)
            .maybeSingle<{ approval_snapshot: typeof existing.approval_snapshot }>();
          if (freshErr) {
            fetchFailed = true;
            console.error(
              '[quote/route] row 344: could not re-fetch approval_snapshot for the reprice audit entry:',
              freshErr.message,
            );
          } else {
            basisSnapshot = freshRow?.approval_snapshot ?? existing.approval_snapshot ?? {};
          }
        }
        // The customer's actual agreed total — resolveAgreedTotal (the SAME
        // canonical basis invoicing/tax-override/free-items/apply-color-request
        // already use): the last NON-DECLINED amendment's new_total when one
        // exists (the booked-and-previously-amended case this gate covers),
        // else approval_snapshot.customerSelection.currentTotalUsd (the
        // approved-not-booked case), else the stored full result/total for an
        // old/legacy snapshot. Re-derived from `basisSnapshot` (fresh when
        // available) rather than reusing preliminaryPrevious above, so a
        // concurrent write that already changed the agreed total is reflected
        // here too.
        const previousTotalUsd = resolveAgreedTotal(
          // QuoteRaw's approval_snapshot.customerSelection is typed narrower
          // (only the color fields getQuoteRaw's other callers need) than
          // AgreedTotalSnapshot's currentTotalUsd — same underlying jsonb
          // column, real values, just a type-modeling gap. resolveAgreedTotal
          // itself is fully defensive (finiteMoney guards every rung), so this
          // mirrors apply-color-request.ts's own call exactly, just cast
          // instead of locally re-typed.
          basisSnapshot as AgreedTotalSnapshot,
          existing.result ?? { total: existing.total ?? 0 },
        );
        const deltaUsd = roundMoney(newTotalUsd - previousTotalUsd);
        // Re-check against the FRESH basis: a concurrent write in the window
        // above may have already absorbed this exact change (e.g. another
        // staffer's amendment landed with the same new_total), in which case
        // there's nothing left to signal or persist.
        if (Math.abs(deltaUsd) >= 0.01) {
          // Fix round (staff-lens HIGH): whether the portal is ACTUALLY still
          // showing the approved figure. adapter.ts's quoteRowToPortalQuote
          // freezes the portal to approval_snapshot.pricing only when it's
          // present AND no amendment has been accepted yet, else it falls BACK
          // to live row.result — the very number this save just changed. This
          // mirrors adapter.ts's latestAcceptedAmendment condition exactly (the
          // same latestConsentAmendment lookup, same accepted-status check) so
          // the two can never disagree on which case they're in.
          const hasAcceptedAmendment =
            latestConsentAmendment(basisSnapshot?.amendments)?.consent?.status === 'accepted';
          const portalShowsFrozenPrice = !hasAcceptedAmendment && Boolean(basisSnapshot?.pricing);
          repricedAfterApproval = { previousTotalUsd, newTotalUsd, deltaUsd, portalShowsFrozenPrice, hasAcceptedAmendment };
          // Durable audit record — best-effort AND CAS'd (fix round, technical/
          // admin-lens HIGH). Only attempted when we actually have a fresh,
          // error-free basis to CAS against (sb-null / fetch-error already
          // logged above); the STAFF SIGNAL just above is never gated on this
          // succeeding. The original version here did a blind read (`existing`,
          // captured at request start) then write, with no conditional —
          // exactly the shape apply-color-request.ts's dismiss action and
          // color-change-request.ts warn against for this SAME column: a
          // concurrent writer (most concretely apply-color-request /
          // color-change-request, which touch approval_snapshot on this same
          // pre-booking-adjacent window) could land in between our read and our
          // write, and the blind write would silently drop THEIR change — a
          // customer's pendingColorRequest or a staff apply's customerSelection
          // — while only adding an audit line. Mirrors apply-color-request.ts's
          // CAS idiom: CAS on the SAME basisSnapshot everything above was
          // derived from, via `.eq('approval_snapshot', JSON.stringify(
          // basisSnapshot))`. On a lost race we do NOT retry-loop: this entry
          // is pure audit metadata (the reprice itself already landed via
          // updateQuote above, independent of this write), so dropping ONE
          // trail entry when a concurrent writer won the race is the accepted,
          // survivable outcome — same tradeoff the original comment already
          // named, now enforced by a CAS instead of assumed by a blind write.
          // What must NEVER happen is this write clobbering the concurrent
          // writer's own change, which the CAS prevents structurally.
          if (sb && !fetchFailed) {
            const freshSnapshot = basisSnapshot ?? {};
            const priorEntries = Array.isArray(freshSnapshot.postApprovalReprices)
              ? freshSnapshot.postApprovalReprices
              : [];
            const entry = {
              at: new Date().toISOString(),
              by: operator?.email ?? null,
              previous_total: previousTotalUsd,
              new_total: newTotalUsd,
              delta: deltaUsd,
            };
            const { data: repriceAuditRows, error: repriceAuditError } = await sb
              .from('quotes')
              .update({
                approval_snapshot: {
                  ...freshSnapshot,
                  postApprovalReprices: [...priorEntries, entry],
                },
              })
              .eq('id', quoteId as string)
              // Serialize jsonb explicitly — PostgREST string-interpolates
              // filter values (mirrors apply-color-request.ts).
              .eq('approval_snapshot', JSON.stringify(freshSnapshot))
              .select('id');
            if (repriceAuditError) {
              console.error(
                '[quote/route] row 344: failed to record post-approval reprice audit entry:',
                repriceAuditError.message,
              );
            } else if (!repriceAuditRows || repriceAuditRows.length === 0) {
              // Lost the race to a concurrent approval_snapshot writer (e.g.
              // apply-color-request / color-change-request). Accepted,
              // survivable: drop this one audit entry rather than clobber
              // whatever they just wrote.
              console.warn(
                '[quote/route] row 344: reprice audit entry dropped — approval_snapshot changed concurrently for quote',
                quoteId,
              );
            }
          }
        }
      }
    }

    // FIX B (#237 fix round, staff/admin-lens HIGH/MED — the two lenses
    // converged on the same gap from different angles, see the fix round's
    // brief): the send route only ever pushed an event quote's date to GHL
    // on SEND. The everyday reschedule never re-pushes: the customer
    // confirms/reschedules after the quote already went out, staff edit the
    // date and hit Save (NOT Send — re-sending would re-text/re-email the
    // customer), and this route had zero HighLevel logic at all. The CRM
    // then holds a stale date indefinitely — exactly the manual re-entry
    // this feature exists to eliminate.
    //
    // Placement: here, in the UPDATE branch, not a new endpoint or a
    // dedicated "sync to CRM" button — an operator-triggered action would be
    // safer in the abstract, but this route is ALREADY the one place every
    // date edit passes through (the builder's Save/Calculate flow), so
    // piggy-backing is less surface, not more, and needs no new UI.
    //
    // Gates, deliberately narrower than "any event quote save":
    //   - isUpdate && saved: only an in-place update that actually PERSISTED
    //     — never on a brand-new quote (saveQuote's branch), and never when
    //     the DB write itself failed.
    //   - existing.quote_sent_at != null: only an ALREADY-SENT quote has a
    //     real CRM contact worth correcting for this reason. A draft quote's
    //     date is unconfirmed, staff may be mid-edit across several
    //     Calculate clicks, and there is no "everyday reschedule" to fix yet
    //     — pushing here would spam the contact's record with in-progress
    //     values instead of the eventual final one.
    //   - effectiveServiceType === 'event' (positive gate, never
    //     `!== 'permanent'`, per this repo's standing rule).
    //   - !existing.is_test / existing.highlevel_contact_id: identical to
    //     the send route's own gates — never touch a real GHL contact for a
    //     simulated quote, and there must be a contact to push to.
    //   - the FORMATTED value actually changed vs. what's already stored —
    //     compared through formatEventDateForGhl (the exact function the
    //     push itself uses), not a raw string compare, so a blank<->
    //     malformed no-op, or an unrelated field edit (a price override, an
    //     item added, ...) on the SAME already-sent event quote, never fires
    //     a spurious push. This is what stops the push from firing on every
    //     Calculate click.
    //
    // Booked-order amend (src/app/api/quotes/[id]/amend/route.ts): that
    // route only records the amendment TRAIL entry — the actual re-price
    // that changes inputs/result for a booked order runs through THIS same
    // isUpdate branch first (with amendReprice=true bypassing the
    // REPRICE_LOCKED_STATUSES guard above), so a date change on a booked
    // order's amend is covered for free by the gates above (quote_sent_at is
    // set for a booked order too) — no separate wiring needed in
    // amend/route.ts itself.
    //
    // Not awaited: unlike the send route's ghlStageChain (which already
    // tolerates several seconds of GHL latency inside its own
    // Promise.allSettled group and reports the outcome back to the operator
    // via eventDateSyncError — FIX A of round 1), this route answers a
    // routine builder Save/Calculate click with no equivalent warning
    // mechanism. Blocking the save on a GHL round trip would make Save
    // itself feel slow for a CRM write the operator isn't watching for — and
    // the gate above already means this only fires on the rare click that
    // actually changed the date, not on every save. pushEventDateToGhl is
    // already fail-soft and internally deadline-bounded (6s, see
    // ghlEventDate.ts) — a failure here only logs, exactly like every other
    // best-effort GHL call site in this codebase; there is nothing to await
    // FOR.
    //
    // FIX A (#237 fix round 2, technical HIGH): "not awaited" used to mean a
    // bare `void pushEventDateToGhl(...)` immediately before this handler's
    // `return NextResponse.json(...)` below — src/lib/referrals.ts's
    // ensureReferralCode (see its "Review fix 8" comment) documents exactly
    // why that's unsafe: a detached child promise started on the main
    // request path is NOT covered by `waitUntil`, which "only extends the
    // invocation for the promise(s) actually passed to after()"
    // (node_modules/next/dist/docs/.../after.md) — so once this handler's
    // own response promise resolves, the platform may reclaim the execution
    // context before the in-flight GHL call (up to its own 6s deadline)
    // finishes. Nothing here surfaces that failure to the operator (unlike
    // the send route's eventDateSyncError), so a reclaimed context makes the
    // push silently, non-deterministically inert — a clean Save with no
    // indication the date never synced. Wrapped in `after()` here, 1:1 with
    // referrals.ts's own nested-after() call: registers with whatever
    // waitUntil the current request context provides, with no added latency
    // for this handler's own response (still not awaited).
    if (
      isUpdate &&
      saved &&
      existing &&
      existing.quote_sent_at &&
      effectiveServiceType === 'event' &&
      !existing.is_test &&
      existing.highlevel_contact_id
    ) {
      // FIX D (#237 fix round 2, technical MED — TOCTOU): `existing` above was
      // read at the very TOP of this handler, before customer resolution,
      // design projection, and pricing — a wide window. Two overlapping
      // Calculate requests on the SAME quote can leave GHL stuck on a
      // superseded date while the DB is correct, silently: A reads D1, writes
      // D2, pushes D2 (GHL=D2); B ALSO read D1 before A's write landed,
      // writes D1 back, and — if this compared against B's own stale
      // `existing` — would see D1-vs-D1, no change, never push, leaving
      // GHL=D2 stuck against a DB that now correctly says D1.
      // `saved.priorInputs` (quotes.ts, SaveQuoteResult) is updateQuote's OWN
      // late pre-read, taken immediately before its `.update()` call rather
      // than here — so it reflects whatever the LAST write actually left in
      // place (A's D2, in the scenario above), not this handler's early
      // snapshot. Comparing against that instead correctly detects B's write
      // as a real change from D2 back to D1 and re-pushes, keeping GHL
      // aligned with whatever the DB now holds. This narrows the race window
      // to two back-to-back Supabase calls inside updateQuote instead of the
      // whole request — not a full elimination (that needs a row lock or an
      // optimistic-concurrency version column across the route, out of scope
      // for a MED) but far below "two ops Calculate the same quote within a
      // double-digit-millisecond window," which this internal tool's usage
      // doesn't plausibly produce. Falls back to the old early snapshot only
      // when priorInputs comes back null (see StoredIdentityRow's comment in
      // quotes.ts for when that happens) — degraded, not broken.
      const priorInputs = saved.priorInputs ?? existing.inputs;
      const priorFormatted = formatEventDateForGhl(priorInputs?.event?.eventDate);
      const nextFormatted = formatEventDateForGhl(quoteInputs.event?.eventDate);
      if (nextFormatted && nextFormatted !== priorFormatted) {
        // #314 fix round: stamp quotes.ghl_event_date_pushed on a CONFIRMED
        // push, same as the send route and the approve route's own reconcile
        // — see ghlEventDate.ts's migration comment for why this marker (not
        // GHL's live value) is what the approve-time reconcile compares
        // against. Best-effort, inside the same after() task: a failed stamp
        // only means a later reconcile may re-push a value GHL already has
        // (harmless, a plain overwrite), never that a real change goes
        // unpushed.
        const contactId = existing.highlevel_contact_id;
        const targetQuoteId = quoteId as string;
        after(async () => {
          const { pushed } = await pushEventDateToGhl(contactId, quoteInputs.event?.eventDate);
          if (!pushed) return;
          const sb = getSupabaseServiceClient();
          if (!sb) return;
          const { error } = await sb
            .from('quotes')
            .update({ ghl_event_date_pushed: nextFormatted })
            .eq('id', targetQuoteId);
          if (error) {
            console.error('[api/quote] failed to stamp ghl_event_date_pushed (#314):', error.message);
          }
        });
      }
    }

    return NextResponse.json({
      customer: safeCustomer,
      result,
      baseline, // #104 — overrides-stripped, for the "was $X" display
      quoteId: saved?.id ?? null,
      persisted: saved !== null,
      // #839 fix-round MED: updateQuote's #251 identity freeze used to be
      // log-only when it actually refused a would-be reattach on an
      // approved/booked quote. Propagate the flag (absent on a brand-new
      // insert — saveQuote never sets it) so the builder can show a small
      // notice instead of the save silently succeeding with a stale link.
      ...(saved?.identityFrozen ? { identityFrozen: true } : {}),
      // Row 344 Part B — set only when THIS save actually reprices an
      // approved-not-booked quote (see the computation above). The builder
      // shows a staff-facing notice off this; propagated even if the
      // best-effort audit-trail write above failed, so the signal never
      // silently depends on that write succeeding.
      ...(repricedAfterApproval ? { repricedAfterApproval } : {}),
    });
  } catch (err) {
    console.error('Quote calculation error:', err);
    return NextResponse.json({ error: 'Failed to calculate quote' }, { status: 500 });
  }
}
