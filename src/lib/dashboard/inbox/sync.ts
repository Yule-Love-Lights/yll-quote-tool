// Reconcile + escalation orchestration (service-role glue). Untested wiring over
// tested pure decisions (ghl normalize, planIngest, escalation scoring, notify) —
// runs only with the migration applied + creds set. Shared by the cron routes and
// the GHL webhook (the webhook is just a low-latency trigger for the reconcile).

import {
  addContactTags,
  isHighLevelConfigured,
  markConversationRead,
  searchConversations,
  sendEmail,
} from '@/lib/integrations/highlevel';
import {
  getAccessToken,
  getOrCreateLabel,
  getThread,
  isGmailConfigured,
  listInboxThreads,
  modifyMessage,
} from '@/lib/integrations/gmail';
import type { HandledTarget } from './store';
import { handledByTag } from './assignment';
import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { normalizeGhlConversation } from './ghl';
import { mapGmailThread, normalizeGmailThreadTouches } from './gmail';
import { isAutoCompleteTerminalQuote, normalizeQuoteTouch, quoteFollowUpDecision } from './quotetool';
import { getFollowUpDays } from './settings';
import { FOLLOWUP_REASONS } from './followups';
import {
  closeFollowUp,
  completeTerminalQuoteItems,
  ensureFollowUp,
  getSyncCursor,
  ingestTouch,
  listEscalatableItems,
  recordSuppressedFollowUp,
  recordSyncRun,
  setEscalation,
  setSyncCursor,
  sweepOrphanedFollowUps,
  sweepResolvedItemFollowUps,
} from './store';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { escalationLevel, isDueForEodDigest, newlyCrossedLevel } from './escalation';
import { etDayKey } from './normalize';
import { ESCALATION_LEVEL } from './types';
import { getSuppressedSenders } from './suppression';
import {
  type EscalationEmailItem,
  eodDigestHtml,
  eodDigestSubject,
  escalationEmailHtml,
  escalationEmailSubject,
  formatWaiting,
} from './notify';

export type ReconcileSummary = {
  ok: boolean;
  scanned: number;
  ingested: number;
  skipped: number;
  /** #252: subset of `skipped` whose IngestOutcome.skipReason was specifically
   *  'activity-noise-existing' (planIngest reason 2 — pure GHL activity noise
   *  bumping an ALREADY-EXISTING item). Keyed off skipReason, NOT off
   *  touch.isActivityNoise directly — that flag alone can't tell reason 2
   *  apart from an ordinary reason-1 cold-outbound skip (a brand-new,
   *  no-existing-item conversation whose latest event happens to be BOTH
   *  activity noise and outbound-direction is an ordinary cold-outbound skip,
   *  not #252 noise). Distinguishable from the generic `skipped` count
   *  (which also includes cold-outbound + noop-reingest) so a #252 swallow
   *  regression would be observable in prod, not lumped into a count that's
   *  expected to be nonzero for unrelated reasons every run. */
  activityNoiseSkipped: number;
  autoResolved: number;
  ambiguous: number;
  errors: number;
  error?: string;
};

/** Pull recent GHL conversations and ingest each (idempotent). Safety-net poll. */
export async function runGhlReconcile(now: Date, opts: { limit?: number } = {}): Promise<ReconcileSummary> {
  try {
    const { conversations } = await searchConversations({ limit: opts.limit ?? 50 });
    const suppressed = await getSuppressedSenders();
    let ingested = 0;
    let skipped = 0;
    let activityNoiseSkipped = 0;
    let autoResolved = 0;
    let ambiguous = 0;
    let errors = 0;
    for (const c of conversations) {
      // #252: normalizeGhlConversation always returns a touch now — pure GHL
      // activity noise (e.g. "Opportunity created") is FLAGGED
      // (isActivityNoise), never excluded here, so a conversation's first-ever
      // touch is never silently swallowed. planIngest (store.ts) is the one
      // that decides whether to skip, based on whether an item already exists,
      // and reports WHY via IngestOutcome.skipReason.
      const touch = normalizeGhlConversation(c, suppressed);
      const res = await ingestTouch(touch, now);
      if (!res.ok) {
        errors++;
        continue;
      }
      if (res.skipped) {
        skipped++;
        // Keyed off res.skipReason, NOT touch.isActivityNoise (see the field's
        // own doc above for why that flag alone would over-count).
        if (res.skipReason === 'activity-noise-existing') activityNoiseSkipped++;
        continue;
      }
      ingested++;
      if (res.autoResolved) autoResolved++;
      if (res.ambiguous) ambiguous++;
    }
    await recordSyncRun('ghl', errors > 0 ? 'error' : 'ok', errors > 0 ? `${errors} item error(s)` : undefined);
    return { ok: true, scanned: conversations.length, ingested, skipped, activityNoiseSkipped, autoResolved, ambiguous, errors };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordSyncRun('ghl', 'error', error);
    return { ok: false, scanned: 0, ingested: 0, skipped: 0, activityNoiseSkipped: 0, autoResolved: 0, ambiguous: 0, errors: 1, error };
  }
}

export type QuoteReconcileSummary = {
  ok: boolean;
  scanned: number;
  ingested: number;
  skipped: number;
  /** #317: quotetool inbox items (bare + a `:color-request` sibling, if any)
   *  auto-completed this tick because their backing quote derived into
   *  booked/declined/abandoned — see completeTerminalQuoteItems (store.ts). */
  autoCompleted: number;
  followUpsCreated: number;
  followUpsSuppressed: number;
  followUpsClosed: number;
  /** #310 fix-round: count of ensureFollowUp calls that returned 'failed' (a
   *  genuine read error, not a legitimate no-op) — see ensureFollowUp's own
   *  doc. Kept separate from `errors` (ingestTouch failures) so a degraded
   *  follow-up tick is distinguishable in the summary; `ok` and the route's
   *  HTTP status both fold it in (see runQuoteToolReconcile). */
  followUpErrors: number;
  /** row 317 fix-round FIX 3 (admin LOW, mirrors #825/#310's followUpErrors
   *  precedent above): count of completeTerminalQuoteItems calls that returned
   *  `failed: true` — a genuine Supabase read/write error inside that call
   *  (the lookup, the FIX-2 reversed-row check, or the resolve UPDATE), not a
   *  legitimate "nothing eligible this tick". Before this fix such a failure
   *  only ever hit console.warn — invisible to the summary, recordSyncRun, and
   *  the cron route's HTTP status. Folded into `degraded`/`ok` the same way
   *  followUpErrors is (see below). */
  autoCompleteErrors: number;
  errors: number;
  error?: string;
};

/**
 * Fold Quote-Tool leads into the inbox from the SAME Supabase DB (no API, no
 * trigger). A draft quote → an unresponded lead; a sent/approved quote auto-
 * resolves; a sent-but-unapproved quote spawns a quote_sent_no_reply follow-up
 * (closed on approval). Quotetool's first-seen outbound sends still mint a
 * handled inbox item, so fast-sent quotes keep their follow-up anchor without
 * surfacing as open inbox noise.
 *
 * #181: normalizeQuoteTouch returns null for an unsent YLL Neighbor
 * (legacy_rebook) draft — those are skipped before ingestTouch/follow-up, so
 * they never create an inbox item or a follow-up.
 */
export async function runQuoteToolReconcile(now: Date): Promise<QuoteReconcileSummary> {
  try {
    // Scan the newest 500 quotes by created_at. At this business's scale that
    // covers all recent + active leads; older quotes are resolved (sent/approved →
    // outbound → skipped no-ops). If the OPEN/recent set ever exceeds 500, switch
    // to scanning UNRESOLVED quotes — a created_at cursor would miss state changes
    // on older rows. `scanned` in the summary surfaces this bound (no silent cap).
    const quotes = await listQuotesForDashboard(500);
    // WT-44: read the configured follow-up cadence once per reconcile and
    // forward it below, so the "Follow-up reminder (days)" setting controls
    // when the strip nudge is due (not a hardcoded 3).
    const followUpDays = await getFollowUpDays();
    let ingested = 0;
    let skipped = 0;
    let autoCompleted = 0;
    let followUpsCreated = 0;
    let followUpsSuppressed = 0;
    let followUpsClosed = 0;
    let followUpErrors = 0;
    let autoCompleteErrors = 0;
    let errors = 0;
    for (const q of quotes) {
      // #181: suppressed unsent YLL Neighbor draft — no touch, no follow-up.
      const touch = normalizeQuoteTouch(q);
      if (!touch) {
        skipped++;
        continue;
      }
      const res = await ingestTouch(touch, now);
      if (!res.ok) {
        errors++;
        continue;
      }
      if (res.skipped) skipped++;
      else ingested++;
      // #317: the quote's own status is now terminal (booked/declined/
      // abandoned) — finish every quotetool item tied to it (bare +
      // :color-request) to 'completed', skipping needs_reply (the hard
      // constraint — see completeTerminalQuoteItems' own doc). Independent of
      // `res` above: runs even on a noop-reingest tick (#826), which is
      // exactly the "2 declined (awaiting)" self-heal case — ingestTouch has
      // nothing new to persist, but this item was never completed before.
      if (isAutoCompleteTerminalQuote(q)) {
        // row 317 fix-round FIX 3: completeTerminalQuoteItems now returns
        // { completed, failed } instead of a bare count — see its own doc and
        // QuoteReconcileSummary.autoCompleteErrors above.
        const autoCompleteResult = await completeTerminalQuoteItems(q.id, now);
        autoCompleted += autoCompleteResult.completed;
        if (autoCompleteResult.failed) autoCompleteErrors++;
      }
      const decision = quoteFollowUpDecision(q);
      if (res.itemId && decision.kind === 'create') {
        // WT-44: forward the configured cadence so the "Follow-up reminder
        // (days)" setting actually controls when this follow-up is due.
        // #252: count only an actual write. ensureFollowUp returns 'skipped'
        // when a pending row already exists OR when the anchored item is
        // already completed/dismissed (its own churn gate) — counting
        // unconditionally reported a "creation" on every tick for every
        // resolved item whose quote is still open.
        // #310 fix-round: 'failed' (a genuine read error inside ensureFollowUp)
        // is counted separately from 'skipped' so a degraded tick is visible —
        // see followUpErrors' own doc on QuoteReconcileSummary.
        const followUpResult = await ensureFollowUp({ inboxItemId: res.itemId, contactId: res.contactId, reason: decision.reason, sentAt: decision.sentAt, afterDays: followUpDays });
        if (followUpResult === 'created') followUpsCreated++;
        else if (followUpResult === 'failed') followUpErrors++;
      } else if (res.itemId && decision.kind === 'suppress' && !res.skipped) {
        // #220: internal recipients never mint a real follow-up row.
        // #230(b): gated on !res.skipped — decision.kind is recomputed from
        // `q` on EVERY tick regardless of ingest state, so without this an
        // already-suppressed quote re-ran this whole branch every 5 minutes
        // forever (res.skipped is true once ingestTouch's noopReingest kicks
        // in — status + last_message_at both steady). Fires once per genuine
        // transition (first observation, reopen, etc.), not once per tick.
        // #230(a): log every suppression (both console.warn AND a
        // dashboard_activity row, visible on /inbox/activity) so a false
        // positive is noticeable immediately, not buried in Vercel logs.
        console.warn('[inbox] quotetool follow-up suppressed for internal recipient:', {
          quoteId: q.id,
          quoteNumber: q.quote_number ?? null,
          customerEmail: q.customer_email ?? null,
          suppression: decision.suppression,
        });
        await recordSuppressedFollowUp(res.itemId, {
          quoteId: q.id,
          quoteNumber: q.quote_number ?? null,
          customerEmail: q.customer_email ?? null,
          suppression: decision.suppression,
        });
        // Close any stale pending quote_sent_no_reply row left over from before
        // the suppression rule existed, but keep this counted as one
        // suppression event instead of double-counting it as a close too.
        await closeFollowUp(res.itemId, FOLLOWUP_REASONS.quoteSentNoReply);
        followUpsSuppressed++;
      } else if (res.itemId && decision.kind === 'close') {
        if ((await closeFollowUp(res.itemId, decision.reason)) > 0) followUpsClosed++;
      }
    }
    // #183 BUG 3: the loop above only ever visits quotes still returned by
    // listQuotesForDashboard — a follow-up anchored to a DELETED quote row is
    // never reached there and would sit overdue-pending forever. One sweep per
    // reconcile closes those.
    followUpsClosed += await sweepOrphanedFollowUps(FOLLOWUP_REASONS.quoteSentNoReply);
    // #252 follow-up-autoclose backlog: a pending follow-up whose anchored item
    // was ALREADY completed/dismissed before markItemCompleted/dismissItem
    // learned to close it at the write site. Self-heals on the next reconcile —
    // no manual production data edit needed.
    followUpsClosed += await sweepResolvedItemFollowUps();
    // #310 fix-round: a follow-up read failure used to throw all the way out
    // of this function (aborting the whole tick) — now ensureFollowUp fails
    // open per-item, so `errors > 0` alone would no longer catch it. Fold
    // followUpErrors into the same 'error'/'ok' decision so a degraded tick
    // still shows up here (sync_runs / /inbox/activity). row 317 fix-round
    // FIX 3: autoCompleteErrors folded in the SAME way, same reasoning.
    const degraded = errors > 0 || followUpErrors > 0 || autoCompleteErrors > 0;
    const errorParts: string[] = [];
    if (errors > 0) errorParts.push(`${errors} item error(s)`);
    if (followUpErrors > 0) errorParts.push(`${followUpErrors} follow-up error(s)`);
    if (autoCompleteErrors > 0) errorParts.push(`${autoCompleteErrors} auto-complete error(s)`);
    await recordSyncRun('quotetool', degraded ? 'error' : 'ok', degraded ? errorParts.join(', ') : undefined);
    // `ok` drives the reconcile route's HTTP status (200 vs 500) — a
    // followUpErrors-only tick still processed every quote and both sweeps
    // (no abort), but the route should still show red so a degraded tick
    // doesn't silently read as a healthy one in Vercel's cron dashboard. The
    // pre-existing `errors` (ingestTouch failures) counter does NOT itself
    // flip `ok` here — that's an existing, separate condition unrelated to
    // this fix, out of scope for #310. row 317 fix-round FIX 3:
    // autoCompleteErrors DOES flip `ok`, same as followUpErrors — both are the
    // same "degraded, not aborted" shape (#825/#310's precedent).
    return {
      ok: followUpErrors === 0 && autoCompleteErrors === 0,
      scanned: quotes.length,
      ingested,
      skipped,
      autoCompleted,
      followUpsCreated,
      followUpsSuppressed,
      followUpsClosed,
      followUpErrors,
      autoCompleteErrors,
      errors,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordSyncRun('quotetool', 'error', error);
    return {
      ok: false,
      scanned: 0,
      ingested: 0,
      skipped: 0,
      autoCompleted: 0,
      followUpsCreated: 0,
      followUpsSuppressed: 0,
      followUpsClosed: 0,
      followUpErrors: 0,
      autoCompleteErrors: 0,
      errors: 1,
      error,
    };
  }
}

export type GmailPollSummary = {
  ok: boolean;
  scanned: number;
  ingested: number;
  skipped: number;
  autoResolved: number;
  ambiguous: number;
  errors: number;
  error?: string;
};

/**
 * Poll the Gmail inbox (sales@) and ingest each thread (as one or more touches
 * — see normalizeGmailThreadTouches, #288). For an ordinary thread, needs-reply
 * is the thread last-sender check (in normalizeGmailThread, the single-touch
 * path normalizeGmailThreadTouches falls back to): a thread whose latest
 * message is from us → outbound → the reducer skips/auto-resolves it. That also
 * neutralizes the self-ingest loop — our own escalation emails (From: sales@) read
 * as "from us". A coalesced GML lead-forward thread's split touches are the
 * exception: each is always 'inbound' regardless of the thread's last sender
 * (normalizeGmailThreadTouches's own doc explains why). Full inbox scan each
 * run (bounded); history.list incremental is a future optimization.
 */
export async function runGmailPoll(now: Date, opts: { maxResults?: number } = {}): Promise<GmailPollSummary> {
  if (!isGmailConfigured()) {
    return { ok: false, scanned: 0, ingested: 0, skipped: 0, autoResolved: 0, ambiguous: 0, errors: 0, error: 'Gmail not configured' };
  }
  const ourEmail = process.env.GMAIL_USER || 'me';
  const ourDomain = ourEmail.includes('@') ? ourEmail.split('@')[1] : null;
  const internalAddrs = [process.env.HIGHLEVEL_EMAIL_FROM]
    .map((v) => (v && v.includes('<') ? v.match(/<([^>]+)>/)?.[1] : v))
    .filter((v): v is string => !!v && v.includes('@'));
  const identity = { ourEmail, ourDomain, internalAddrs };
  try {
    const token = await getAccessToken();
    const threads = await listInboxThreads(token, { maxResults: opts.maxResults ?? 25 });
    const suppressed = await getSuppressedSenders();
    let ingested = 0;
    let skipped = 0;
    let autoResolved = 0;
    let ambiguous = 0;
    let errors = 0;
    // Bounded concurrency on the Gmail round trip (the actual bottleneck — each
    // getThread is a network call, and up to 25 of them serialized cost 5-10s+ per
    // poll). Chunk size mirrors backfillCustomersFromQuotes's CHUNK_SIZE=8. The
    // ingestTouch write stays serial below: its contact find-or-create has no
    // UNIQUE-index race-recovery (unlike customers.ts findOrCreateCustomer), so
    // running it concurrently could create duplicate dashboard_contacts rows for
    // two new threads from the same identity landing in the same chunk.
    const CHUNK_SIZE = 8;
    for (let i = 0; i < threads.length; i += CHUNK_SIZE) {
      const chunk = threads.slice(i, i + CHUNK_SIZE);
      const fetched = await Promise.all(
        chunk.map(async (ref) => {
          try {
            return { ok: true as const, raw: await getThread(token, ref.id) };
          } catch {
            return { ok: false as const };
          }
        }),
      );
      for (const f of fetched) {
        if (!f.ok) {
          errors++;
          continue;
        }
        if (!f.raw.messages || f.raw.messages.length === 0) {
          // Defensive: an empty thread would map to a no-identity, epoch-dated
          // item (noise). Gmail shouldn't return these, but skip if it does.
          skipped++;
          continue;
        }
        // #288: a coalesced GML lead-forward thread splits into MULTIPLE
        // touches (one per distinct customer) — everything else still maps to
        // exactly one, so this loop's shape (and its error isolation) applies
        // per TOUCH, not per thread. `scanned` (below, threads.length) stays
        // thread-count; ingested/skipped/etc. accumulate per touch.
        let touches: ReturnType<typeof normalizeGmailThreadTouches>;
        try {
          touches = normalizeGmailThreadTouches(mapGmailThread(f.raw, identity), suppressed);
        } catch {
          errors++;
          continue;
        }
        for (const touch of touches) {
          try {
            const res = await ingestTouch(touch, now);
            if (!res.ok) {
              errors++;
              continue;
            }
            if (res.skipped) skipped++;
            else ingested++;
            if (res.autoResolved) autoResolved++;
            if (res.ambiguous) ambiguous++;
          } catch {
            errors++;
          }
        }
      }
    }
    await recordSyncRun('gmail', errors > 0 ? 'error' : 'ok', errors > 0 ? `${errors} thread error(s)` : undefined);
    return { ok: true, scanned: threads.length, ingested, skipped, autoResolved, ambiguous, errors };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordSyncRun('gmail', 'error', error);
    return { ok: false, scanned: 0, ingested: 0, skipped: 0, autoResolved: 0, ambiguous: 0, errors: 1, error };
  }
}

function errMsg(err: unknown): string {
  // Bound it: keeps a stray verbose API body out of the stored handled_channel_sync.
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Best-effort source write-back for a Handled item — runs AFTER the local stamp,
 * so attribution never depends on it. Each channel step is caught independently;
 * the per-step outcome goes into handled_channel_sync. ⚠️ These are live GHL/Gmail
 * WRITES (mark-read / tag / label) — only the Handled route invokes this;
 * nothing runs them automatically.
 *   • GHL: mark the conversation read; tag the contact (dashboard-handled +
 *     handled-by-<operator>).
 *   • Gmail: add the YLL/Handled label + remove UNREAD.
 *
 * WT-49 fix: this used to also findOrCreateOpportunityForContact against the
 * legacy HIGHLEVEL_PIPELINE_ID/HIGHLEVEL_STAGE_QUOTE_CREATED env vars (the
 * holiday pipeline). HandledTarget carries no service_type, so a permanent/
 * event/bistro contact marked Handled got a duplicate opportunity CREATED in
 * the wrong (holiday) pipeline — invisible on the right board and able to trip
 * a holiday drip. Dropped: this was the only call site that created a NEW
 * pipeline card outside a quote's own send/attach flow (ghlPipelineMap.ts),
 * which already resolves the correct per-service-type pipeline.
 */
export async function runHandledWriteback(target: HandledTarget, operatorLabel: string): Promise<Record<string, unknown>> {
  const sync: Record<string, unknown> = {};

  if (target.source === 'ghl' && target.externalId && target.sourceMessageId) {
    try {
      await markConversationRead(target.externalId, target.sourceMessageId);
      sync.ghlMarkRead = 'ok';
    } catch (err) {
      sync.ghlMarkRead = 'failed';
      sync.ghlMarkReadError = errMsg(err);
    }
  }

  if (target.ghlContactId && isHighLevelConfigured()) {
    try {
      await addContactTags(target.ghlContactId, ['dashboard-handled', handledByTag(operatorLabel)]);
      sync.ghlTags = 'ok';
    } catch (err) {
      sync.ghlTags = 'failed';
      sync.ghlTagsError = errMsg(err);
    }
  }

  if (target.source === 'gmail' && target.externalId) {
    if (!isGmailConfigured()) {
      // #342 fix round (technical lens MED 1): a total Gmail outage (no
      // GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN) used to leave gmailLabel unset
      // entirely — not 'failed', not even 'skipped' — because the old outer
      // condition (`... && isGmailConfigured()`) skipped this whole block
      // silently. That meant listGmailWritebackFailures (store.ts), which
      // filters on gmailLabel==='failed', saw ZERO matching rows during
      // exactly the worst-case failure this row exists to catch: the banner
      // read all-clear during a total outage. Recorded as its own distinct
      // state (not folded into 'failed') so the UI can say "Gmail isn't
      // connected at all" rather than misreport it as a per-item error.
      sync.gmailLabel = 'unconfigured';
    } else {
      try {
        // #293 fix round (customer HIGH, 3rd instance of this class): message-
        // level or nothing — the old THREAD-level fallback is retired. Gmail
        // coalesces multiple different customers' Zapier lead-forwards into one
        // thread whenever they share a subject line, so a thread-wide modify
        // would silently stamp sibling customers' still-unworked forwards
        // Handled too (a staffer triaging raw Gmail — the tool's own "Reply in
        // Gmail" affordance sends them there — would see an already-handled
        // thread and skip it, reintroducing the buried-lead failure one layer
        // up). Only run the write-back when the row knows its own message id.
        // #303: an ordinary (non-lead-forward) thread now carries the
        // CUSTOMER's last inbound message id too — normalizeGmailThread
        // (gmail.ts) no longer hardcodes null for that shape, so this branch
        // fires message-level for the overwhelming majority of Gmail traffic,
        // not just the parsed-lead-forward shapes. sourceMessageId is still
        // null only when a thread has no inbound message at all (e.g. an
        // internal note-to-self) — that residual case still skips here and
        // makes zero Gmail API calls (getAccessToken/getOrCreateLabel both
        // sit inside the sourceMessageId branch below — see sync.test.ts).
        // Best-effort by design: the local handled_at stamp already landed
        // before this runs, so a failure here never blocks marking Handled.
        if (target.sourceMessageId) {
          const token = await getAccessToken();
          const labelId = await getOrCreateLabel(token, 'YLL/Handled');
          await modifyMessage(token, target.sourceMessageId, { addLabelIds: [labelId], removeLabelIds: ['UNREAD'] });
          sync.gmailLabel = 'ok';
        } else {
          sync.gmailLabel = 'skipped';
        }
      } catch (err) {
        sync.gmailLabel = 'failed';
        sync.gmailLabelError = errMsg(err);
      }
    }
  }

  return sync;
}

async function emailTeam(subject: string, html: string): Promise<boolean> {
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (!isHighLevelConfigured() || !internalContactId) return false;
  await sendEmail({ contactId: internalContactId, subject, html, emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined });
  return true;
}

// Never let a send error abort the cron or be mistaken for success. Returns
// false on an unconfigured transport OR a thrown send — the caller then leaves
// notified_levels un-advanced so the alert retries next run (never lost).
async function emailTeamSafe(subject: string, html: string): Promise<boolean> {
  try {
    return await emailTeam(subject, html);
  } catch (err) {
    console.error('[inbox/escalate] team email failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

export type EscalationSummary = {
  ok: boolean;
  amber: number;
  red: number;
  eod: number;
  eodSent: boolean;
  downtimeMin: number;
  /** True when an escalation email failed to send. notified_levels is NOT
   *  advanced for those items, so the next run retries — the alert is never lost. */
  sendFailed: boolean;
  error?: string;
};

/**
 * Score every open item, email the team (whole-team + sales@ via the internal
 * contact) for each newly-crossed amber/red level exactly once, and send one
 * end-of-day digest per ET day. Independent of anyone being logged in — this is
 * the safety net. notified_levels advances ONLY for a level whose email actually
 * sent. Includes a watchdog: if the cron had stopped, the next run flags it.
 */
export async function runEscalation(now: Date): Promise<EscalationSummary> {
  const prev = await getSyncCursor('escalate');
  const downtimeMin = prev.lastRunAt ? Math.floor((now.getTime() - new Date(prev.lastRunAt).getTime()) / 60_000) : 0;

  const res = await listEscalatableItems();
  if (!res.ok) {
    await recordSyncRun('escalate', 'error', res.error);
    return { ok: false, amber: 0, red: 0, eod: 0, eodSent: false, downtimeMin, sendFailed: false, error: res.error };
  }

  const amber: EscalationEmailItem[] = [];
  const red: EscalationEmailItem[] = [];
  const eod: EscalationEmailItem[] = [];
  type Plan = { id: string; current: number; crossed: number | null; prevNotified: number[]; prevLevel: number };
  const plans: Plan[] = [];

  for (const it of res.items) {
    if (!it.lastMessageAt) continue;
    const last = new Date(it.lastMessageAt);
    const emailItem: EscalationEmailItem = {
      name: it.contact?.displayName ?? 'Unknown contact',
      preview: it.preview,
      waiting: formatWaiting(now.getTime() - last.getTime()),
    };
    const crossed = newlyCrossedLevel(last, now, it.notifiedLevels);
    if (crossed != null) (crossed >= ESCALATION_LEVEL.RED ? red : amber).push(emailItem);
    if (isDueForEodDigest(last, now)) eod.push(emailItem);
    plans.push({ id: it.id, current: escalationLevel(last, now), crossed, prevNotified: it.notifiedLevels, prevLevel: it.escalationLevel });
  }

  // Send first; advance notified_levels only for the levels whose email went out.
  const redSent = red.length
    ? await emailTeamSafe(escalationEmailSubject({ level: ESCALATION_LEVEL.RED, count: red.length }), escalationEmailHtml({ level: ESCALATION_LEVEL.RED, items: red, baseUrl: appBaseUrl() }))
    : true;
  const amberSent = amber.length
    ? await emailTeamSafe(escalationEmailSubject({ level: ESCALATION_LEVEL.AMBER, count: amber.length }), escalationEmailHtml({ level: ESCALATION_LEVEL.AMBER, items: amber, baseUrl: appBaseUrl() }))
    : true;
  const sendFailed = (red.length > 0 && !redSent) || (amber.length > 0 && !amberSent);

  for (const p of plans) {
    let notified = p.prevNotified;
    if (p.crossed != null) {
      const sent = p.crossed >= ESCALATION_LEVEL.RED ? redSent : amberSent;
      if (sent) notified = [...p.prevNotified, p.crossed];
    }
    // Write only when the display level changed or a level was newly notified.
    if (p.current !== p.prevLevel || notified.length !== p.prevNotified.length) {
      await setEscalation(p.id, { escalationLevel: p.current, notifiedLevels: notified });
    }
  }

  // EOD digest — at most once per ET day (rolls into the next day until handled).
  const today = etDayKey(now);
  const alreadySentToday = (prev.cursor?.eodDigestDate as string | undefined) === today;
  let eodSent = false;
  if (eod.length && !alreadySentToday) {
    eodSent = await emailTeamSafe(eodDigestSubject(eod.length), eodDigestHtml(eod, appBaseUrl()));
  }

  // Watchdog: the engine just resumed after a gap — flag it so a silent outage
  // gets noticed (a safety net needs a safety net).
  if (downtimeMin > 30) {
    await emailTeamSafe(
      `⚠️ Inbox escalation engine resumed after a ${downtimeMin}m gap`,
      `<p>The escalation cron had not run for ${downtimeMin} minutes and just resumed. Check the Vercel cron schedule if this recurs.</p>`,
    );
  }

  await setSyncCursor('escalate', {
    eodDigestDate: eodSent ? today : ((prev.cursor?.eodDigestDate as string | null) ?? null),
  });
  await recordSyncRun('escalate', sendFailed ? 'error' : 'ok', sendFailed ? 'one or more escalation emails failed to send' : undefined);
  return { ok: true, amber: amber.length, red: red.length, eod: eod.length, eodSent, downtimeMin, sendFailed };
}
