import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { QuoteInputs, QuoteResult, liveDepositRate } from './pricing/pricingEngine';
import { ServiceType, DEFAULT_SERVICE_TYPE, asServiceType } from './serviceType';
import { deleteDesign, deleteDesignsForQuote } from './designs';
import { allocateNumber } from './displayId';
import type { QuoteStatus } from './quoteStatus';
import { wasEverApproved } from './quoteStatus';
import type { AmendmentTrailEntry } from './amend';
import { attachQuoteToCustomer, propagateQuoteTagsToCustomer, quoteRowToIdentity } from './customers';
import { createPendingReferral } from './referrals';

export type QuoteListItem = {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  total: number | null;
  created_at: string;
  // Lifecycle flags. Admin UI uses these to show "Sent" / "Approved" badges
  // and to short-circuit the "Send to customer" button when already sent.
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  // Valor deposit-paid timestamp — set = "Booked" (the #38 deposit flow). Read
  // by deriveStatus() so the admin list shows the Booked badge.
  deposit_paid_at: string | null;
  // View receipt (#68): when the customer opened their portal link. Admin shows
  // a "Viewed" badge (with the count + last-open time on hover).
  viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number | null;
  // Explicit lifecycle status (ledger #83 Phase 1). NULL on legacy / pre-migration
  // rows — surfaces fall back to deriveStatus(row) from the timestamps above. The
  // decline reason + sequential display number land alongside it.
  status: QuoteStatus | null;
  decline_reason: string | null;
  quote_number: number | null;
  // Fully-simulated test data (ledger #93). Admin/jobs/inventory show a TEST
  // badge; the dashboard + persisted customer list exclude these. Always a real
  // boolean (DB column is NOT NULL DEFAULT false).
  is_test: boolean;
  // Service line (#123): holiday (default) / permanent / event. NULL on legacy
  // pre-migration rows — the admin list reads it as DEFAULT_SERVICE_TYPE.
  service_type: ServiceType | null;
  // Legacy rebook (#155/#158): quote migrated from last year's Jobber data —
  // the admin list shows a "YLL Neighbor" badge (YllNeighborBadge).
  legacy_rebook: boolean;
  // NCE tag (#198): quote-level "Mark as NCE" flag (the barter/trade network
  // YLL belongs to) — the admin list shows an "NCE" badge (NceBadge). No
  // inbox/stats exclusions, unlike legacy_rebook.
  is_nce: boolean;
  // View-only portal (#176): staff-flagged browse-only quote — the portal
  // stays fully viewable but every approve/pay/decline/request-changes path
  // is blocked. The admin list/detail shows a pill + the ViewOnlyToggle.
  view_only: boolean;
  // Customer detail-page route id fields (same precedence as
  // src/lib/dashboard/customers.ts customerRouteId: highlevel_contact_id, else
  // customer_id) — lets the admin quotes list link a customer name to their
  // profile.
  highlevel_contact_id: string | null;
  customer_id: string | null;
  // Row 409 — the deposit rate (0-1) this quote is actually on, resolved HERE
  // rather than in the UI so the admin list can never show a rate the charge
  // path disagrees with. An NCE quote is EXPECTED to sit at
  // NCE_DEPOSIT_PERCENT, but nothing enforces that (Jason's 2026-08-25 ruling),
  // so the list surfaces the real number instead of assuming it.
  deposit_rate: number;
  // Row 409 fix round (admin lens): whether `deposit_rate` is the rate FROZEN
  // into the approval snapshot, or merely the current one. 8 of 24 live
  // approved/booked quotes have no frozen rate — the staff/verbal approve path
  // writes a minimal snapshot — so a surface that implies "this is what was
  // agreed" would be wrong a third of the time.
  deposit_rate_frozen: boolean;
};

export async function listQuotes(limit = 500): Promise<QuoteListItem[]> {
  // Use service client so admin listings ignore RLS restrictions. NOTE: the
  // admin list intentionally keeps test quotes VISIBLE (badged) — the is_test
  // exclusion lives only in the dashboard chokepoint, not here.
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('quotes')
    .select(
      // Row 409: the three deposit inputs are pulled as scalar JSON paths, not
      // as whole `inputs`/`result`/`approval_snapshot` blobs — those are large
      // and this list runs 500 rows deep.
      'id, customer_name, customer_address, customer_phone, customer_email, total, created_at, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, last_viewed_at, view_count, status, decline_reason, quote_number, is_test, service_type, legacy_rebook, is_nce, view_only, highlevel_contact_id, customer_id, deposit_percent_raw:inputs->>depositPercent, result_deposit_rate_raw:result->>depositRate, snapshot_deposit_rate_raw:approval_snapshot->customerSelection->>depositRate',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('Supabase listQuotes error:', error);
    return [];
  }
  return (data ?? []).map((row) => {
    const { deposit_percent_raw, result_deposit_rate_raw, snapshot_deposit_rate_raw, ...rest } =
      row as Record<string, unknown>;
    const snapshotRate = numberOrUndefined(snapshot_deposit_rate_raw);
    return {
      ...(rest as Omit<QuoteListItem, 'deposit_rate' | 'deposit_rate_frozen'>),
      deposit_rate: resolveQuoteDepositRate({
        depositPercent: numberOrUndefined(deposit_percent_raw),
        resultRate: numberOrUndefined(result_deposit_rate_raw),
        snapshotRate,
      }),
      deposit_rate_frozen: snapshotRate !== undefined,
    };
  });
}

// PostgREST returns `->>` paths as TEXT (or null), so every deposit input
// arrives as a string here. Anything that isn't a finite number — null, '', a
// legacy garbage value — becomes undefined so the resolution below falls
// through to the next source instead of propagating NaN into a displayed rate.
function numberOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Row 409 — the deposit rate (0-1) a quote is on, for DISPLAY. Precedence
// mirrors the money paths exactly: an approved quote's frozen
// approval_snapshot.customerSelection.depositRate is what the customer agreed
// to and what the Valor webhook charges against (see
// src/app/api/integrations/valor/webhook/route.ts), so it wins outright;
// otherwise the live rate is chargesFromResult's own rule, shared as
// liveDepositRate so the two cannot drift.
export function resolveQuoteDepositRate(args: {
  depositPercent?: number;
  resultRate?: number;
  snapshotRate?: number;
}): number {
  return args.snapshotRate ?? liveDepositRate(args.depositPercent, args.resultRate);
}

export async function deleteQuote(id: string): Promise<void> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) throw new Error('Supabase not configured');
  // Audit fix (customer-photo-retention-deletion): erase the linked design +
  // its private bucket images FIRST, before the quote row. The designs FK is
  // `on delete set null`, so deleting only the quote would orphan the design row
  // and leave the customer's house photo + satellite image in storage forever.
  // Best-effort: a design-cleanup failure is logged inside deleteDesignsForQuote
  // and must not block the quote delete the operator asked for.
  await deleteDesignsForQuote(id);
  const { error } = await sb.from('quotes').delete().eq('id', id);
  if (error) throw new Error(`deleteQuote: ${error.message}`);
}

export async function deleteAllQuotes(): Promise<number> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) throw new Error('Supabase not configured');
  // Audit fix (customer-photo-retention-deletion): erase EVERY design + its
  // private bucket images before bulk-deleting the quotes, so a "delete all"
  // doesn't leave a bucket full of orphaned customer photos. We delete designs
  // linked to a quote (quote_id not null); unlinked, never-Calculated designs
  // are intentionally left (they belong to no quote and aren't dropped by a
  // quote wipe — out of scope for this fix, see decisionsForReviewer).
  const { data: linked, error: linkedError } = await sb
    .from('designs')
    .select('id')
    .not('quote_id', 'is', null);
  // quotes-delete-select-error: abort BEFORE the bulk quote delete on a failed
  // lookup. Without this, a transient error leaves `linked` null/empty, zero
  // designs get cleaned, and the quote delete proceeds anyway — orphaning
  // design rows (FK is `on delete set null`) with customer photos stranded in
  // the private bucket, the exact PII hole this function's cleanup exists to
  // close.
  if (linkedError) throw new Error(`deleteAllQuotes: ${linkedError.message}`);
  // W2-034: designs are mutually independent (each's cleanup is its own row +
  // storage-prefix delete), so nothing forces strictly-serial one-at-a-time
  // deletion. Bounded-concurrency chunks (mirrors customers.ts
  // backfillCustomersFromQuotes) instead of an unbounded Promise.all fan-out.
  const DELETE_CHUNK_SIZE = 8;
  const linkedIds = (linked ?? []).map((row) => row.id as string);
  for (let i = 0; i < linkedIds.length; i += DELETE_CHUNK_SIZE) {
    const chunk = linkedIds.slice(i, i + DELETE_CHUNK_SIZE);
    await Promise.all(chunk.map((id) => deleteDesign(id)));
  }
  // Supabase requires a filter on bulk deletes — use an always-true UUID
  // comparison. Returns count of deleted rows.
  const { error, count } = await sb
    .from('quotes')
    .delete({ count: 'exact' })
    .not('id', 'is', null);
  if (error) throw new Error(`deleteAllQuotes: ${error.message}`);
  return count ?? 0;
}

// Delete every test quote (ledger #93 "Delete test data"). Mirrors deleteQuote's
// per-quote design cleanup: erase each test quote's linked design + its private
// bucket images FIRST (the designs FK is `on delete set null`, so deleting only
// the quote would orphan the design row + leave the house photo in storage),
// then bulk-delete the test rows. The FK CASCADE on jobs.quote_id /
// invoices.quote_id removes each test quote's derived job + invoice
// automatically. Real (is_test = false) data is never touched. Idempotent:
// re-running with no test rows left deletes 0 and returns 0.
export async function deleteTestQuotes(): Promise<number> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) throw new Error('Supabase not configured');
  const { data: testRows, error: testRowsError } = await sb
    .from('quotes')
    .select('id')
    .eq('is_test', true);
  // quotes-delete-select-error: same abort-before-bulk-delete as deleteAllQuotes
  // above — a failed lookup must not fall through to the bulk delete as if no
  // test rows needed cleanup.
  if (testRowsError) throw new Error(`deleteTestQuotes: ${testRowsError.message}`);
  // W2-034: same bounded-concurrency chunking as deleteAllQuotes above — each
  // test quote's design cleanup is independent of the others.
  const DELETE_CHUNK_SIZE = 8;
  const testIds = (testRows ?? []).map((row) => row.id as string);
  for (let i = 0; i < testIds.length; i += DELETE_CHUNK_SIZE) {
    const chunk = testIds.slice(i, i + DELETE_CHUNK_SIZE);
    await Promise.all(chunk.map((id) => deleteDesignsForQuote(id)));
  }
  const { error, count } = await sb
    .from('quotes')
    .delete({ count: 'exact' })
    .eq('is_test', true);
  if (error) throw new Error(`deleteTestQuotes: ${error.message}`);
  return count ?? 0;
}

// Customer fields are all optional while we're in testing mode. Empty or
// missing values are persisted as "Anonymous" / null so admins can still
// sort/filter without blowing up on NOT NULL constraints.
export type Customer = {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
};

function blankToNull(v: string | undefined): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
}

// FIX D (#237 fix round 2, technical MED — TOCTOU): shared by saveQuote AND
// updateQuote purely so the ternary that picks between them in
// /api/quote/route.ts (`isUpdate ? await updateQuote(...) : await
// saveQuote(...)`) infers ONE clean type instead of a union TypeScript can't
// narrow on `isUpdate` alone. `priorInputs` is optional and saveQuote never
// sets it (a brand-new insert has no "prior" row) — only updateQuote
// populates it, from its own late pre-read (see `stored` below), taken
// immediately before the write rather than route.ts's much-earlier snapshot.
// identityFrozen (#839 fix-round MED): true only when updateQuote's #251
// freeze actually refused a would-be reattach on this call (see its own
// comment above `identityFrozen` in updateQuote) — absent/false otherwise,
// including on a brand-new insert (saveQuote never sets it).
export type SaveQuoteResult = { id: string; priorInputs?: Partial<QuoteInputs> | null; identityFrozen?: boolean };

export async function saveQuote(
  customer: Customer,
  inputs: QuoteInputs,
  result: QuoteResult,
  serviceType: ServiceType = DEFAULT_SERVICE_TYPE,
  // Test Quote (ledger #93): true ⇒ this row is fully-simulated test data. Set
  // once here at insert; updateQuote never touches it (is_test is immutable, so
  // the derived job/invoice can trust the quote link). The one other legitimate
  // write site is rebook.ts's buildRebookInsert, which carries src.is_test
  // through on a rebooked clone's insert (W2-002) — same immutable-at-insert
  // invariant, just a second call site.
  isTest = false,
  // Actor audit trail (#90): the operator's Supabase user id, or null when the
  // auth gate is dormant (no session). Stamped once, on create.
  createdBy: string | null = null,
  // Referral program (#41 "mention" attribution): an existing customer picked
  // as "Referred by" in the builder while creating THIS quote. Only meaningful
  // on a brand-new save (this quote's id becomes the referee_quote_id) — the
  // update path (updateQuote) never touches referrals at all.
  referredByCustomerId: string | null = null,
  // #leads "Create quote" link: the lead's known HighLevel contact id, carried
  // through so the quote is linked from birth. Set once here at insert, same
  // immutable-at-insert posture as is_test/created_by above — updateQuote
  // never takes this param, so a resave can't clobber a contact the operator
  // later picks/clears by hand (that's /api/integrations/highlevel/attach's
  // job). rebook.ts's buildRebookInsert is the other direct-insert write site
  // for this column (carries the SOURCE quote's link onto a rebooked clone).
  highlevelContactId: string | null = null,
  // NCE + YLL Neighbor tags (#198): staff-toggleable chips in the builder,
  // same insert-time posture as the params above — additive trailing params,
  // existing param order untouched. Unlike highlevelContactId/isTest these
  // ARE also settable on the update path (see updateQuote below) because
  // staff can flip either tag mid-build on a reopened quote, not just at
  // first save.
  legacyRebook = false,
  isNce = false,
): Promise<SaveQuoteResult | null> {
  // Service client first so the write bypasses RLS (enabled on quotes, #90); the
  // anon fallback keeps dev (no service key) working.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;

  // Sequential display number (ledger #83, SPEC §4.6) — allocated once, on first
  // save. Best-effort: a failed allocation (RPC/sequence missing, e.g. before the
  // 2026-06-27-quote-status migration applies) must NOT block the save — the
  // column is nullable and the truncated-UUID display (#77) still works. Omitting
  // the key entirely on failure also keeps this insert working against a DB that
  // pre-dates the migration.
  let quoteNumber: number | null = null;
  try {
    quoteNumber = await allocateNumber('quote_number_seq');
  } catch (err) {
    console.warn('saveQuote: quote_number allocation skipped:', err);
  }

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      customer_name: blankToNull(customer.name) ?? 'Anonymous',
      customer_address: blankToNull(customer.address) ?? '(no address)',
      customer_phone: blankToNull(customer.phone),
      customer_email: blankToNull(customer.email),
      service_type: serviceType,
      inputs,
      result,
      total: result.total,
      // A freshly-saved quote is a draft until staff send it (ledger #83). The
      // forward lifecycle is then re-derivable from the timestamps, but stamping
      // it here makes the explicit-status read path correct from row one.
      status: 'draft' satisfies QuoteStatus,
      is_test: isTest,
      created_by: createdBy,
      highlevel_contact_id: highlevelContactId,
      legacy_rebook: legacyRebook,
      is_nce: isNce,
      ...(quoteNumber != null ? { quote_number: quoteNumber } : {}),
    })
    .select('id')
    .single();

  if (error) {
    console.error('Supabase saveQuote error:', error);
    return null;
  }

  // Attach to the persistent customers/properties tables (Phase 5 identity).
  // Best-effort: a link failure MUST NOT fail the save — the quote row already
  // exists; we just log and continue. Skipped for test quotes (is_test=true)
  // because the customers/properties tables aren't FK-cascaded from quotes, so a
  // test quote would leak into the customer list and leave an orphan that the
  // "Delete test data" sweep can't reach.
  // Captured so the referral guard below (self-referral) can compare it
  // against referredByCustomerId — null when skipped (test quote) or the
  // attach itself failed.
  let linkedCustomerId: string | null = null;
  if (!isTest) {
    try {
      const attachResult = await attachQuoteToCustomer({
        id: data.id,
        // #213 (3-lens review fix 4, customer HIGH-leverage): this quote's
        // own highlevel_contact_id was already stamped into the insert above
        // (the row this function just created) but was never threaded into
        // the identity here, so findOrCreateCustomer's hl-agree/hl-conflict
        // rules NEVER fired on an ordinary save — even when staff picked the
        // exact right HL contact in the builder. QuoteIdentityRow already
        // has this field (the mark-sent/send re-attach routes already pass
        // it); saveQuote was simply the one caller omitting it.
        highlevel_contact_id: highlevelContactId,
        customer_name: customer.name ?? null,
        customer_email: customer.email ?? null,
        customer_phone: customer.phone ?? null,
        customer_address: customer.address ?? null,
      });
      linkedCustomerId = attachResult?.customerId ?? null;
    } catch (err) {
      console.warn('saveQuote: attachQuoteToCustomer failed (non-fatal):', err);
    }
  }

  // Referral program (#41): staff picked an existing customer as "Referred by"
  // while building this quote — create the pending 'mention' referral row now,
  // linking referrer -> this brand-new quote. Same is_test exclusion as the
  // customer/property link above (a test quote must never create a real
  // referral). Best-effort: a failure here must not fail the save.
  //
  // Self-referral guard (PR 2): if this quote's OWN customer (just resolved
  // above) is the SAME customer staff picked as "Referred by", refuse — a
  // customer can't refer themselves for a $125 credit. Skips the call
  // entirely (rather than relying solely on createPendingReferral's own
  // internal guard) so the warning is specific to this call site.
  if (!isTest && referredByCustomerId) {
    if (linkedCustomerId && linkedCustomerId === referredByCustomerId) {
      console.warn(
        `saveQuote: refusing self-referral — customer ${referredByCustomerId} cannot refer themselves (quote ${data.id})`,
      );
    } else {
      try {
        await createPendingReferral({
          source: 'mention',
          referrerCustomerId: referredByCustomerId,
          refereeQuoteId: data.id,
          ...(linkedCustomerId ? { refereeCustomerId: linkedCustomerId } : {}),
        });
      } catch (err) {
        console.warn('saveQuote: createPendingReferral failed (non-fatal):', err);
      }
    }
  }

  return { id: data.id };
}

// Re-price an existing quote IN PLACE (no new row). Used when the operator
// changes the recommended roofline in the builder breakdown (#17 Phase 1b)
// and when recalculating from the edit flow (/quote/[id], #31). Passing
// `customer` also persists edited customer fields (same sentinel defaults
// as saveQuote so the row never regresses to NULL name/address).
export async function updateQuote(
  id: string,
  inputs: QuoteInputs,
  result: QuoteResult,
  customer?: Customer,
  // Only written when provided — omitting it leaves the stored service_type
  // untouched (so a re-price that doesn't carry it can't reset the column).
  serviceType?: ServiceType,
  // Referral program (#41 adversarial-review fix): an existing customer
  // picked as "Referred by" while editing an ALREADY-SAVED quote (e.g. a
  // reopened quote that never had a referrer picked on its first save). Was
  // previously ignored entirely on the update path — see the block below.
  referredByCustomerId?: string | null,
  // NCE + YLL Neighbor tags (#198): only written when provided (undefined =
  // leave the stored value untouched), same convention as serviceType above —
  // the builder's chip strip sends the CURRENT chip state on every save, so a
  // reopened quote's tags persist through a re-price instead of resetting.
  legacyRebook?: boolean,
  isNce?: boolean,
  // #214: the builder session's LIVE HighLevel contact id, tri-state:
  //   string    — a contact is linked this session (picked, prefill-seeded,
  //               or reopen-seeded from the saved row)
  //   null      — the session EXPLICITLY has no contact (cleared, or a
  //               reopened quote that never had one)
  //   undefined — the caller doesn't know (legacy callers) → fall back to
  //               the stored highlevel_contact_id for identity purposes.
  // Identity-resolution input ONLY: updateQuote never writes the
  // highlevel_contact_id COLUMN — /api/integrations/highlevel/attach stays
  // that column's sole post-insert writer. This param exists because the
  // S34 wrap review found the most common workflow (pick a contact in the
  // builder, Calculate) resolved the customers row hl-LESS: the pick's id
  // only ever reached the attach route, never the save identity, so
  // findOrCreateCustomer's hl-agree/veto rules sat dead on every re-save
  // and a weak-field reject could fork a silent dup customers row (#214 b).
  hlContactId?: string | null,
): Promise<SaveQuoteResult | null> {
  // Service client first so the write bypasses RLS (enabled on quotes, #90).
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;

  // #GHL pipeline sync — cross-pipeline card desync guard. The stored
  // highlevel_opportunity_id records NO pipeline: every GHL move site
  // (send / decline / deposit-paid / installed) resolves the pipeline from the
  // quote's MUTABLE service_type at call time (resolvePipelineStages). If this
  // update CHANGES the service type, the linked card still lives in the OLD
  // pipeline, and every later move would push a foreign pipeline's stage id at
  // it — which GHL either rejects or lets corrupt the card. So when the type
  // actually changes, clear the opportunity link + its sent-stage sync stamp
  // in the same write; the next send/attach re-finds or re-creates the card in
  // the CORRECT pipeline. Compared on the RESOLVED type (a stored NULL reads
  // as the holiday default everywhere, so NULL→'holiday' is not a pipeline
  // change) — a same-value re-save or an update that omits serviceType never
  // clears anything. Fail-open: if the pre-read fails, keep the link (clearing
  // on a transient error would drop a valid card link).
  //
  // #214: the same pre-read now also feeds the identity-change detection
  // below, so it additionally fetches the stored identity columns + link ids
  // and runs whenever ANY identity-bearing input is present (customer /
  // hlContactId), not just serviceType. An update carrying none of the three
  // (a bare re-price) still skips it entirely — nothing it guards can change
  // on such a call.
  //
  // FIX D (#237 fix round 2, technical MED — TOCTOU): also carries `inputs`
  // now, for the SAME reason — this is a late read, taken immediately before
  // the `.update()` call a few lines down, not the much-earlier snapshot
  // /api/quote/route.ts reads at the top of its handler. The route's own
  // event-date-changed compare uses THIS read (returned below as
  // SaveQuoteResult.priorInputs) instead of its early one, closing most of a
  // race where two overlapping Calculate requests on the same quote leave
  // GHL stuck on a superseded date while the DB is correct — see that
  // route's comment for the full scenario. Relies on this block actually
  // running for that caller: /api/quote/route.ts always passes a truthy
  // `serviceType` (effectiveServiceType falls back to DEFAULT_SERVICE_TYPE,
  // never empty), so this `if` is unconditionally true for it today. A
  // future caller that omits serviceType/customer/hlContactId would get
  // priorInputs: null back, which route.ts falls back to its own early
  // snapshot for — degraded, not broken.
  type StoredIdentityRow = {
    service_type: string | null;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    customer_address: string | null;
    highlevel_contact_id: string | null;
    customer_id: string | null;
    inputs: Partial<QuoteInputs> | null;
    // #251 (Jason's ruling 2026-08-20 — identity is ATOMIC past approval):
    // read the lifecycle stamps BEFORE the write, not just off the write's
    // own response, so the freeze can gate the denormalized customer_* write
    // below instead of only the customers-table reattach further down.
    customer_approved_at: string | null;
    deposit_paid_at: string | null;
    is_test: boolean | null;
  };
  let stored: StoredIdentityRow | null = null;
  let clearGhlLink = false;
  if (serviceType || customer !== undefined || hlContactId !== undefined) {
    const { data: existing, error: readErr } = await supabase
      .from('quotes')
      .select(
        'service_type, customer_name, customer_email, customer_phone, customer_address, highlevel_contact_id, customer_id, inputs, customer_approved_at, deposit_paid_at, is_test',
      )
      .eq('id', id)
      .maybeSingle<StoredIdentityRow>();
    if (readErr) {
      console.warn('updateQuote: service_type pre-read failed (GHL link kept):', readErr.message);
    } else if (existing) {
      stored = existing;
      if (serviceType) {
        const storedType = asServiceType(existing.service_type) ?? DEFAULT_SERVICE_TYPE;
        clearGhlLink = storedType !== serviceType;
      }
    }
  }

  // #251 (Jason's ruling 2026-08-20): a quote's IDENTITY is ATOMIC once the
  // customer has approved. Before this, the freeze further down protected only
  // customer_id (billing/jobs/invoices/tenure) while these denormalized
  // customer_* columns — what every staff screen DISPLAYS and what the send
  // route emails — moved freely with whatever contact was last picked. That
  // split is precisely the shape of the 2026-08-11 incident (displayed fields
  // said one person, customer_id said another, so it was invisible on every
  // screen); this round just inverted which half lied. Freezing them together
  // means a post-approval identity is either wholly unchanged or wholly moved,
  // never half. is_test is exempt (same carve-out the reattach freeze uses).
  //
  // #839 fix-round HIGH (delta-verify on the block above — TOCTOU): an earlier
  // version of this fix gated the customer_* write on `identityLocked`, a
  // boolean computed from `stored` — the PRE-write read taken above. If a
  // customer /approve (or the deposit-paid webhook) commits in the window
  // BETWEEN that pre-read and the write below, `stored.customer_approved_at`
  // is stale-null (identityLocked=false → the write goes out) while `frozen`
  // further down — computed from the write's own fresh response — reads true
  // (→ the customer_id reattach is refused). Display fields move, customer_id
  // stays put: the exact inverted split #251 exists to prevent, reproduced by
  // the very fix meant to close it. So the customer_* write is no longer part
  // of this combined `.update()` at all — see the CAS-guarded write below,
  // which makes the freeze check and the write ONE atomic database statement
  // instead of two JS reads taken at two different times.
  const { data, error } = await supabase
    .from('quotes')
    .update({
      inputs,
      result,
      total: result.total,
      ...(serviceType ? { service_type: serviceType } : {}),
      ...(clearGhlLink ? { highlevel_opportunity_id: null, ghl_stage_synced_at: null } : {}),
      ...(legacyRebook !== undefined ? { legacy_rebook: legacyRebook } : {}),
      ...(isNce !== undefined ? { is_nce: isNce } : {}),
    })
    .eq('id', id)
    // Widened past 'id' (#198) so a tag-propagation check below can read the
    // post-update quote_sent_at/customer_id off THIS response, no 2nd round
    // trip. is_test ridden along too (review fix, admin MED, S34 #198
    // review) — updateQuote has no other way to know is_test (it's immutable
    // and never a param here), and a reopened TEST quote CAN be re-Calculated
    // through this exact path. deposit_paid_at rides along for the #214
    // booked-freeze below; customer_approved_at rides along for the #251
    // approved-freeze widening (same block, see its comment). approval_snapshot
    // rides along for row 338's wasEverApproved sticky check — see `frozen`
    // below.
    .select('id, quote_sent_at, customer_id, is_test, deposit_paid_at, customer_approved_at, approval_snapshot')
    .single<{
      id: string;
      quote_sent_at: string | null;
      customer_id: string | null;
      is_test: boolean;
      deposit_paid_at: string | null;
      customer_approved_at: string | null;
      approval_snapshot: unknown;
    }>();

  if (error) {
    console.error('Supabase updateQuote error:', error);
    return null;
  }

  // #839 fix-round HIGH: the CAS-guarded identity write. `customerWriteBlocked`
  // is set ONLY when this specific statement's `.is(...)` conditions failed to
  // match (0 rows) — i.e. the row was ALREADY approved/booked at the exact
  // moment of THIS write, per the database itself, not a separate earlier
  // read. `frozen` below (which also gates the customer_id reattach) reuses
  // this exact value whenever a customer_* write was attempted this call, so
  // the two actions can never disagree about whether the identity is frozen —
  // closing the split at its root instead of just detecting it after the fact.
  // is_test bypasses the CAS and always writes unconditionally (the #251
  // exemption — test quotes stay fully editable regardless of lifecycle
  // stamps); is_test is read off `data.is_test`, the freshest copy available
  // (the column is immutable, so pre- vs post-read can never disagree on it).
  let customerWriteBlocked = false;
  if (customer) {
    const identityPayload = {
      customer_name: blankToNull(customer.name) ?? 'Anonymous',
      customer_address: blankToNull(customer.address) ?? '(no address)',
      customer_phone: blankToNull(customer.phone),
      customer_email: blankToNull(customer.email),
    };
    if (data.is_test) {
      const { error: identErr } = await supabase
        .from('quotes')
        .update(identityPayload)
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (identErr) {
        console.warn('updateQuote: is_test identity write failed:', identErr.message);
      }
    } else {
      // Row 338 (sticky-freeze hatch): the two extra `.is()` legs read the
      // approval_snapshot json path directly in the SAME statement — no
      // second read, same "one atomic database statement" property the
      // comment above this block already established for
      // customer_approved_at/deposit_paid_at. `approval_snapshot->key IS
      // NULL` matches both "column is NULL" (never approved) and "key
      // absent" (approved but not through that path) — see wasEverApproved's
      // own comment in quoteStatus.ts for why these two keys (not a bare
      // non-null check) are the correct signal. Closes the revive→decline→
      // revive hole: a revive clears customer_approved_at, but never these
      // two keys, so a previously-approved-then-declined-then-revived quote
      // still fails this CAS.
      const { data: casRow, error: casErr } = await supabase
        .from('quotes')
        .update(identityPayload)
        .eq('id', id)
        .is('customer_approved_at', null)
        .is('deposit_paid_at', null)
        .is('approval_snapshot->approvedAt', null)
        .is('approval_snapshot->staffApproved', null)
        .select('id')
        .maybeSingle();
      if (casErr) {
        // #839 round-2 delta-verify HIGH: this branch used to leave
        // customerWriteBlocked at its `false` default, so ANY db error here
        // (a connection reset, timeout, RLS denial, constraint — not just a
        // CAS mismatch) silently produced a SPLIT: the customer_* write did
        // NOT land (this statement errored), yet `frozen` below read false
        // and let the `wouldReattach` branch repoint customer_id to the new
        // identity anyway — customer_id moves, the display columns don't.
        // Failing closed here means a transient error freezes the WHOLE
        // identity for this call (customer_id stays put too), never splits
        // it; the customer can retry. We deliberately do NOT `return null`
        // for this error — the base `.update()` (inputs/result/total) above
        // already committed, so bailing now would misreport an otherwise-
        // successful save as a failure. The `wouldReattach && frozen` branch
        // below surfaces this as `identityFrozen`, not a 500 — a transient
        // CAS error and a genuine approved/booked freeze look the same to
        // the caller, which is the safe/conservative answer either way.
        console.warn('updateQuote: #251 identity CAS write failed:', casErr.message);
        customerWriteBlocked = true;
      } else if (!casRow) {
        // 0 rows matched: approval/booking landed before (or in a race,
        // concurrently with) this statement — the write never took effect.
        customerWriteBlocked = true;
      }
    }
  }

  // #214 (a): verify-or-reattach the customers link whenever this update
  // changed the quote's IDENTITY — the S34 wrap review's worst case was this
  // exact function: ONE call can rewrite customer name/email/phone AND flip
  // a tag, then propagate that tag onto the customer row the quote resolved
  // to BEFORE the edit (quotes.customer_id is a cache of a past
  // findOrCreateCustomer decision, not a live fact). Re-running
  // attachQuoteToCustomer (idempotent; #213-gated) re-resolves the LIVE
  // identity and re-links the quote row, so the propagation below targets
  // the customer the quote identifies NOW.
  //
  // Triggers: an identity column actually changed in this write, the
  // session's hl link differs from the stored one, or the quote was never
  // linked at all (same heal chance the send route's lazy attach takes —
  // cheap here, since an identity-less quote short-circuits inside
  // findOrCreateCustomer before any query). Skipped for test quotes
  // (attachQuoteToCustomer must never run with test data) and when the
  // pre-read failed (can't compare — fall back to the cached link, the
  // pre-#214 behavior). Best-effort: never fails the save.
  // #214 review fix (admin HIGH — booked-freeze): once the deposit is PAID,
  // the customers link is FROZEN. jobs.customer_id and invoices.customer_id
  // snapshot the quote's link at booking and are never resynced (job
  // creation is idempotent-by-quote; the invoice inherits the job's copy),
  // and the GHL tenure push already fired at that id — a post-booking
  // relink (reachable via the amendReprice path, whose customer fields
  // carry no lock) would split the job/invoice across two customer
  // profiles and overstate the old one's tenure with no self-heal. This
  // restores the pre-#214 immutability-after-booking for the LINK
  // specifically; tag propagation below still runs against the (frozen)
  // cached id.
  //
  // #251 widening (real incident, 2026-08-11 — Sharon McDonough's APPROVED
  // but not-yet-booked quote #1173 got silently re-pointed at a different
  // customer via a stale HighLevel contact pick, invisible on every screen
  // because the denormalized customer_name/email/phone never moved). The
  // booked-only freeze above left every approved-but-unpaid quote exposed —
  // the exact gap this incident fell through. An approval is itself a
  // signed commitment (the approval_snapshot freezes pricing/terms the same
  // moment); the customers link deserves the same immutability from that
  // moment on, not just from booking. So the freeze now triggers on EITHER
  // customer_approved_at OR deposit_paid_at — approved behaves exactly like
  // booked already does here: the re-attach is skipped and the cached
  // customer_id is left untouched. (#839 fix-round update: this is no longer
  // fully silent — see `identityFrozen` below, set + returned on
  // SaveQuoteResult exactly when this freeze refuses a would-be reattach;
  // there is still no 409/error idiom at this layer, unlike the route-level
  // #177 deposit-percent-locked check — a blocked identity change is a
  // successful save with a flag, not a rejection.) A same-contact no-op
  // re-pick still passes through untouched regardless — identityChanged/
  // hlChanged below are false when nothing actually differs from `stored`,
  // so this widening only ever blocks a REAL change of identity, never a
  // redundant re-save.
  //
  // SIBLING (#839 fix-round HIGH): src/app/api/integrations/highlevel/
  // attach/route.ts carries the IDENTICAL freeze condition on its own
  // customers re-resolution — that route is what pickHighLevelContact calls
  // DIRECTLY on a confirmed pick (queueAttach), before any Calculate ever
  // reaches this function, so widening only HERE left the live incident's
  // actual click path unprotected for a full fix-round (the route's copy
  // stayed booked-only). Widen both together from now on.
  const effectiveHl =
    hlContactId === undefined
      ? (stored?.highlevel_contact_id ?? null)
      : (hlContactId?.trim() || null);
  let reattached: { customerId: string } | null | undefined;
  // #839 fix-round MED (staff+technical lenses, delta-verify on #251): the
  // freeze above used to be fully silent even when it actually BLOCKED a
  // would-be reattach — nothing told the caller/builder a real identity
  // change was refused, only a console.warn buried in server logs.
  // identityFrozen is set ONLY when the freeze is the reason nothing ran
  // (identityChanged/hlChanged/never-linked would have fired a reattach, and
  // the quote is approved or booked) — an unrelated field edit on an
  // approved/booked quote, or a same-id no-op re-pick, never sets it.
  // is_test / no-`stored` still short-circuit the whole block silently, same
  // as before — those are "not applicable," not "blocked." Surfaced on
  // SaveQuoteResult so /api/quote/route.ts and the builder can show a small
  // notice instead of this being log-only.
  let identityFrozen = false;
  if (!data.is_test && stored) {
    const written = customer
      ? {
          customer_name: blankToNull(customer.name) ?? 'Anonymous',
          customer_address: blankToNull(customer.address) ?? '(no address)',
          customer_phone: blankToNull(customer.phone),
          customer_email: blankToNull(customer.email),
        }
      : null;
    const identityChanged =
      written !== null &&
      (written.customer_name !== stored.customer_name ||
        written.customer_email !== stored.customer_email ||
        written.customer_phone !== stored.customer_phone ||
        written.customer_address !== stored.customer_address);
    const hlChanged =
      hlContactId !== undefined && effectiveHl !== (stored.highlevel_contact_id?.trim() || null);
    const wouldReattach = identityChanged || hlChanged || stored.customer_id == null;
    // #839 fix-round HIGH: when a customer_* write was attempted this call,
    // `frozen` reuses that write's OWN CAS result (customerWriteBlocked) —
    // the freshest possible signal, checked in the SAME database statement
    // that would otherwise have moved the display columns, so this can never
    // disagree with whether the write actually landed. When no customer_*
    // write happened (hlContactId-only edits, or no identity args at all),
    // there is nothing for it to split against, so this falls back to the
    // base update's own fresh post-write read (still newer than the earlier
    // `stored` pre-read, just not from an additional CAS round trip).
    // Row 338: OR in the sticky wasEverApproved signal on the no-customer-
    // write fallback branch too — a hlContactId-only edit (or a bare
    // never-linked reattach) must stay frozen after a revive exactly like the
    // customer_* CAS branch above now does.
    const frozen = customer
      ? customerWriteBlocked
      : !!data.deposit_paid_at || !!data.customer_approved_at || wasEverApproved(data);
    if (wouldReattach && frozen) {
      identityFrozen = true;
      console.warn(
        `updateQuote: #251 identity freeze — quote ${id} is approved/booked (or was, even after a decline/revive — row 338); refused a would-be reattach (identityChanged=${identityChanged}, hlChanged=${hlChanged}). The amend flow cannot change identity — there is no in-app remedy; a wrong link needs a manual DB fix.`,
      );
    } else if (wouldReattach) {
      try {
        reattached = await attachQuoteToCustomer(
          // Stored halves go through the sentinel translation
          // (quoteRowToIdentity); a customer object provided on THIS call
          // supplies the raw form values instead (norm() inside
          // findOrCreateCustomer trims/nulls blanks, so no sentinel ever
          // enters the identity from either side).
          {
            ...quoteRowToIdentity({
              id,
              highlevel_contact_id: effectiveHl,
              customer_name: stored.customer_name,
              customer_email: stored.customer_email,
              customer_phone: stored.customer_phone,
              customer_address: stored.customer_address,
            }),
            ...(customer
              ? {
                  customer_name: customer.name ?? null,
                  customer_email: customer.email ?? null,
                  customer_phone: customer.phone ?? null,
                  customer_address: customer.address ?? null,
                }
              : {}),
          },
        );
        // Repoint visibility (#214 review, WT-55 family): a re-resolution
        // that MOVED the quote off its previously-linked customer row is
        // loud, never silent — identity-follows-the-quote is the design
        // (#213 forks on conflicting evidence instead of guessing a merge),
        // but the move itself must be greppable so staff can reconcile the
        // rows by hand.
        if (reattached && stored.customer_id && reattached.customerId !== stored.customer_id) {
          console.warn(
            `updateQuote: #214 repoint — quote ${id} customer_id ${stored.customer_id} → ${reattached.customerId} after an identity edit. Review for a manual merge (WT-55).`,
          );
        }
      } catch (err) {
        console.warn('updateQuote: identity re-attach failed (non-fatal):', err);
        reattached = null;
      }
    }
  }

  // NCE + YLL Neighbor tag propagation (#198): mirrors the dedicated nce/
  // legacy-rebook toggle routes' "tagging an already-sent quote propagates
  // immediately" behavior — the SAME rule applies no matter which UI set the
  // tag. Only fires when this update actually SET a tag true (never on
  // false/omitted — forward-only), the quote already has both a sent stamp
  // and a linked customer, and it's NOT a test quote (defense-in-depth — a
  // real send/mark-sent can never even reach 'sent' as a test row without
  // ALSO being caught by their own is_test guard, but this keeps the
  // invariant self-contained here too). Best-effort: never fails the save.
  //
  // #214: the target id prefers the re-attach's FRESH resolution above.
  // When a re-attach was attempted and failed (returned null), propagation
  // is SKIPPED rather than falling back to the cached id — the cached row
  // is exactly the possibly-wrong target the re-attach existed to verify,
  // and a deferred propagation self-heals at the next become-sent event
  // (send/mark-sent re-fire it). When no re-attach ran (identity untouched
  // this call), the cached id is as trustworthy as it was before the call.
  const propagationCustomerId = reattached === undefined ? data.customer_id : (reattached?.customerId ?? null);
  if (!data.is_test && (legacyRebook === true || isNce === true) && data.quote_sent_at && propagationCustomerId) {
    try {
      await propagateQuoteTagsToCustomer(propagationCustomerId, { isNce, isYllNeighbor: legacyRebook });
    } catch (err) {
      console.warn('updateQuote: tag propagation failed (non-fatal):', err);
    }
  }

  // Referral program (#41 adversarial-review fix): honor "Referred by" on the
  // UPDATE path too. A separate pre-read (rather than folding into the
  // service_type read above) keeps this concern isolated from the GHL-link
  // logic — it only costs an extra round trip on the uncommon case where
  // staff pick a referrer while editing an existing quote. Idempotent via
  // createPendingReferral's own UNIQUE(referee_quote_id) backstop, so a
  // resave/re-open never duplicates the row — no local guard needed here.
  // Self-referral guard mirrors saveQuote's: refuse when this quote's OWN
  // customer is the same one just picked as "Referred by".
  if (referredByCustomerId) {
    const { data: quoteRow } = await supabase
      .from('quotes')
      .select('customer_id, is_test')
      .eq('id', id)
      .maybeSingle<{ customer_id: string | null; is_test: boolean | null }>();
    if (quoteRow && !quoteRow.is_test) {
      if (quoteRow.customer_id && quoteRow.customer_id === referredByCustomerId) {
        console.warn(
          `updateQuote: refusing self-referral — customer ${referredByCustomerId} cannot refer themselves (quote ${id})`,
        );
      } else {
        try {
          await createPendingReferral({
            source: 'mention',
            referrerCustomerId: referredByCustomerId,
            refereeQuoteId: id,
            ...(quoteRow.customer_id ? { refereeCustomerId: quoteRow.customer_id } : {}),
          });
        } catch (err) {
          console.warn('updateQuote: createPendingReferral failed (non-fatal):', err);
        }
      }
    }
  }

  // FIX D (#237 fix round 2): see StoredIdentityRow's comment above —
  // `stored` (when populated) was read immediately before the write just
  // completed, so its `inputs` is the true pre-write state for THIS call.
  // Plain `stored?.inputs` (not `?? null`) deliberately keeps `undefined`
  // (stored was never populated — this call's guard above skipped the
  // pre-read) distinct from `null` (stored WAS populated but its `inputs`
  // column itself read back empty) — both mean "nothing to report" to
  // route.ts's fallback (`saved.priorInputs ?? existing.inputs`), but only
  // the former is truly "we never looked."
  return { id: data.id, priorInputs: stored?.inputs, ...(identityFrozen ? { identityFrozen: true } : {}) };
}

// The raw row the EDIT flow needs (/quote/[id], #31): stored customer columns +
// the exact QuoteInputs/QuoteResult jsonb the builder hydrates from. Distinct
// from loadPortalQuote, which shapes the same row for the customer portal.
export type QuoteRaw = {
  id: string;
  // Referral program redemption (PR 2, ledger #41): the persisted customer
  // this quote resolved to (attachQuoteToCustomer's link) — null for a quote
  // never linked (test quote, or Supabase unconfigured). Lets /quote/[id]
  // resolve the credit-balance banner without a second client round trip.
  customer_id: string | null;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  service_type: ServiceType | null;
  inputs: Partial<QuoteInputs>;
  result: QuoteResult | null;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  // Booking + view-receipt lifecycle timestamps (#83 / #68). Included so
  // deriveStatus(row) can resolve to booked/viewed on staff-side detail views
  // without a second fetch. Additive — the edit flow ignores them.
  deposit_paid_at: string | null;
  viewed_at: string | null;
  // #175: a declined deposit/balance card charge, stamped by the Valor
  // webhook — the admin quote detail page shows a notice while the deposit
  // is still unpaid. deposit_decline_notified_at isn't rendered on the page
  // (it's only the webhook's own send-throttle claim column) but is fetched
  // here alongside its siblings for parity with the DB schema.
  deposit_declined_at: string | null;
  deposit_decline_code: string | null;
  deposit_decline_notified_at: string | null;
  // The stored order total (dollars); may differ from result.total after an
  // amendment. NULL on legacy / uncalculated rows.
  total: number | null;
  // The frozen approval snapshot jsonb (#83 Phase 4): the customer's signed
  // selection plus the post-approval `amendments[]` trail. Untyped beyond the
  // amendments array + the #155 customerSelection color fields the detail
  // view reads — old/future snapshots degrade gracefully.
  approval_snapshot: {
    amendments?: AmendmentTrailEntry[];
    // #155: the customer's approved light color/pattern (mirrors adapter.ts's
    // ApprovalSnapshotJson), read by the admin detail page to show "Chosen
    // light color" for a legacy rebook. Absent when the quote isn't approved.
    customerSelection?: {
      colorSchemeId?: string;
      customPattern?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  } | null;
  // Explicit lifecycle status + display number (ledger #83 Phase 1). NULL on
  // legacy / pre-migration rows.
  status: QuoteStatus | null;
  decline_reason: string | null;
  quote_number: number | null;
  // Test Quote (ledger #93) — so editing a test quote keeps it in TEST MODE
  // (derived from the saved row, never re-set from the URL on edit).
  is_test: boolean;
  // Legacy rebook (#155): quote migrated from last year's Jobber data — the
  // admin detail page shows a badge + (once approved) the chosen light color.
  legacy_rebook: boolean;
  // NCE tag (#198): quote-level "Mark as NCE" flag — the admin detail page +
  // the builder (toggleable there, unlike legacy_rebook's read-only display)
  // both read this.
  is_nce: boolean;
  // #172: whether a HighLevel contact is already linked — the builder needs it
  // on reopen so it stops showing "a contact is required" on a linked quote.
  highlevel_contact_id: string | null;
  // View-only portal (#176): the admin detail page shows a pill + the
  // ViewOnlyToggle off this value.
  view_only: boolean;
  // #171g: the raw payment token (captured via the redirect_url capture
  // route) and Valor's OWN Vault customer id (#161 "both vaults" decision,
  // registered by the webhook's best-effort vault hook). The admin detail
  // page uses these to surface a notice when the token is on file but Vault
  // registration never completed — see VaultRegistrationNotice.
  valor_vault_token: string | null;
  valor_vault_customer_id: string | null;
  // Row 340: the customer's live/declined-era browsing selection (ledger row
  // 239's browsing_selection column, kept in adapter.ts's BrowsingSelectionJson
  // shape) — read here so GET /api/pipeline/[quoteId] can summarize it for
  // staff (item count / packageId / saved-at) before a revive silently
  // reseeds a declined/abandoned quote's portal from it. Untyped beyond the
  // two fields that summary needs; every other consumer of getQuoteRaw
  // already ignores fields it doesn't ask for.
  browsing_selection: { packageId?: string; selectedItemIds?: unknown[] } | null;
  browsing_selection_updated_at: string | null;
};

export async function getQuoteRaw(id: string): Promise<QuoteRaw | null> {
  // Service client first: the edit page is staff-side (like the admin list).
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('quotes')
    .select(
      'id, customer_id, customer_name, customer_address, customer_phone, customer_email, service_type, inputs, result, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, total, approval_snapshot, status, decline_reason, quote_number, is_test, legacy_rebook, is_nce, highlevel_contact_id, view_only, deposit_declined_at, deposit_decline_code, deposit_decline_notified_at, valor_vault_token, valor_vault_customer_id, browsing_selection, browsing_selection_updated_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('Supabase getQuoteRaw error:', error);
    return null;
  }
  return (data as QuoteRaw | null) ?? null;
}
