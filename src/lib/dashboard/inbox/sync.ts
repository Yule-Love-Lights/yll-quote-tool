// Reconcile + escalation orchestration (service-role glue). Untested wiring over
// tested pure decisions (ghl normalize, planIngest, escalation scoring, notify) —
// runs only with the migration applied + creds set. Shared by the cron routes and
// the GHL webhook (the webhook is just a low-latency trigger for the reconcile).

import { isHighLevelConfigured, searchConversations, sendEmail } from '@/lib/integrations/highlevel';
import { normalizeGhlConversation } from './ghl';
import {
  getSyncCursor,
  ingestTouch,
  listEscalatableItems,
  recordSyncRun,
  setEscalation,
  setSyncCursor,
} from './store';
import { isDueForEodDigest, newlyCrossedLevel } from './escalation';
import { etDayKey } from './normalize';
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

async function emailTeam(subject: string, html: string): Promise<boolean> {
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (!isHighLevelConfigured() || !internalContactId) return false;
  await sendEmail({ contactId: internalContactId, subject, html, emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined });
  return true;
}

export type EscalationSummary = {
  ok: boolean;
  amber: number;
  red: number;
  eod: number;
  eodSent: boolean;
  downtimeMin: number;
  error?: string;
};

/**
 * Score every open item, email the team (whole-team + sales@ via the internal
 * contact) for each newly-crossed amber/red level exactly once, and send one
 * end-of-day digest per ET day. Independent of anyone being logged in — this is
 * the safety net. Includes a watchdog: if the cron had stopped, the next run
 * flags the downtime.
 */
export async function runEscalation(now: Date): Promise<EscalationSummary> {
  const prev = await getSyncCursor('escalate');
  const downtimeMin = prev.lastRunAt ? Math.floor((now.getTime() - new Date(prev.lastRunAt).getTime()) / 60_000) : 0;

  const res = await listEscalatableItems();
  if (!res.ok) {
    await recordSyncRun('escalate', 'error', res.error);
    return { ok: false, amber: 0, red: 0, eod: 0, eodSent: false, downtimeMin, error: res.error };
  }

  const amber: EscalationEmailItem[] = [];
  const red: EscalationEmailItem[] = [];
  const eod: EscalationEmailItem[] = [];
  const updates: Array<{ id: string; level: number; notifiedLevels: number[] }> = [];

  for (const it of res.items) {
    if (!it.lastMessageAt) continue;
    const last = new Date(it.lastMessageAt);
    const emailItem: EscalationEmailItem = {
      name: it.contact?.displayName ?? 'Unknown contact',
      preview: it.preview,
      waiting: formatWaiting(now.getTime() - last.getTime()),
    };
    const crossed = newlyCrossedLevel(last, now, it.notifiedLevels);
    if (crossed != null) {
      (crossed >= 2 ? red : amber).push(emailItem);
      updates.push({ id: it.id, level: crossed, notifiedLevels: [...it.notifiedLevels, crossed] });
    }
    if (isDueForEodDigest(last, now)) eod.push(emailItem);
  }

  if (red.length) await emailTeam(escalationEmailSubject({ level: 2, count: red.length }), escalationEmailHtml({ level: 2, items: red }));
  if (amber.length) await emailTeam(escalationEmailSubject({ level: 1, count: amber.length }), escalationEmailHtml({ level: 1, items: amber }));

  // Record notified levels only after attempting the email (so a send failure
  // re-attempts next run rather than silently marking it notified).
  for (const u of updates) await setEscalation(u.id, { escalationLevel: u.level, notifiedLevels: u.notifiedLevels });

  // EOD digest — at most once per ET day (rolls into the next day until handled).
  const today = etDayKey(now);
  const alreadySentToday = (prev.cursor?.eodDigestDate as string | undefined) === today;
  let eodSent = false;
  if (eod.length && !alreadySentToday) {
    eodSent = await emailTeam(eodDigestSubject(eod.length), eodDigestHtml(eod));
  }

  // Watchdog: the engine just resumed after a gap — flag it so a silent outage
  // gets noticed (a safety net needs a safety net).
  if (downtimeMin > 30) {
    await emailTeam(
      `⚠️ Inbox escalation engine resumed after a ${downtimeMin}m gap`,
      `<p>The escalation cron had not run for ${downtimeMin} minutes and just resumed. Check the Vercel cron schedule if this recurs.</p>`,
    );
  }

  await setSyncCursor('escalate', {
    eodDigestDate: eodSent ? today : ((prev.cursor?.eodDigestDate as string | null) ?? null),
  });
  await recordSyncRun('escalate', 'ok');
  return { ok: true, amber: amber.length, red: red.length, eod: eod.length, eodSent, downtimeMin };
}
