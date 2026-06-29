// Reconcile + escalation orchestration (service-role glue). Untested wiring over
// tested pure decisions (ghl normalize, planIngest, escalation scoring, notify) —
// runs only with the migration applied + creds set. Shared by the cron routes and
// the GHL webhook (the webhook is just a low-latency trigger for the reconcile).

import { isHighLevelConfigured, searchConversations, sendEmail } from '@/lib/integrations/highlevel';
import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { normalizeGhlConversation } from './ghl';
import { normalizeQuoteTouch, quoteFollowUpDecision } from './quotetool';
import {
  closeFollowUp,
  ensureFollowUp,
  getSyncCursor,
  ingestTouch,
  listEscalatableItems,
  recordSyncRun,
  setEscalation,
  setSyncCursor,
} from './store';
import { escalationLevel, isDueForEodDigest, newlyCrossedLevel } from './escalation';
import { etDayKey } from './normalize';
import { ESCALATION_LEVEL } from './types';
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
  autoResolved: number;
  ambiguous: number;
  errors: number;
  error?: string;
};

/** Pull recent GHL conversations and ingest each (idempotent). Safety-net poll. */
export async function runGhlReconcile(now: Date, opts: { limit?: number } = {}): Promise<ReconcileSummary> {
  try {
    const { conversations } = await searchConversations({ limit: opts.limit ?? 50 });
    let ingested = 0;
    let skipped = 0;
    let autoResolved = 0;
    let ambiguous = 0;
    let errors = 0;
    for (const c of conversations) {
      const res = await ingestTouch(normalizeGhlConversation(c), now);
      if (!res.ok) {
        errors++;
        continue;
      }
      if (res.skipped) {
        skipped++;
        continue;
      }
      ingested++;
      if (res.autoResolved) autoResolved++;
      if (res.ambiguous) ambiguous++;
    }
    await recordSyncRun('ghl', errors > 0 ? 'error' : 'ok', errors > 0 ? `${errors} item error(s)` : undefined);
    return { ok: true, scanned: conversations.length, ingested, skipped, autoResolved, ambiguous, errors };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordSyncRun('ghl', 'error', error);
    return { ok: false, scanned: 0, ingested: 0, skipped: 0, autoResolved: 0, ambiguous: 0, errors: 1, error };
  }
}

export type QuoteReconcileSummary = {
  ok: boolean;
  scanned: number;
  ingested: number;
  skipped: number;
  followUpsCreated: number;
  followUpsClosed: number;
  errors: number;
  error?: string;
};

/**
 * Fold Quote-Tool leads into the inbox from the SAME Supabase DB (no API, no
 * trigger). A draft quote → an unresponded lead; a sent/approved quote auto-
 * resolves; a sent-but-unapproved quote spawns a quote_sent_no_reply follow-up
 * (closed on approval). Follow-ups anchor on the inbox item, so a quote sent
 * without ever being seen as a draft (rare) gets no inbox follow-up — the home
 * worklist's sent-no-reply remains the backstop for that edge.
 */
export async function runQuoteToolReconcile(now: Date): Promise<QuoteReconcileSummary> {
  try {
    const quotes = await listQuotesForDashboard(500);
    let ingested = 0;
    let skipped = 0;
    let followUpsCreated = 0;
    let followUpsClosed = 0;
    let errors = 0;
    for (const q of quotes) {
      const res = await ingestTouch(normalizeQuoteTouch(q), now);
      if (!res.ok) {
        errors++;
        continue;
      }
      if (res.skipped) skipped++;
      else ingested++;
      const decision = quoteFollowUpDecision(q);
      if (res.itemId && decision.kind === 'create') {
        await ensureFollowUp({ inboxItemId: res.itemId, contactId: res.contactId, reason: decision.reason, sentAt: decision.sentAt });
        followUpsCreated++;
      } else if (res.itemId && decision.kind === 'close') {
        await closeFollowUp(res.itemId, decision.reason);
        followUpsClosed++;
      }
    }
    await recordSyncRun('quotetool', errors > 0 ? 'error' : 'ok', errors > 0 ? `${errors} item error(s)` : undefined);
    return { ok: true, scanned: quotes.length, ingested, skipped, followUpsCreated, followUpsClosed, errors };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordSyncRun('quotetool', 'error', error);
    return { ok: false, scanned: 0, ingested: 0, skipped: 0, followUpsCreated: 0, followUpsClosed: 0, errors: 1, error };
  }
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
    console.error('[inbox/escalate] team email failed:', err);
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
    ? await emailTeamSafe(escalationEmailSubject({ level: ESCALATION_LEVEL.RED, count: red.length }), escalationEmailHtml({ level: ESCALATION_LEVEL.RED, items: red }))
    : true;
  const amberSent = amber.length
    ? await emailTeamSafe(escalationEmailSubject({ level: ESCALATION_LEVEL.AMBER, count: amber.length }), escalationEmailHtml({ level: ESCALATION_LEVEL.AMBER, items: amber }))
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
    eodSent = await emailTeamSafe(eodDigestSubject(eod.length), eodDigestHtml(eod));
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
