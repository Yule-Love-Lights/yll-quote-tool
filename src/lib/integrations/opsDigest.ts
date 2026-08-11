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

// #229: named detail beneath the counts, so the digest answers "who" not just
// "how many" — the 2026-08-06 miss (3 promised quotes silently dropped inside
// a "4 awaiting reply" count) is exactly what this surfaces. Every named list
// is capped (Telegram has a length limit) with an explicit overflow marker —
// never a silent truncation.
const NAMED_LIST_CAP = 5;

// #229 review HIGH2: contactPhone/contactEmail are fallback identifiers — a
// contact with no display_name (the exact Aug-6 dropped-lead shape) still
// renders as something actionable instead of an unusable "(no name)".
type NamedFollowUp = { contactName: string | null; contactPhone: string | null; contactEmail: string | null; daysOverdue: number };
type NamedAwaitingReply = { customerName: string | null; quoteNumber: number | null; daysSinceSent: number };
type NamedDeposit = { customerName: string | null; quoteNumber: number | null; total: number | null };

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
  /** #229: of the above, how many are strictly PAST due (not just due today) —
   *  null on the same read failure as inboxFollowUpsDueCount (same fetch). */
  followUpsOverdueCount: number | null;
  /** #229: named, capped to NAMED_LIST_CAP, sorted most-overdue first. */
  overdueFollowUps: NamedFollowUp[];
  /** #229: named quotes awaiting reply, capped, sorted longest-waiting first.
   *  Derives from the same `real` quote read as quotesAwaitingReplyCount, so
   *  it degrades with that count (no separate read to fail). */
  quotesAwaitingReplyNamed: NamedAwaitingReply[];
  /** #229: named deposits pending, capped, sorted highest total first. Same
   *  degrade-with-the-count relationship as above. */
  depositsPendingNamed: NamedDeposit[];
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

  // #229: named detail for the two "who has to be chased" buckets. Derived
  // from the SAME `real` array as the counts above, so a listQuotes read
  // failure degrades both the count and the named list together (listQuotes
  // itself fails soft to [] — no separate try/catch needed here).
  const daysSince = (iso: string | null): number =>
    Math.max(0, Math.floor((now.getTime() - new Date(iso ?? now).getTime()) / 86_400_000));
  // #229 review MEDIUM4: oldest-first + a hard cap systematically hides the
  // MOST-recently-sent quote behind "+N more" — the exact shape of the Aug-6
  // miss (a customer texted a promise 12h earlier). Fix: anything sent in the
  // last 24h ALWAYS sorts ahead of the cap, so it can only be pushed out by
  // more than NAMED_LIST_CAP other same-day sends (a rare, accepted edge —
  // the alternative of never capping same-day sends would blow the Telegram
  // length limit on a genuinely busy morning).
  const quotesAwaitingReplyNamed = real
    .filter((q) => {
      const s = deriveStatus(q);
      return s === 'sent' || s === 'viewed';
    })
    .map((q) => {
      const sentIso = q.quote_sent_at ?? q.viewed_at ?? q.created_at;
      // sentAtMs is a SORT KEY ONLY and is stripped before this leaves the
      // function. daysSinceSent is whole days, so every same-day send ties at
      // 0 — sorting on it alone cannot tell a 1-hour-old promise from a
      // 23-hour-old one, and the cap would then keep whichever order the DB
      // happened to return. The raw timestamp is the only thing with enough
      // resolution to order the group this rule exists to protect.
      const parsed = sentIso ? Date.parse(sentIso) : NaN;
      return {
        customerName: q.customer_name,
        quoteNumber: q.quote_number,
        daysSinceSent: daysSince(sentIso),
        sentAtMs: Number.isFinite(parsed) ? parsed : 0,
      };
    })
    .sort((a, b) => {
      const aRecent = a.daysSinceSent < 1;
      const bRecent = b.daysSinceSent < 1;
      if (aRecent !== bRecent) return aRecent ? -1 : 1; // <24h always sorts first
      // #229 delta-verify: the two groups tie-break in OPPOSITE directions, on
      // purpose. Within the <24h group, NEWEST first — with more than
      // NAMED_LIST_CAP same-day sends, an oldest-first tie-break would push the
      // freshest promises into "+N more", which is exactly the miss this
      // recency rule exists to prevent (a customer texted a promise hours ago
      // is the most salvageable). Within the older group, OLDEST first, because
      // there the longest-ignored quote is the most urgent.
      return aRecent ? b.sentAtMs - a.sentAtMs : a.sentAtMs - b.sentAtMs;
    })
    .slice(0, NAMED_LIST_CAP)
    .map(({ sentAtMs: _sentAtMs, ...row }) => row);
  const depositsPendingNamed = real
    .filter((q) => deriveStatus(q) === 'approved')
    .map((q) => ({ customerName: q.customer_name, quoteNumber: q.quote_number, total: q.total }))
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
    .slice(0, NAMED_LIST_CAP);

  // Inbox: reuse the /inbox surface's own reads so the counts match the page.
  // open-items (totalOpen) carries the legacy-rebook exclusion; follow-ups-due
  // mirrors the inbox follow-up strip as-is. Never let a Telegram-side summary
  // break on an inbox read hiccup — fall back to null (rendered as no number).
  const inboxOpenCount = await safeCount(async () => {
    const res = await listOpenItems();
    return res.ok ? res.totalOpen : null;
  }, 'open items');

  // #229: one read feeds three derived values (the due count, the overdue
  // subset count, and the named overdue list) — read once, degrade all three
  // together on failure rather than issuing (and possibly failing) 3 reads.
  let inboxFollowUpsDueCount: number | null = null;
  let followUpsOverdueCount: number | null = null;
  let overdueFollowUps: NamedFollowUp[] = [];
  try {
    const res = await listDueFollowUps(now);
    if (res.ok) {
      // inboxFollowUpsDueCount intentionally stays UNFILTERED — it mirrors the
      // /inbox strip's own count (documented above), which does not exclude
      // rebook. #229 review HIGH1: the NAMED list is a different promise ("never
      // surface a rebook customer by name") — filter isLegacyRebook out here,
      // downstream of the shared read, so the strip's own behavior is untouched.
      inboxFollowUpsDueCount = res.items.length;
      // "Overdue" = strictly past due, not merely due today — daysOverdue >= 1.
      const overdue = res.items
        .filter((it) => !it.isLegacyRebook)
        .map((it) => ({
          contactName: it.contactName,
          contactPhone: it.contactPhone,
          contactEmail: it.contactEmail,
          daysOverdue: Math.floor((now.getTime() - new Date(it.dueAt).getTime()) / 86_400_000),
        }))
        .filter((it) => it.daysOverdue >= 1)
        .sort((a, b) => b.daysOverdue - a.daysOverdue);
      followUpsOverdueCount = overdue.length;
      overdueFollowUps = overdue.slice(0, NAMED_LIST_CAP);
    }
  } catch (err) {
    console.error('[opsDigest] due follow-ups read failed:', err);
  }

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
    followUpsOverdueCount,
    overdueFollowUps,
    quotesAwaitingReplyNamed,
    depositsPendingNamed,
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

/** Dollar formatting for `quotes.total` (stored as a dollar amount, matching
 *  the rest of the dashboard — see KpiStrip.tsx). #229 review MEDIUM3: a null
 *  total must NOT render as "$0" — that reads as "nothing owed" to someone
 *  skimming at 7:30am, when it actually means "we don't know". Callers must
 *  check for null themselves; this only formats a REAL number. */
function formatDollars(total: number): string {
  return total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/** #229 review HIGH2: name, else phone, else email, else give up — a contact
 *  with no display_name (the real Aug-6 dropped-lead shape) still renders as
 *  something actionable instead of an unusable "(no name)". */
function followUpDisplayName(f: NamedFollowUp): string {
  return f.contactName ?? f.contactPhone ?? f.contactEmail ?? '(no name)';
}

/**
 * #229: push a capped, named list with an explicit "+N more" overflow marker
 * — NEVER a silent truncation (Telegram has a length limit; a cap that
 * doesn't say so reads as "that's everything" when it isn't). `totalCount` is
 * the real population size; `shown` is already capped to NAMED_LIST_CAP by
 * the caller (collectOpsDigest).
 */
function pushNamedList<T>(lines: string[], shown: T[], totalCount: number, render: (item: T) => string): void {
  if (!shown.length) return;
  for (const item of shown) lines.push(render(item));
  const remaining = totalCount - shown.length;
  if (remaining > 0) lines.push(`+${remaining} more`);
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
  // #229 review (lower priority): installs are otherwise UNBOUNDED — every
  // fulfillment card for the date, no cap — the main thing pushing the
  // message toward Telegram's length limit in peak season. Cap the same way
  // as the named lists below; the header counts above stay the REAL totals.
  lines.push(`🔧 Installs — today: ${data.installsToday.length} · tomorrow: ${data.installsTomorrow.length}`);
  if (data.installsToday.length) {
    lines.push('Today:');
    pushNamedList(lines, data.installsToday.slice(0, NAMED_LIST_CAP), data.installsToday.length, installLine);
  }
  if (data.installsTomorrow.length) {
    lines.push('Tomorrow:');
    pushNamedList(lines, data.installsTomorrow.slice(0, NAMED_LIST_CAP), data.installsTomorrow.length, installLine);
  }

  lines.push(`📝 Quotes to send: ${data.quotesToSendCount}`);
  lines.push(`🏘️ Neighbor (rebook) drafts: ${data.rebookDraftCount}`);
  lines.push(`⏳ Quotes awaiting reply: ${data.quotesAwaitingReplyCount}`);
  pushNamedList(
    lines,
    data.quotesAwaitingReplyNamed,
    data.quotesAwaitingReplyCount,
    (r) => `• ${r.customerName ?? '(no name)'} — ${r.daysSinceSent}d`,
  );
  lines.push(`✏️ Changes requested: ${data.changesRequestedCount}`);
  lines.push(`💰 Deposits pending: ${data.depositsPendingCount}`);
  pushNamedList(
    lines,
    data.depositsPendingNamed,
    data.depositsPendingCount,
    // #229 review MEDIUM3: null total → "amount unknown", never "$0".
    (r) => `• ${r.customerName ?? '(no name)'} — ${r.total == null ? 'amount unknown' : formatDollars(r.total)}`,
  );
  lines.push(`→ ${base}/admin/quotes`);

  lines.push('');
  const inboxBits: string[] = [];
  if (data.inboxOpenCount != null) inboxBits.push(`${data.inboxOpenCount} to respond`);
  if (data.inboxFollowUpsDueCount != null) inboxBits.push(`${data.inboxFollowUpsDueCount} follow-ups due`);
  lines.push(inboxBits.length ? `📥 Inbox — ${inboxBits.join(' · ')}` : '📥 Inbox');
  if (data.followUpsOverdueCount != null && data.followUpsOverdueCount > 0) {
    lines.push(`Overdue follow-ups:`);
    pushNamedList(
      lines,
      data.overdueFollowUps,
      data.followUpsOverdueCount,
      (r) => `• ${followUpDisplayName(r)} — ${r.daysOverdue}d overdue`,
    );
  }
  lines.push(`→ ${base}/inbox`);

  lines.push('');
  lines.push(`Dashboard → ${base}/`);

  return lines.join('\n');
}
