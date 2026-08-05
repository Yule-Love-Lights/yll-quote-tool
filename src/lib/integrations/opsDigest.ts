// src/lib/integrations/opsDigest.ts
// Morning ops digest (Phase 1 of the 2026-07-19 text-ops plan). collectOpsDigest
// gathers the day's operational snapshot via the existing data modules;
// opsDigestMessage is the PURE formatter (telegramMessages.ts style — no IO, no
// process.env, baseUrl passed in). The cron route /api/ops/digest sends the
// result through notifyTelegram every morning.
//
// HEARTBEAT (2026-08-05): the digest ALWAYS sends now, even on an all-quiet
// morning. Before #675 a 401'd cron sent nothing — indistinguishable from
// "nothing on the board" — so the daily message is proof the cron + Telegram
// DELIVERY PATH is alive. (It does NOT prove the data is fresh: the quote/job
// reads fail soft to [] on a DB error rather than throw, so a rare read hiccup
// could render an all-zero heartbeat that looks like a genuinely quiet day.)
// Primarily an off-season prep tool: alongside installs + the quote pipeline it
// surfaces the inbox's own counts, reusing listOpenItems/listDueFollowUps so
// they match /inbox — the open-items count carries the legacy-rebook exclusion
// (like the /inbox open list); follow-ups-due mirrors the inbox follow-up strip
// as-is (which does NOT exclude rebook), so it can exceed "awaiting reply".

import { listQuotes } from '@/lib/quotes';
import { listFulfillmentCards } from '@/lib/inventory/jobs';
import { FULFILLMENT_STAGE_LABELS } from '@/lib/inventory/fulfillmentStage';
import { deriveStatus } from '@/lib/quoteStatus';
import { listOpenItems, listDueFollowUps } from '@/lib/dashboard/inbox/store';

// The digest's quote-pipeline counts must see EVERY open quote, not just the
// newest page — a high explicit scan limit (well above the foreseeable table
// size) so listQuotes()'s default 500 cap can't silently truncate a count.
const DIGEST_QUOTE_SCAN_LIMIT = 10_000;

type DigestInstall = {
  jobNumber: number | null;
  customerName: string | null;
  stageLabel: string;
  isTest: boolean;
};

export type OpsDigestData = {
  /** "Tue, Aug 5" in the shop's timezone — the heartbeat header. */
  dateLabel: string;
  installsToday: DigestInstall[];
  installsTomorrow: DigestInstall[];
  /** Real drafts to send: not test / rebook / view-only, status 'draft'. */
  quotesToSendCount: number;
  /** "YLL Neighbor" rebook drafts (#155) — counted separately so they don't
   *  bury the real pipeline; Naldo wants just the number. */
  rebookDraftCount: number;
  /** Sent/viewed, no decision yet — customer owes a reply, we owe a follow-up. */
  quotesAwaitingReplyCount: number;
  /** Customer asked for edits — WE owe a revised quote (deriveStatus 'changes_requested'). */
  changesRequestedCount: number;
  /** Approved, deposit not yet paid. */
  depositsPendingCount: number;
  /** Open inbox items needing a first response, matching /inbox (null = read
   *  failed — show the line without a fake number rather than lie). */
  inboxOpenCount: number | null;
  /** Follow-ups due today or overdue, matching the inbox follow-up strip. */
  inboxFollowUpsDueCount: number | null;
};

/** Current date (YYYY-MM-DD) in the shop's timezone — never the server's. */
function nyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/** "Tue, Aug 5" in the shop's timezone, for the digest header. */
function nyDateLabel(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date());
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export async function collectOpsDigest(): Promise<OpsDigestData> {
  const now = new Date();
  const today = nyToday();
  const tomorrow = addDays(today, 1);

  const cards = await listFulfillmentCards();
  const onDate = (ymd: string): DigestInstall[] =>
    cards
      .filter((c) => c.installDate?.slice(0, 10) === ymd)
      .map((c) => ({
        jobNumber: c.jobNumber,
        customerName: c.customerName,
        stageLabel: FULFILLMENT_STAGE_LABELS[c.stage],
        isTest: c.isTest,
      }));

  // These counts are meant to be EXHAUSTIVE — listQuotes()'s default 500-row cap
  // (ORDER BY created_at DESC) would silently drop older-but-still-open quotes
  // (e.g. the ~124 legacy rebook drafts) from the totals as the table grows, so
  // pass a high explicit scan limit. (~164 rows today; revisit as a COUNT query
  // if the table ever approaches this.)
  const allQuotes = await listQuotes(DIGEST_QUOTE_SCAN_LIMIT);
  // Test quotes are simulation data; view-only quotes (#176) are a browse-only
  // second quote — neither is real operational work. Legacy rebook drafts (#155)
  // are a deliberate separate send wave, counted on their OWN line below.
  const real = allQuotes.filter((q) => !q.is_test && !q.legacy_rebook && !q.view_only);
  // deriveStatus is the canonical lifecycle read: 'draft' = never sent and not
  // terminal; 'sent'/'viewed' = out with the customer, no decision yet;
  // 'approved' = customer said yes, deposit not yet paid.
  const quotesToSendCount = real.filter((q) => deriveStatus(q) === 'draft').length;
  const quotesAwaitingReplyCount = real.filter((q) => {
    const s = deriveStatus(q);
    return s === 'sent' || s === 'viewed';
  }).length;
  const changesRequestedCount = real.filter((q) => deriveStatus(q) === 'changes_requested').length;
  const depositsPendingCount = real.filter((q) => deriveStatus(q) === 'approved').length;
  const rebookDraftCount = allQuotes.filter(
    (q) => !q.is_test && !q.view_only && q.legacy_rebook && deriveStatus(q) === 'draft',
  ).length;

  // Inbox: reuse the /inbox surface's own reads so the counts match the page.
  // open-items (totalOpen) carries the legacy-rebook exclusion; follow-ups-due
  // mirrors the inbox follow-up strip as-is. Never let a Telegram-side summary
  // break on an inbox read hiccup — fall back to null (rendered as no number).
  const inboxOpenCount = await safeCount(async () => {
    const res = await listOpenItems();
    return res.ok ? res.totalOpen : null;
  }, 'open items');
  const inboxFollowUpsDueCount = await safeCount(async () => {
    const res = await listDueFollowUps(now);
    return res.ok ? res.items.length : null;
  }, 'due follow-ups');

  return {
    dateLabel: nyDateLabel(),
    installsToday: onDate(today),
    installsTomorrow: onDate(tomorrow),
    quotesToSendCount,
    rebookDraftCount,
    quotesAwaitingReplyCount,
    changesRequestedCount,
    depositsPendingCount,
    inboxOpenCount,
    inboxFollowUpsDueCount,
  };
}

async function safeCount(read: () => Promise<number | null>, label: string): Promise<number | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`[opsDigest] ${label} read failed:`, err);
    return null;
  }
}

/**
 * Render the digest. ALWAYS returns a message (the heartbeat) — even an
 * all-quiet morning sends, so a silent day means "broken", never "nothing
 * happening". Counts carry the pipeline; only installs (the day's actual work)
 * are listed by name.
 */
export function opsDigestMessage(data: OpsDigestData, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, ''); // strip trailing slash so `${base}/` is clean
  const lines: string[] = [`☀️ YLL morning digest — ${data.dateLabel}`, ''];

  const installLine = (i: DigestInstall) =>
    `• Job #${i.jobNumber ?? '—'} ${i.customerName ?? '(no name)'} (${i.stageLabel})${i.isTest ? ' [TEST]' : ''}`;
  // Always show both counts (heartbeat), then list names under each day present.
  lines.push(`🔧 Installs — today: ${data.installsToday.length} · tomorrow: ${data.installsTomorrow.length}`);
  if (data.installsToday.length) lines.push('Today:', ...data.installsToday.map(installLine));
  if (data.installsTomorrow.length) lines.push('Tomorrow:', ...data.installsTomorrow.map(installLine));

  lines.push(`📝 Quotes to send: ${data.quotesToSendCount}`);
  lines.push(`🏘️ Neighbor (rebook) drafts: ${data.rebookDraftCount}`);
  lines.push(`⏳ Quotes awaiting reply: ${data.quotesAwaitingReplyCount}`);
  lines.push(`✏️ Changes requested: ${data.changesRequestedCount}`);
  lines.push(`💰 Deposits pending: ${data.depositsPendingCount}`);
  lines.push(`→ ${base}/admin/quotes`);

  lines.push('');
  const inboxBits: string[] = [];
  if (data.inboxOpenCount != null) inboxBits.push(`${data.inboxOpenCount} to respond`);
  if (data.inboxFollowUpsDueCount != null) inboxBits.push(`${data.inboxFollowUpsDueCount} follow-ups due`);
  lines.push(inboxBits.length ? `📥 Inbox — ${inboxBits.join(' · ')}` : '📥 Inbox');
  lines.push(`→ ${base}/inbox`);

  lines.push('');
  lines.push(`Dashboard → ${base}/`);

  return lines.join('\n');
}
