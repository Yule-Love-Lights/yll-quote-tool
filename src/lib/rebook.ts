import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { cloneDesignToNewQuote } from './designs';
import { allocateNumber } from './displayId';
import { getCustomer, unarchiveProperty } from './customers';
import { asServiceType, canCarryNceOrYllNeighborTag, DEFAULT_SERVICE_TYPE } from './serviceType';
import { NCE_DEPOSIT_PERCENT } from '@/lib/pricing/pricingEngine';

// "Rebook last season" (ledger #83, Phase 5). One click clones a customer/
// property's last APPROVED quote — its priced inputs/result + its design (scene
// + base photo) — into a fresh DRAFT quote for the new season. See
// docs/jobber-flow/SPEC.md §4.5.
//
// Depends on the customers/properties identity (src/lib/customers.ts): the
// source quote is found by quotes.customer_id, so the backfill must have linked
// the customer's history first.
//
// The pure builder (buildRebookInsert) is unit-tested without a DB; the DB
// orchestration (rebookLastSeason) is a thin clone + design copy.

// The identity/pricing columns carried from the source quote into the clone.
export type RebookSource = {
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  highlevel_contact_id?: string | null;
  service_type?: string | null;
  inputs: unknown;
  result: { total?: number } | null;
  customer_id?: string | null;
  property_id?: string | null;
  is_test?: boolean | null;
  // NCE + YLL Neighbor tags (#198): the SOURCE quote's own tags — carried
  // forward as a plain clone-field default (like is_test above). rebookLastSeason
  // overrides these with the CUSTOMER's current tags before calling
  // buildRebookInsert (a customer may have been tagged more recently than
  // their last approved quote); rebookFromQuote (#116 exact-quote revive)
  // leaves them as-is, so a revived quote simply keeps its own tags.
  legacy_rebook?: boolean | null;
  is_nce?: boolean | null;
  // #226 round 3: the source quote's approval timestamp — see
  // rebookFromQuote's own #226 comment for why this (not status) is the
  // correct decoupling signal for its resetNceDepositOnOff decision.
  customer_approved_at?: string | null;
};

// PURE — the column set a rebooked quote INSERTs. Copies the customer + the
// priced inputs/result/service_type + the customer/property link, and carries
// NOTHING from the lifecycle (no quote_sent_at / customer_approved_at /
// deposit_paid_at, no approval_snapshot), so the clone lands as a fresh draft.
// status is set explicitly to 'draft' to match saveQuote's invariant (a persisted
// status, not a NULL that relies on the deriveStatus fallback) now that the
// status spine has merged. The new id + created_at come from the DB defaults.
// service_type is only set when present so the clone can't reset the column to NULL.
// A rebooked permanent/event quote must re-price at CURRENT rates when staff click
// Calculate on the new draft — result.permanentRatesSnapshot / result.eventRatesSnapshot
// are the rate-freeze guard for OUTSTANDING quotes, NOT a brand-new season's draft.
// Strip BOTH from the carried result so the /api/quote update branch's price source
// falls through to live app_settings rates (it reads existing?.result?.<vertical>RatesSnapshot
// ?? live for whichever vertical). rebookLastSeason doesn't filter by service_type, so
// the source can be either vertical. No-op for holiday results (no snapshot present).
//
// #199 (F1 review fix): also strips result.depositRate — a SNAPSHOT only a
// full recompute writes (Calculate / POST /api/quote). Money-read call sites
// now prefer live inputs.depositPercent over this field (see
// chargesFromResult's own comment, derivePackages.ts), so an NCE clone's 40%
// already displays correctly even with this stale — but leaving a
// last-season rate sitting here is misleading dead data on a fresh draft,
// and any FUTURE direct reader of result.depositRate (bypassing
// chargesFromResult) would otherwise see last season's rate. Unconditional,
// like the other three strips: every rebooked draft re-prices at Calculate.
//
// #226 (adversarial-review HIGH, live-prod bug): the strip above only covers
// result.depositRate. inputs.depositPercent itself was NEVER reset on a
// false-resolving NCE clone — applyNceDepositDefault below only ever ADDED
// 40 on the true path. rebookLastSeason resolves is_nce from the CUSTOMER's
// CURRENT tag (deliberate — see its own #198 comment), so a customer who
// left the barter network since their last approved quote could still get
// rebooked with a carried-over depositPercent=40, pricing and charging the
// new draft at 40% under a false is_nce.
function stripRatesSnapshots(result: RebookSource['result']): RebookSource['result'] {
  if (!result || typeof result !== 'object') return result;
  const rest = { ...(result as Record<string, unknown>) };
  delete rest.permanentRatesSnapshot;
  delete rest.eventRatesSnapshot;
  delete rest.permanentBistroRatesSnapshot;
  delete rest.depositRate;
  return rest as RebookSource['result'];
}

// #41 adversarial-review HIGH fix: a rebooked quote must RE-EARN and
// RE-APPLY its own referral credit on its own next booking, never inherit
// the source quote's. Without this, cloning an approved quote that had a referral
// credit applied would carry the `discount` + `referralCredit` provenance
// straight onto the new DRAFT — which still shows "credit applied" even
// though this new quote's credited rows/consumedRowIds belong to the OLD
// quote entirely. Mirrors stripRatesSnapshots's shallow-copy-and-delete.
function stripDiscountAndReferralCredit(inputs: unknown): unknown {
  if (!inputs || typeof inputs !== 'object') return inputs;
  const rest = { ...(inputs as Record<string, unknown>) };
  delete rest.discount;
  delete rest.referralCredit;
  return rest;
}

// NCE 40% deposit default (#199): mirrors the builder chip's/admin toggle's
// turn-on rule (resolveNceDepositPercent / the nce route's own deposit-write)
// for a REBOOKED quote — a clone that resolves NCE=true starts the new
// season at NCE's 40% deposit unless the SOURCE quote already carried an
// explicit staff-set depositPercent (kept — a deliberate hand-edit from last
// season carries forward, same "no lock, no lost work" posture as every
// other rebooked input). No-op when inputs isn't a plain object, mirroring
// stripDiscountAndReferralCredit's own guard. The ON branch runs for BOTH
// rebook paths (rebookLastSeason's customer-tag resolution + #116's
// exact-quote revive) since both build their insert row through
// buildRebookInsert — there's no false-positive risk turning ON, the NCE
// rule is the only thing that ever writes 40 to begin with.
//
// #226 (adversarial-review HIGH, live-prod bug fix, ROUND 2 — delta-verify
// caught the round-1 fix was too broad): the OFF/false path resets an
// untouched depositPercent=40 to an explicit 0 (never a deleted key — see
// chargesFromResult's stale-fallback trap, #226 in the nce route) — but
// ONLY when `resetOnOff` is true. The two callers resolve is_nce=false from
// DIFFERENT signals:
//   - rebookLastSeason resolves is_nce from the CUSTOMER's CURRENT tag. If
//     that's false, the customer genuinely left the barter network since
//     their last approved quote — a carried-over 40 is very likely stale
//     NCE residue, so resetting has a real signal behind it. Passes
//     resetOnOff=true.
//   - rebookFromQuote (#116 exact-quote revive) resolves is_nce from the
//     SOURCE QUOTE's own tag. Round 2 assumed "is_nce=false on that quote ⇒
//     the NCE rule never touched its depositPercent ⇒ any 40 is hand-typed"
//     and always passed resetOnOff=false. ROUND 3 (delta-verify HIGH): that
//     premise is false on a reachable path — the admin nce route
//     (src/app/api/quotes/[id]/nce/route.ts) only resets depositPercent on
//     toggle-OFF while `customer_approved_at` is still null (the #177 freeze
//     guard). An NCE-tagged, then-approved, then-untagged quote is left
//     holding is_nce=false + a RULE-SET depositPercent=40 that toggle-off
//     was never allowed to touch — is_nce and depositPercent have decoupled.
//     `customer_approved_at` surviving into a later terminal status
//     (declined via staff-decline's approved→declined transition, or
//     cancelled) doesn't change this: the nce route's guard keys on
//     customer_approved_at, not on status, so the same decoupling holds. A
//     never-approved source is unaffected — there the toggle-off DOES reset,
//     so a surviving 40 really is hand-typed. rebookFromQuote below therefore
//     passes resetOnOff = (src.customer_approved_at != null), mirroring the
//     nce route's own guard exactly instead of guessing from is_nce alone.
// Any other stored value (not exactly 40) is left alone regardless of
// resetOnOff, same as before.
function applyNceDepositDefault(inputs: unknown, isNce: boolean, resetOnOff: boolean): unknown {
  if (!inputs || typeof inputs !== 'object') return inputs;
  const current = (inputs as { depositPercent?: unknown }).depositPercent;
  if (isNce) {
    if (typeof current === 'number' && current > 0) return inputs; // explicit hand-set — keep
    return { ...(inputs as Record<string, unknown>), depositPercent: NCE_DEPOSIT_PERCENT };
  }
  if (resetOnOff && current === NCE_DEPOSIT_PERCENT) {
    return { ...(inputs as Record<string, unknown>), depositPercent: 0 };
  }
  return inputs;
}

// #243 (domain rule locked 2026-08-11): permanent/event/bistro quotes can
// never carry the NCE or YLL Neighbor tag. This is the ONE place both rebook
// paths (rebookLastSeason's customer-tag resolution + rebookFromQuote's
// exact-quote revive) funnel their resolved is_nce/legacy_rebook through —
// gating here closes both without duplicating the check at each call site.
// The CLONE's own service_type (carried from src.service_type a few lines
// below, unrelated to the caller's resetNceDepositOnOff intent) decides
// eligibility; canCarryNceOrYllNeighborTag (serviceType.ts) is the single
// source of truth every set/inherit site shares, so this can't drift from
// the builder chips'/admin routes' own gate. Without this, e.g.
// rebookLastSeason resolving is_nce=true from a customer's CURRENT tag while
// their last APPROVED quote happens to be a permanent one (rebookLastSeason
// doesn't filter its source query by service_type — see its own comment)
// would carry the trade tag onto a real-money clone.
export function buildRebookInsert(
  src: RebookSource,
  opts: { resetNceDepositOnOff?: boolean } = {},
): Record<string, unknown> {
  const srcIsNce = src.is_nce ?? false;
  const eligibleForTags = canCarryNceOrYllNeighborTag(
    asServiceType(src.service_type) ?? DEFAULT_SERVICE_TYPE,
  );
  const isNce = eligibleForTags && srcIsNce;
  // The gate forcing is_nce off is itself an "this NCE state is invalid"
  // signal at least as strong as rebookLastSeason's own customer-untagged
  // case (which already opts into resetOnOff below) — so suppressing the tag
  // also resets a stale 40% deposit the same way, regardless of what the
  // caller passed. Never fires unless the gate actually changed something
  // (srcIsNce was true and got suppressed) — a source that was never NCE, or
  // a holiday-eligible clone, is unaffected.
  const gateForcedNceOff = srcIsNce && !isNce;
  return {
    customer_name: src.customer_name ?? 'Anonymous',
    customer_address: src.customer_address ?? '(no address)',
    customer_phone: src.customer_phone ?? null,
    customer_email: src.customer_email ?? null,
    highlevel_contact_id: src.highlevel_contact_id ?? null,
    status: 'draft',
    ...(src.service_type ? { service_type: src.service_type } : {}),
    inputs: applyNceDepositDefault(
      stripDiscountAndReferralCredit(src.inputs),
      isNce,
      (opts.resetNceDepositOnOff ?? false) || gateForcedNceOff,
    ),
    result: stripRatesSnapshots(src.result),
    total: src.result?.total ?? 0,
    customer_id: src.customer_id ?? null,
    property_id: src.property_id ?? null,
    // W2-002: carry the source's test flag so a rebooked TEST quote stays a
    // TEST quote — otherwise it defaults to false (real) and pollutes the
    // dashboard/jobs/invoices/PO surfaces that trust is_test as the isolation
    // boundary (#93).
    is_test: src.is_test ?? false,
    // NCE + YLL Neighbor tags (#198) — see the RebookSource field comments
    // above for which value each caller passes in. #243: both gated by
    // eligibleForTags above — a permanent/event/bistro clone can never carry
    // either tag, no matter what the source quote or customer resolved.
    legacy_rebook: eligibleForTags && (src.legacy_rebook ?? false),
    is_nce: isNce,
  };
}

// The columns the source-quote lookup selects (kept in one place so the query +
// the RebookSource shape stay in sync).
const SOURCE_COLUMNS =
  'id, customer_name, customer_address, customer_phone, customer_email, highlevel_contact_id, service_type, inputs, result, customer_id, property_id, is_test, legacy_rebook, is_nce, customer_approved_at';

// Best-effort sequential quote_number (ledger #83, SPEC §4.6) for a rebooked
// clone — same allocateNumber('quote_number_seq') + try/catch-omit pattern
// saveQuote uses. A failed allocation (RPC/sequence missing) must NOT block
// the rebook; the column is nullable and the truncated-UUID display (#77)
// still works. Without this, rebooked quotes silently skip the sequence and
// are missed by any number search/sort.
async function allocateRebookQuoteNumber(caller: string): Promise<number | null> {
  try {
    return await allocateNumber('quote_number_seq');
  } catch (err) {
    console.warn(`${caller}: quote_number allocation skipped:`, err);
    return null;
  }
}

// #205 review fix (customer/staff HIGH, F1 — "related, same root"): a
// rebook that resolves onto an ARCHIVED property resurrects it. Both
// rebookLastSeason and rebookFromQuote below insert the new quote via a
// raw `.from('quotes').insert()` that bypasses findOrCreateProperty
// entirely — the function that normally carries the archive-resurrection
// rule (see its own #205 comment in customers.ts) — so without this, a
// rebook could silently point a brand-new LIVE draft at a property staff
// had archived: exactly the "silently-hidden-but-active" state that rule
// exists to prevent, reached through a different door.
//
// Read-then-write (not an unconditional unarchiveProperty call) so this
// only writes — and only logs — when a resurrection is ACTUALLY happening;
// rebooking onto an already-live property stays a no-op, same "no needless
// write" discipline as findOrCreateProperty's own resurrection branch.
//
// Best-effort: a failure here must never block the rebook itself (mirrors
// attachQuoteToCustomer's hl_contact_id heal in customers.ts).
async function resurrectPropertyForRebook(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  customerId: string | null | undefined,
  propertyId: string | null | undefined,
  caller: string,
): Promise<void> {
  if (!customerId || !propertyId) return;
  try {
    const { data: propRow } = await sb
      .from('properties')
      .select('archived_at')
      .eq('id', propertyId)
      .eq('customer_id', customerId)
      .maybeSingle<{ archived_at: string | null }>();
    if (!propRow?.archived_at) return; // already live, or no such row — nothing to do
    const { error } = await unarchiveProperty(customerId, propertyId);
    if (error) {
      console.warn(`${caller}: resurrect-on-rebook failed for property ${propertyId} (customer ${customerId}):`, error);
    } else {
      console.info(`${caller}: un-archived property ${propertyId} for customer ${customerId} (triggered by rebook)`);
    }
  } catch (err) {
    console.warn(`${caller}: resurrect-on-rebook threw for property ${propertyId} (customer ${customerId}):`, err);
  }
}

// Clone a customer's last APPROVED quote (+ its design) into a fresh draft.
// `propertyId` optionally scopes the source to one property (a customer with a
// home + a rental rebooks the right one). Returns the new quote id + the cloned
// design id (null when the source had no design). Returns null when there is no
// approved quote to rebook from, or Supabase isn't configured.
export async function rebookLastSeason(
  customerId: string,
  propertyId?: string | null,
  // Actor audit trail (#90): the operator's Supabase user id, or null when the
  // auth gate is dormant (no session) / the caller doesn't have one. Same
  // convention as saveQuote's createdBy param.
  createdBy: string | null = null,
): Promise<{ quoteId: string; designId: string | null } | null> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return null;

  // The most recent approved quote for this customer (optionally one property).
  // "Approved" (customer_approved_at set) = what they agreed to last season —
  // the design worth cloning.
  let query = sb
    .from('quotes')
    .select(SOURCE_COLUMNS)
    .eq('customer_id', customerId)
    .not('customer_approved_at', 'is', null)
    .order('customer_approved_at', { ascending: false })
    .limit(1);
  if (propertyId) query = query.eq('property_id', propertyId);

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error('rebookLastSeason (source) error:', error);
    return null;
  }
  if (!data) return null; // no approved quote to rebook from
  const src = data as RebookSource & { id: string };

  // NCE + YLL Neighbor tags (#198): inherit the CUSTOMER's CURRENT tags
  // (customer→quote inheritance), not necessarily whatever this particular
  // old approved quote happened to carry — the customer may have been tagged
  // more recently (profile edit, or propagation off a later quote) than their
  // last approved one. Best-effort: getCustomer fails soft (null on error /
  // unconfigured), which falls back to the source quote's own tag below.
  const customer = await getCustomer(customerId);

  const quoteNumber = await allocateRebookQuoteNumber('rebookLastSeason');
  // Honor an explicit property scope; otherwise keep the source's property.
  const targetPropertyId = propertyId ?? src.property_id ?? null;
  // #205 F1: resurrect if the target is archived — see resurrectPropertyForRebook.
  await resurrectPropertyForRebook(sb, customerId, targetPropertyId, 'rebookLastSeason');
  const insertRow = {
    ...buildRebookInsert(
      {
        ...src,
        property_id: targetPropertyId,
        legacy_rebook: customer?.is_yll_neighbor ?? src.legacy_rebook ?? false,
        is_nce: customer?.is_nce ?? src.is_nce ?? false,
      },
      // #226 round 2: is_nce here resolves from the CUSTOMER's current tag
      // (not this quote's own history), so a false reading is a real signal
      // the customer left the barter network — reset an untouched 40. See
      // applyNceDepositDefault's own comment for why rebookFromQuote below
      // does NOT pass this.
      { resetNceDepositOnOff: true },
    ),
    ...(quoteNumber != null ? { quote_number: quoteNumber } : {}),
    created_by: createdBy,
  };
  const ins = await sb.from('quotes').insert(insertRow).select('id').single();
  if (ins.error || !ins.data) {
    console.error('rebookLastSeason (insert) error:', ins.error);
    return null;
  }
  const newQuoteId = ins.data.id as string;

  // Clone the design (scene + base photo + satellite). Best-effort: a missing or
  // failed clone still yields a usable rebooked quote (staff can re-pull).
  let designId: string | null = null;
  try {
    const cloned = await cloneDesignToNewQuote(src.id, newQuoteId);
    designId = cloned?.id ?? null;
  } catch (err) {
    console.error('rebookLastSeason (design clone) failed:', err);
  }

  return { quoteId: newQuoteId, designId };
}

// Clone a SPECIFIC quote (by id, any status) into a fresh draft — the #116
// "revive a dead quote" path. Unlike rebookLastSeason (which finds a customer's
// last APPROVED quote), this reopens exactly the quote the operator picked,
// including a declined / cancelled / abandoned one, and leaves the original terminal
// quote INTACT for the audit trail. Reuses buildRebookInsert (strips the
// lifecycle + the frozen rate snapshots so the draft re-prices at live rates)
// and cloneDesignToNewQuote. Returns the new quote id + the cloned design id
// (null when the source had no design), or null when the id doesn't match a
// quote or Supabase isn't configured.
export async function rebookFromQuote(
  quoteId: string,
  // Actor audit trail (#90): the operator's Supabase user id, or null when the
  // auth gate is dormant (no session) / the caller doesn't have one. Same
  // convention as saveQuote's createdBy param.
  createdBy: string | null = null,
): Promise<{ quoteId: string; designId: string | null } | null> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return null;

  const { data, error } = await sb
    .from('quotes')
    .select(SOURCE_COLUMNS)
    .eq('id', quoteId)
    .maybeSingle();
  if (error) {
    console.error('rebookFromQuote (source) error:', error);
    return null;
  }
  if (!data) return null; // no such quote to rebook from
  const src = data as RebookSource & { id: string };

  const quoteNumber = await allocateRebookQuoteNumber('rebookFromQuote');
  // #205 F1: resurrect if the source's property is archived — same rule as
  // rebookLastSeason above; rebookFromQuote always carries src.property_id
  // through unchanged (no property-scope override param), so that's the
  // one target to check here.
  await resurrectPropertyForRebook(sb, src.customer_id, src.property_id, 'rebookFromQuote');
  const insertRow = {
    ...buildRebookInsert(src, {
      // #226 round 3: reset an untouched depositPercent=40 exactly when the
      // source quote was EVER approved — the same signal the nce route's own
      // toggle-off guard checks (customer_approved_at, not status). See
      // applyNceDepositDefault's own comment above for the full trace.
      resetNceDepositOnOff: src.customer_approved_at != null,
    }),
    ...(quoteNumber != null ? { quote_number: quoteNumber } : {}),
    created_by: createdBy,
  };
  const ins = await sb.from('quotes').insert(insertRow).select('id').single();
  if (ins.error || !ins.data) {
    console.error('rebookFromQuote (insert) error:', ins.error);
    return null;
  }
  const newQuoteId = ins.data.id as string;

  // Clone the design (scene + base photo + satellite). Best-effort, same as
  // rebookLastSeason: a missing or failed clone still yields a usable draft.
  let designId: string | null = null;
  try {
    const cloned = await cloneDesignToNewQuote(src.id, newQuoteId);
    designId = cloned?.id ?? null;
  } catch (err) {
    console.error('rebookFromQuote (design clone) failed:', err);
  }

  return { quoteId: newQuoteId, designId };
}
