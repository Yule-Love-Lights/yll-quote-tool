// Referral link sweep (naldo/referral-link-sweep).
//
// THE PROBLEM: the GHL merge field {{contact.referral_link}} is empty for
// almost all 2,187 contacts, because a referral code today only gets minted
// when a customer reaches a specific point in the quote flow (see
// docs/context/referral-program-zero-usage.md). The owner wants an email
// campaign to that whole list, and every eligible contact needs a link
// already stamped so the merge field just works.
//
// THE SHAPE: a scheduled sweep (POST /api/referrals/sweep, Vercel Cron),
// not a one-off script. Every run pages through GHL contacts and, for each
// one:
//   1. Skip it entirely if it is SUPPRESSED (an opportunity sitting in the
//      Neighbors pipeline's "Declined for 2026" or "Do Not Call" stage; see
//      ghlPipelineMap.ts). No code, no stamp, no tag, no Supabase row.
//   2. Skip it if it already has a referral link stamped (idempotent).
//   3. Otherwise resolve/create the Supabase customer, mint the code, stamp
//      the field, and apply exactly one tag: 'neighbor' if they have EVER
//      booked, 'has-referral-link' otherwise.
// First runs clear the backlog; every run after picks up newly-created
// contacts, because the pagination cursor only ever moves forward, wrapping
// to the start once it reaches the end (see loadCursor/saveCursor below).
//
// DELIBERATE REORDERING vs the brief's literal step order: this
// implementation checks idempotency (step 2, free, no GHL call) BEFORE
// suppression (step 1, costs a GHL call), not after. The OUTCOME is
// identical either way: an already-done contact gets no new mint/stamp/tag
// regardless of whether it's ALSO since become suppressed, because "already
// done" and "suppressed" both mean "touch nothing." Reordering only changes
// which summary bucket such a contact lands in (alreadyDone vs suppressed)
// and saves a GHL call on every contact the sweep has already finished with,
// on every future run, forever. A contact that is suppressed but NOT yet
// done still gets the suppression check (and is correctly never touched).
//
// EVER BOOKED: strongest evidence first. A Supabase quote with
// deposit_paid_at set and is_test false is checked first (cheap, one DB
// query, no GHL calls). Only when that shows nothing do we fall back to GHL:
// an opportunity sitting at a pipeline's depositPaid or installed stage, in
// ANY of the four service-type pipelines or the Neighbors pipeline
// (ghlPipelineMap.ts's allPipelineStages). If neither signal establishes a
// booking, the contact is tagged 'has-referral-link', the conservative
// default named in the brief (wrongly calling someone a customer is worse
// than the reverse).
//
// PACING: ghlFetch (highlevel.ts) has no throttling of its own. Every
// existing caller is one-at-a-time, so it has never mattered. This sweep is
// the first thing that could hammer it, so pacing lives HERE, not in
// ghlFetch (changing ghlFetch would affect every other caller). See `paced`
// below: a simple minimum-gap throttle in front of every GHL call this
// module makes.
//
// SAFETY: dryRun defaults to true. Only an explicit `dryRun: false` writes
// anything. See runReferralSweep's own doc comment.

import { getSupabaseServiceClient } from '@/lib/supabase';
import {
  isHighLevelConfigured,
  listPipelines,
  searchContactsPage,
  findAllOpportunitiesForContact,
  addContactTags,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import { parsePipelines } from '@/lib/integrations/highlevelPipelines';
import {
  NEIGHBORS_PIPELINE_ID,
  NEIGHBORS_DECLINED_STAGE_ID,
  NEIGHBORS_DO_NOT_CALL_STAGE_NAME,
  allPipelineStages,
  checkNeighborsSuppression,
} from '@/lib/integrations/ghlPipelineMap';
import { findOrCreateCustomer, getCustomerByHlContactId } from '@/lib/customers';
import { ensureReferralCode, stampReferralLinkOnContact, REFERRAL_LINK_FIELD_ENV } from '@/lib/referrals';
import type { HighLevelContact, HighLevelOpportunity } from '@/lib/integrations/types';

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Contacts scanned (not just written) per run, at most. One page (100) by
 *  default so the common case (time budget not hit) finishes a whole page:
 *  see runReferralSweep's doc comment for why a smaller number would make
 *  the SAME first slice of contacts get re-scanned every run without ever
 *  finishing it. The real per-run ceiling in practice is TIME_BUDGET_MS, not
 *  this number: see its own comment. */
export const DEFAULT_MAX_CONTACTS_PER_RUN = 100;

/** Minimum ms between GHL calls: ~5 req/s. GoHighLevel's documented limit is
 *  100 requests / 10 seconds per location (a 10 req/s sustained-equivalent
 *  burst budget) plus 200,000/day. 5 req/s is HALF that burst budget,
 *  deliberately: the limit is per LOCATION, not per caller, and this app
 *  already has other things hitting the same location concurrently, most
 *  notably /api/dashboard/ghl/reconcile, which runs every single minute.
 *  Leaving 50% headroom means the sweep can never be the reason a real
 *  customer action (a quote send, a portal read) or another cron gets
 *  rate-limited. At 2,187 contacts total and well under the 200k/day cap
 *  either way, there is no reason to run this hotter. */
export const DEFAULT_GHL_CALL_GAP_MS = 200;

/** Wall-clock budget for one run. Vercel functions have a hard execution
 *  ceiling (the route sets `maxDuration = 60`); this stops the sweep with
 *  time to spare for the final cursor save + response, rather than letting
 *  the platform kill the invocation mid-write. When a run stops early on
 *  time, its cursor still reflects real progress (see the page-completion
 *  logic below): nothing is lost, the next run picks up the same page. */
export const DEFAULT_TIME_BUDGET_MS = 50_000;

const PAGE_SIZE = 100;
const SAMPLE_SIZE = 10;

/** app_settings key holding the pagination cursor (see dashboard/inbox/settings.ts
 *  for the same key->jsonb convention this reuses; no migration needed). */
const CURSOR_SETTINGS_KEY = 'referrals.sweepCursor';

/** The exactly-one-tag choice every processed contact gets. */
export type SweepTagChoice = 'neighbor' | 'has-referral-link';
const SWEEP_TAGS: readonly SweepTagChoice[] = ['neighbor', 'has-referral-link'];

export type SweepSampleContact = {
  contactId: string;
  name: string | null;
  tag: SweepTagChoice;
};

export type ReferralSweepSummary = {
  /** false only on a fatal setup error (see `error`); nothing was scanned. */
  ok: boolean;
  dryRun: boolean;
  scanned: number;
  suppressed: number;
  alreadyDone: number;
  /** Referral codes minted or resolved AND stamped this run (live only). */
  minted: number;
  /** Contacts successfully tagged this run (live only). */
  tagged: number;
  taggedNeighbor: number;
  taggedHasReferralLink: number;
  /** Dry-run projections: what WOULD be tagged, nothing written. */
  wouldTagNeighbor: number;
  wouldTagHasReferralLink: number;
  errors: number;
  errorSamples: string[];
  /** Dry-run only: a small sample of contacts and what they'd be tagged. */
  sampleContacts: SweepSampleContact[];
  /** A 429 stopped this run early (clean stop, not a hammering retry). */
  stoppedOn429: boolean;
  /** This run reached the end of the contact list (cursor wraps to the
   *  start next run) rather than stopping on the cap/time budget. */
  reachedEndOfList: boolean;
  /** The "Do Not Call" Neighbors stage id resolved BY NAME this run (see
   *  ghlPipelineMap.ts's checkNeighborsSuppression / NEIGHBORS_DO_NOT_CALL_
   *  STAGE_NAME). Logged here, not just used internally, so a human can
   *  read it once off a run's response/logs and hardcode it in
   *  ghlPipelineMap.ts later, the same way NEIGHBORS_DECLINED_STAGE_ID
   *  already is a verified hardcoded id instead of a name lookup. Set on
   *  every run that got past the fail-loud pre-flight check (both dry-run
   *  and live); undefined only when the run aborted before resolving it
   *  (see `error`). */
  resolvedDoNotCallStageId?: string;
  /** Set only on a fatal error: config missing, or the fail-loud
   *  suppression-stage check tripped. No contact was touched. */
  error?: string;
};

export type ReferralSweepOptions = {
  /** Anything other than EXACTLY `false` stays a dry run. This is the safe
   *  default described in the brief: "impossible to trigger a live run by
   *  accident." Only a caller that means it passes `false` explicitly: see
   *  the cron route, which requires an explicit `?live=true` query param
   *  before it will do that. */
  dryRun?: boolean;
  maxContacts?: number;
  /** Overridable for tests only. Production callers should never lower this
   *  below DEFAULT_GHL_CALL_GAP_MS. */
  pacingMs?: number;
  timeBudgetMs?: number;
};

type SupabaseServiceClient = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;
type Pacer = <T>(fn: () => Promise<T>) => Promise<T>;

function freshSummary(dryRun: boolean): ReferralSweepSummary {
  return {
    ok: false,
    dryRun,
    scanned: 0,
    suppressed: 0,
    alreadyDone: 0,
    minted: 0,
    tagged: 0,
    taggedNeighbor: 0,
    taggedHasReferralLink: 0,
    wouldTagNeighbor: 0,
    wouldTagHasReferralLink: 0,
    errors: 0,
    errorSamples: [],
    sampleContacts: [],
    stoppedOn429: false,
    reachedEndOfList: false,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function is429(err: unknown): boolean {
  return err instanceof HighLevelError && err.status === 429;
}

function pushErrorSample(summary: ReferralSweepSummary, msg: string): void {
  summary.errors += 1;
  if (summary.errorSamples.length < SAMPLE_SIZE) summary.errorSamples.push(msg);
}

function contactDisplayName(contact: HighLevelContact): string | null {
  if (contact.contactName && contact.contactName.trim()) return contact.contactName;
  const parts = [contact.firstName, contact.lastName].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Idempotency check (step 2: see the module header for why this runs
 *  first). A contact counts as already-done if it carries either of our two
 *  sweep tags, OR its own referral-link custom field already has a
 *  non-empty value (e.g. stamped earlier through /api/referrals/request-link,
 *  never through this sweep, and so never tagged by it). Checking both is
 *  belt-and-suspenders: whichever one this contact object actually carries
 *  in the paged listing, catching it here means never re-minting,
 *  re-stamping, or re-tagging: "safe to run forever." */
export function alreadyProcessed(contact: HighLevelContact, referralLinkFieldId: string | undefined): boolean {
  const tags = contact.tags ?? [];
  if (SWEEP_TAGS.some((t) => tags.includes(t))) return true;
  if (referralLinkFieldId) {
    const field = (contact.customFields ?? []).find((f) => f.id === referralLinkFieldId);
    const value = field?.value;
    if (typeof value === 'string' && value.trim().length > 0) return true;
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

/** Step 1: SUPPRESSED means an opportunity sits in one of
 *  `suppressedStageIds` (NEIGHBORS_DECLINED_STAGE_ID plus this run's
 *  resolved "Do Not Call" id. See checkNeighborsSuppression in
 *  ghlPipelineMap.ts, resolved once per run in runReferralSweep below and
 *  threaded through as a parameter here rather than read off a module
 *  constant, since the "Do Not Call" half is only known after a live
 *  fetch), regardless of the opportunity's own `status` field (this app's
 *  updateOpportunityStage never sets status; see
 *  findAllOpportunitiesForContact's doc comment in highlevel.ts). Pure,
 *  given an already-fetched opportunity list, so it's cheap to unit test. */
export function isSuppressedByOpportunities(
  opportunities: HighLevelOpportunity[],
  suppressedStageIds: readonly string[],
): boolean {
  return opportunities.some((o) => !!o.pipelineStageId && suppressedStageIds.includes(o.pipelineStageId));
}

async function hasBookedQuoteInSupabase(sb: SupabaseServiceClient, customerId: string): Promise<boolean> {
  const { data, error } = await sb
    .from('quotes')
    .select('id')
    .eq('customer_id', customerId)
    .eq('is_test', false)
    .not('deposit_paid_at', 'is', null)
    .limit(1);
  if (error) {
    // Fail toward the conservative default: a Supabase read error here must
    // NOT be treated as "not booked" silently deciding the tag. It falls
    // through to the GHL check below, same as "no row found" would.
    console.error('[referralSweep] Supabase booked-quote check failed:', error);
    return false;
  }
  return !!data && data.length > 0;
}

/** GHL fallback for "ever booked": an opportunity at a depositPaid or
 *  installed stage in ANY known pipeline. `neighborsOpportunities` is
 *  passed in already-fetched (the suppression check above needs the exact
 *  same list) so this never re-fetches the Neighbors pipeline. Only the
 *  four SERVICE pipelines cost an extra call each, and only when nothing
 *  upstream (Supabase, Neighbors) already answered yes. */
async function everBookedFromGhl(
  contactId: string,
  neighborsOpportunities: HighLevelOpportunity[],
  paced: Pacer,
): Promise<boolean> {
  for (const stages of allPipelineStages()) {
    const opportunities =
      stages.pipelineId === NEIGHBORS_PIPELINE_ID
        ? neighborsOpportunities
        : await paced(() => findAllOpportunitiesForContact(contactId, stages.pipelineId));
    if (opportunities.some((o) => o.pipelineStageId === stages.depositPaid || o.pipelineStageId === stages.installed)) {
      return true;
    }
  }
  return false;
}

async function determineEverBooked(
  sb: SupabaseServiceClient,
  contactId: string,
  customerId: string | undefined,
  neighborsOpportunities: HighLevelOpportunity[],
  paced: Pacer,
): Promise<boolean> {
  if (customerId && (await hasBookedQuoteInSupabase(sb, customerId))) return true;
  return everBookedFromGhl(contactId, neighborsOpportunities, paced);
}

// ─── Cursor persistence (app_settings, same key->jsonb table + upsert
// convention as dashboard/inbox/settings.ts, no migration needed) ─────────

type SweepCursor = { searchAfter?: unknown[] };

async function loadCursor(sb: SupabaseServiceClient): Promise<SweepCursor> {
  const { data } = await sb
    .from('app_settings')
    .select('value')
    .eq('key', CURSOR_SETTINGS_KEY)
    .maybeSingle<{ value: unknown }>();
  const value = data?.value;
  if (value && typeof value === 'object' && Array.isArray((value as { searchAfter?: unknown }).searchAfter)) {
    return { searchAfter: (value as { searchAfter: unknown[] }).searchAfter };
  }
  return {};
}

async function saveCursor(sb: SupabaseServiceClient, cursor: SweepCursor): Promise<void> {
  const { error } = await sb
    .from('app_settings')
    .upsert({ key: CURSOR_SETTINGS_KEY, value: { searchAfter: cursor.searchAfter ?? null } }, { onConflict: 'key' });
  if (error) console.error('[referralSweep] failed to save pagination cursor:', error);
}

// ─── The sweep ──────────────────────────────────────────────────────────────

/**
 * Run one pass of the referral link sweep.
 *
 * SAFE BY DEFAULT: `options.dryRun` defaults to true. Only passing EXACTLY
 * `dryRun: false` writes anything: mints a code, resolves/creates a
 * Supabase customer row, stamps the GHL field, or applies a tag. A dry run
 * still makes GHL + Supabase READS (it needs them to project accurate
 * counts) but is a pure preview otherwise: no customer row, no cursor
 * advance, nothing.
 *
 * FAIL LOUD: before touching a single contact, this fetches the live GHL
 * pipeline listing and resolves both Neighbors suppression stages
 * (ghlPipelineMap.ts's checkNeighborsSuppression): NEIGHBORS_DECLINED_
 * STAGE_ID must still be a real stage id live, and a stage named
 * NEIGHBORS_DO_NOT_CALL_STAGE_NAME ("Do Not Call") must be found within the
 * Neighbors pipeline. If either check fails (a renamed/deleted hardcoded
 * id, or no live stage matches the Do Not Call name), the run refuses
 * outright and returns `{ ok: false, error: ... }` without scanning anyone.
 * A silently broken suppression check is the one failure mode this sweep
 * must never have.
 */
export async function runReferralSweep(options: ReferralSweepOptions = {}): Promise<ReferralSweepSummary> {
  const dryRun = options.dryRun !== false;
  const maxContacts = options.maxContacts ?? DEFAULT_MAX_CONTACTS_PER_RUN;
  const pacingMs = options.pacingMs ?? DEFAULT_GHL_CALL_GAP_MS;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;

  const summary = freshSummary(dryRun);

  if (!isHighLevelConfigured()) {
    summary.error = 'HighLevel not configured';
    return summary;
  }
  const sb = getSupabaseServiceClient();
  if (!sb) {
    summary.error = 'Supabase service role not configured';
    return summary;
  }

  let lastGhlCallAt = 0;
  const paced: Pacer = async (fn) => {
    const wait = lastGhlCallAt + pacingMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastGhlCallAt = Date.now();
    return fn();
  };

  // Fail-loud suppression-config check: see this function's doc comment.
  let livePipelines;
  try {
    livePipelines = parsePipelines(await paced(() => listPipelines()));
  } catch (err) {
    summary.error = `Could not fetch live pipelines to verify suppression stages: ${errMessage(err)}`;
    return summary;
  }
  const suppressionCheck = checkNeighborsSuppression(livePipelines);
  if (suppressionCheck.missingHardcodedIds.length > 0) {
    summary.error =
      `Refusing to run: suppression stage id(s) not found in the live "Yule Love Lights Neighbors" ` +
      `pipeline: ${suppressionCheck.missingHardcodedIds.join(', ')}. See ghlPipelineMap.ts ` +
      `(NEIGHBORS_DECLINED_STAGE_ID). A renamed or deleted stage must be fixed there before the ` +
      `sweep can safely run.`;
    return summary;
  }
  if (!suppressionCheck.doNotCallStageId) {
    const found =
      suppressionCheck.liveNeighborsStageNames.length > 0
        ? suppressionCheck.liveNeighborsStageNames.map((n) => `"${n}"`).join(', ')
        : '(the "Yule Love Lights Neighbors" pipeline itself was not found live)';
    summary.error =
      `Refusing to run: no stage named "${NEIGHBORS_DO_NOT_CALL_STAGE_NAME}" (case/whitespace-insensitive) ` +
      `found in the live "Yule Love Lights Neighbors" pipeline. Live stages found: ${found}. See ` +
      `ghlPipelineMap.ts (NEIGHBORS_DO_NOT_CALL_STAGE_NAME). A renamed, deleted, or not-yet-created ` +
      `stage must be fixed before the sweep can safely run.`;
    return summary;
  }
  // Logged in the summary (not just used internally) so a human can read the
  // resolved id once and hardcode it in ghlPipelineMap.ts later. See
  // ReferralSweepSummary.resolvedDoNotCallStageId's own comment for why.
  summary.resolvedDoNotCallStageId = suppressionCheck.doNotCallStageId;
  const suppressedStageIds: readonly string[] = [NEIGHBORS_DECLINED_STAGE_ID, suppressionCheck.doNotCallStageId];

  // Self-review catch: without this check, a missing field id doesn't fail
  // loud. stampReferralLinkOnContact fails OPEN (its own documented
  // contract) and returns false for every single contact, one at a time,
  // burning the whole errorSamples budget on the same root cause instead of
  // surfacing it once, clearly. Checked in BOTH modes (not just live) so a
  // dry-run preview catches the misconfiguration before anyone tries to go
  // live. That is the entire point of previewing first.
  const referralLinkFieldId = process.env[REFERRAL_LINK_FIELD_ENV] || undefined;
  if (!referralLinkFieldId) {
    summary.error = `${REFERRAL_LINK_FIELD_ENV} is not set. Refusing to run (every stamp would silently fail one contact at a time instead).`;
    return summary;
  }

  const cursor = await loadCursor(sb);
  let searchAfter = cursor.searchAfter;
  const deadline = Date.now() + timeBudgetMs;

  runLoop: while (summary.scanned < maxContacts && Date.now() < deadline) {
    const pageStartSearchAfter = searchAfter;
    let page;
    try {
      page = await paced(() => searchContactsPage({ pageLimit: PAGE_SIZE, searchAfter }));
    } catch (err) {
      if (is429(err)) {
        summary.stoppedOn429 = true;
        break;
      }
      summary.error = `Contact listing failed: ${errMessage(err)}`;
      break;
    }

    if (page.contacts.length === 0) {
      summary.reachedEndOfList = true;
      searchAfter = undefined; // wrap around to the start next run
      break;
    }

    let completedWholePage = true;
    for (const contact of page.contacts) {
      if (summary.scanned >= maxContacts || Date.now() >= deadline) {
        completedWholePage = false;
        break;
      }
      summary.scanned += 1;

      try {
        if (alreadyProcessed(contact, referralLinkFieldId)) {
          summary.alreadyDone += 1;
          continue;
        }

        const neighborsOpportunities = await paced(() =>
          findAllOpportunitiesForContact(contact.id, NEIGHBORS_PIPELINE_ID),
        );
        if (isSuppressedByOpportunities(neighborsOpportunities, suppressedStageIds)) {
          summary.suppressed += 1;
          continue;
        }

        if (dryRun) {
          // Read-only projection: an EXISTING customer only. Creating one
          // here would be a write, so this never does. No resolved customer
          // just means the Supabase leg of determineEverBooked is skipped,
          // same as a live run would for a brand-new customer before it's
          // created.
          const existingCustomer = await getCustomerByHlContactId(contact.id);
          const everBooked = await determineEverBooked(
            sb,
            contact.id,
            existingCustomer?.id,
            neighborsOpportunities,
            paced,
          );
          const tag: SweepTagChoice = everBooked ? 'neighbor' : 'has-referral-link';
          if (tag === 'neighbor') summary.wouldTagNeighbor += 1;
          else summary.wouldTagHasReferralLink += 1;
          if (summary.sampleContacts.length < SAMPLE_SIZE) {
            summary.sampleContacts.push({ contactId: contact.id, name: contactDisplayName(contact), tag });
          }
          continue;
        }

        // LIVE: resolve/create the customer, mint, stamp, tag.
        const customer = await findOrCreateCustomer(
          {
            hl_contact_id: contact.id,
            email: contact.email ?? null,
            phone: contact.phone ?? null,
            name: contactDisplayName(contact),
          },
          // Anonymous/bulk caller, same posture as POST /api/referrals/request-link:
          // never let a backfill sweep overwrite a more-recently-corrected
          // stored record.
          { skipIdentityRefresh: true },
        );
        if (!customer) {
          pushErrorSample(summary, `${contact.id}: could not resolve/create a Supabase customer`);
          continue;
        }

        const everBooked = await determineEverBooked(sb, contact.id, customer.id, neighborsOpportunities, paced);

        const code = await ensureReferralCode(customer.id);
        if (!code) {
          pushErrorSample(summary, `${contact.id}: ensureReferralCode returned null`);
          continue;
        }

        const stamped = await paced(() => stampReferralLinkOnContact(contact.id, code));
        if (!stamped) {
          pushErrorSample(summary, `${contact.id}: referral-link field stamp failed`);
          continue;
        }
        summary.minted += 1;

        const tag: SweepTagChoice = everBooked ? 'neighbor' : 'has-referral-link';
        await paced(() => addContactTags(contact.id, [tag]));
        summary.tagged += 1;
        if (tag === 'neighbor') summary.taggedNeighbor += 1;
        else summary.taggedHasReferralLink += 1;
      } catch (err) {
        if (is429(err)) {
          summary.stoppedOn429 = true;
          completedWholePage = false;
          break;
        }
        pushErrorSample(summary, `${contact.id}: ${errMessage(err)}`);
      }
    }

    if (summary.stoppedOn429) break runLoop;

    if (completedWholePage) {
      searchAfter = page.nextSearchAfter;
      if (page.nextSearchAfter === undefined) {
        summary.reachedEndOfList = true;
        break;
      }
    } else {
      // Stopped mid-page (cap or time budget): resume this SAME page next
      // run rather than a per-contact cursor. Already-done contacts in the
      // re-scanned prefix skip for free (no GHL call); a suppressed one
      // re-costs one GHL call, bounded and self-correcting once the page
      // finally completes.
      searchAfter = pageStartSearchAfter;
      break;
    }
  }

  if (!dryRun) await saveCursor(sb, { searchAfter });
  // Self-review catch: a MID-run contact-listing failure (not the upfront
  // fail-loud checks above, which all `return` before this line) sets
  // summary.error but must NOT then be reported as ok: that would surface
  // as a contradictory "ok: true" summary carrying an error string. Progress
  // made before the failure is still saved via the cursor above; ok:false
  // here only means "this run hit a problem," not "nothing happened."
  summary.ok = !summary.error;
  return summary;
}
