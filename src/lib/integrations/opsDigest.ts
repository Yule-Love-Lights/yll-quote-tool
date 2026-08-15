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
//
// #265: reads totalLeads, NOT totalOpen — totalOpen counts every open item
// (leads AND lead_kind='automated' system noise like a no-show notice);
// totalLeads excludes the noise. This MATCHES what the /inbox page's own
// "Open leads" tile (buildInboxSummary) and the dashboard nav badge show only
// while the true lead population fits inside the page cap (items.length <=
// listOpenItems' `limit`, 100 today) — totalLeads is derived from the wider
// fetch WINDOW (up to 300 rows), not the page, so once automated-row volume
// (or lead volume) pushes real leads beyond the page, totalLeads reads
// HIGHER than the page tile would. That's the safe direction — same
// never-under-report design as totalOpen's own WT-41 exact count — so the
// digest stays accurate even on a day the /inbox tile itself would be
// under-reporting due to page truncation.
// Before this fix the digest's "N to respond" over-counted by the automated
// total (a live snapshot on 2026-08-13 measured 40-41 rows — see the prod
// query in PR #761; this bucket only grows, nothing resolves a marketing
// email out of 'unresponded', so don't trust a hardcoded count here).
//
// #229: counts alone don't say WHO — a promised customer buried inside "4
// awaiting reply" is invisible. Beneath the existing counts (which stay the
// TRUE totals, unchanged), three sections now also list names:
//   - overdue follow-ups (from listDueFollowUps, legacy-rebook-anchored ones
//     filtered — see isLegacyRebookAnchored's doc)
//   - quotes awaiting reply (sorted so a same-day promise and a week-old
//     silence can't be confused — see the comparator below)
//   - deposits pending (oldest-approved first, with the dollar amount)
// Every named list is capped (NAMED_LIST_CAP) with an exact "+N more" — a
// message must stay well under Telegram's 4096-char limit even on a heavy
// day, and an unbounded by-name list was the #229 first-attempt's own bug
// (the ~124-row Neighbor pool would have flooded it before the rebook filter
// existed). Sort-only raw timestamps never leave collectOpsDigest — only the
// derived whole-day counts do.

import { listQuotes, type QuoteListItem } from '@/lib/quotes';
import { listFulfillmentCards } from '@/lib/inventory/jobs';
import { FULFILLMENT_STAGE_LABELS } from '@/lib/inventory/fulfillmentStage';
import { deriveStatus, isParkedLegacyRebookDraft } from '@/lib/quoteStatus';
import { listOpenItems, listDueFollowUps } from '@/lib/dashboard/inbox/store';
import type { DueFollowUp } from '@/lib/dashboard/inbox/types';

// The digest's quote-pipeline counts must see EVERY open quote, not just the
// newest page — a high explicit scan limit (well above the foreseeable table
// size) so listQuotes()'s default 500 cap can't silently truncate a count.
const DIGEST_QUOTE_SCAN_LIMIT = 10_000;

// #229: cap on every NAMED list (installs included) so a heavy day can't push
// the message toward Telegram's 4096-char limit, and a by-name render can't
// silently balloon the way the ~124-row legacy_rebook pool would if it ever
// leaked in unfiltered. 5 is plenty to act on at a glance; the header count
// beside it stays the TRUE total.
const NAMED_LIST_CAP = 5;

const MS_PER_DAY = 86_400_000;

type DigestInstall = {
  jobNumber: number | null;
  customerName: string | null;
  stageLabel: string;
  isTest: boolean;
};

/** A named line for the "overdue follow-ups" section beneath the inbox count. */
export type DigestFollowUpItem = {
  displayName: string;
  /** Whole days overdue, floored, clamped >= 0 (a follow-up due later today
   *  reads 0, never negative). */
  daysOverdue: number;
};

/** A named line for the "quotes awaiting reply" section. */
export type DigestQuoteItem = {
  displayName: string;
  /** Whole days since sent, floored, clamped >= 0. Sort-only precision (the
   *  raw timestamp) never reaches this type — see opsDigestMessage's sort
   *  comment for why whole days alone can't be sorted on. */
  daysSinceSent: number;
};

/** A named line for the "deposits pending" section. */
export type DigestDepositItem = {
  displayName: string;
  /** Pre-formatted ("$2,500") or "amount unknown" for a null total — never
   *  render a null balance as "$0", which reads as nothing owed. */
  amountLabel: string;
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
  /** #229: named detail beneath quotesAwaitingReplyCount — see DigestQuoteItem.
   *  Uncapped here (opsDigestMessage caps the render); already sorted (see the
   *  comparator in collectOpsDigest). Only quotes with a quote_sent_at are
   *  included (a viewed-but-never-marked-sent legacy row can't show "days
   *  since sent") — the header count above is unaffected by that. */
  awaitingReplyNamed: DigestQuoteItem[];
  /** Customer asked for edits — WE owe a revised quote (deriveStatus 'changes_requested'). */
  changesRequestedCount: number;
  /** Approved, deposit not yet paid. */
  depositsPendingCount: number;
  /** #229: named detail beneath depositsPendingCount — see DigestDepositItem.
   *  Uncapped here; sorted oldest-approved-first (longest pending = most
   *  urgent survives the render cap). */
  depositsPendingNamed: DigestDepositItem[];
  /** Open inbox items needing a first response, matching /inbox (null = read
   *  failed — show the line without a fake number rather than lie). */
  inboxOpenCount: number | null;
  /** #265: lead_kind='automated' rows excluded from inboxOpenCount (totalOpen
   *  − totalLeads) — the "hidden but real" bucket (system noise, plus any
   *  real leads the classifier currently misfires on — see PR #761's notes;
   *  not yet a filed ledger row as of this write). Rendered only when > 0 so
   *  a quiet/noise-free morning stays clean; null on a failed inbox read
   *  (same fail-soft contract as inboxOpenCount). */
  inboxFilteredCount: number | null;
  /** Follow-ups due today or overdue, matching the inbox follow-up strip
   *  (still INCLUDES legacy-rebook-anchored ones — unchanged, existing
   *  behavior; the strip itself has never excluded them). */
  inboxFollowUpsDueCount: number | null;
  /** #229: named detail beneath inboxFollowUpsDueCount — legacy-rebook-
   *  anchored follow-ups are FILTERED OUT here (unlike the count above), so a
   *  Neighbor draft's system follow-up can't flood the message with ~124
   *  named rows. null on a failed inbox read (same fail-soft contract as
   *  inboxFollowUpsDueCount); [] when the read succeeded but nothing
   *  (post-filter) is due. Uncapped here — opsDigestMessage caps the render. */
  overdueFollowUps: DigestFollowUpItem[] | null;
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

// ─── #229 named-detail helpers (pure) ───────────────────────────────────────

/** name → phone → email → "(no name)". Never renders empty/whitespace-only. */
function pickDisplayName(name: string | null, phone: string | null, email: string | null): string {
  const n = name?.trim();
  if (n) return n;
  const p = phone?.trim();
  if (p) return p;
  const e = email?.trim();
  if (e) return e;
  return '(no name)';
}

/** Whole days between `ts` and `now`, floored, clamped to >= 0. An invalid/
 *  missing timestamp (NaN ms) reads as 0 rather than propagating NaN into the
 *  message — a bad date should degrade to "today", never render "NaN days". */
function daysBetween(now: Date, ts: Date): number {
  const ms = now.getTime() - ts.getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor(ms / MS_PER_DAY));
}

/** `total` is stored in DOLLARS (not cents) on the quotes table — mirrors
 *  needsAction.ts's own formatUsd comment/convention. A null total must never
 *  render as "$0" (reads as nothing owed) — "amount unknown" instead. */
function formatDollarsOrUnknown(total: number | null): string {
  if (total == null || !Number.isFinite(total)) return 'amount unknown';
  return `$${Math.round(total).toLocaleString('en-US')}`;
}

/** Build a derived named list; on any unexpected error (a malformed row this
 *  function didn't anticipate), log + degrade to [] rather than let one bad
 *  section take the whole digest down — the fail-soft-isolation requirement
 *  extended to derivation, not just IO (the reads underneath already fail
 *  soft to [] / null on their own — see listQuotes/listFulfillmentCards and
 *  the safeCount wrapping below). */
function safeBuild<T>(build: () => T[], label: string): T[] {
  try {
    return build();
  } catch (err) {
    console.error(`[opsDigest] ${label} build failed:`, err);
    return [];
  }
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
  // #229: every quote-derived list below (counts AND the new named lists)
  // reads from `real`, so is_test/legacy_rebook/view_only can never reach a
  // named line by construction — no separate filter needed downstream.
  const real = allQuotes.filter((q) => !q.is_test && !q.legacy_rebook && !q.view_only);
  // deriveStatus is the canonical lifecycle read: 'draft' = never sent and not
  // terminal; 'sent'/'viewed' = out with the customer, no decision yet;
  // 'approved' = customer said yes, deposit not yet paid.
  const quotesToSendCount = real.filter((q) => deriveStatus(q) === 'draft').length;
  const awaitingReplyQuotes = real.filter((q) => {
    const s = deriveStatus(q);
    return s === 'sent' || s === 'viewed';
  });
  const quotesAwaitingReplyCount = awaitingReplyQuotes.length;
  const changesRequestedCount = real.filter((q) => deriveStatus(q) === 'changes_requested').length;
  const depositsPendingQuotes = real.filter((q) => deriveStatus(q) === 'approved');
  const depositsPendingCount = depositsPendingQuotes.length;
  // #263: "still parked?" routed through the ONE shared predicate
  // (isParkedLegacyRebookDraft) — is_test/view_only stay local ANDs (a
  // different, orthogonal exclusion, not part of what "parked" means).
  const rebookDraftCount = allQuotes.filter(
    (q) => !q.is_test && !q.view_only && isParkedLegacyRebookDraft(q),
  ).length;

  // #229: named "quotes awaiting reply" detail. Only quotes with a
  // quote_sent_at are included — mirrors needsAction.ts's own nudge bucket,
  // which requires the same field for the identical reason (no sent
  // timestamp, no "days since sent" to show). The header count above is
  // NOT filtered this way — it still counts every sent/viewed quote.
  //
  // Sort: freshest-first among sends under 24h old, oldest-first beyond that
  // — a WHOLE-DAY count alone can't do this (every same-day send ties at 0,
  // so a naive sort-then-cap keeps whatever order the DB happened to return).
  // Sorting on the RAW timestamp instead means a same-day promise (the most
  // salvageable) survives the render cap, and — once nothing is under 24h —
  // the longest-ignored surfaces first. The raw ms value is a SORT-ONLY local
  // (never attached to the returned DigestQuoteItem — only the derived whole
  // day count is).
  const awaitingReplyNamed = safeBuild(() => {
    const withRawTs = awaitingReplyQuotes
      .filter((q): q is QuoteListItem & { quote_sent_at: string } => !!q.quote_sent_at)
      .map((q) => ({ q, sentAtMs: new Date(q.quote_sent_at as string).getTime() }));
    withRawTs.sort((a, b) => {
      const ageA = now.getTime() - a.sentAtMs;
      const ageB = now.getTime() - b.sentAtMs;
      const aFresh = ageA < MS_PER_DAY;
      const bFresh = ageB < MS_PER_DAY;
      if (aFresh !== bFresh) return aFresh ? -1 : 1; // fresh (<24h) group sorts first
      return aFresh ? ageA - ageB : ageB - ageA; // fresh: newest first; stale: oldest first
    });
    return withRawTs.map(({ q, sentAtMs }) => ({
      displayName: pickDisplayName(q.customer_name, q.customer_phone, q.customer_email),
      daysSinceSent: daysBetween(now, new Date(sentAtMs)),
    }));
  }, 'awaiting-reply named list');

  // #229: named "deposits pending" detail — oldest-approved-first (longest
  // pending is most urgent to collect), so the render cap keeps those, not
  // whatever order listQuotes() happened to return.
  const depositsPendingNamed = safeBuild(() => {
    return [...depositsPendingQuotes]
      .sort((a, b) => {
        // deriveStatus === 'approved' guarantees customer_approved_at is set;
        // the Infinity fallback is defensive-only (mirrors the codebase's
        // "defensive only" comment style for guards that can't actually fire).
        const at = a.customer_approved_at ? new Date(a.customer_approved_at).getTime() : Infinity;
        const bt = b.customer_approved_at ? new Date(b.customer_approved_at).getTime() : Infinity;
        return at - bt;
      })
      .map((q) => ({
        displayName: pickDisplayName(q.customer_name, q.customer_phone, q.customer_email),
        amountLabel: formatDollarsOrUnknown(q.total),
      }));
  }, 'deposits-pending named list');

  // Inbox: reuse the /inbox surface's own reads so the counts match the page.
  // ONE listOpenItems() read feeds both numbers below — totalLeads (carries
  // the legacy-rebook exclusion AND excludes lead_kind='automated' noise,
  // #265) matches /inbox's own "Open leads" tile; totalOpen − totalLeads is
  // the filtered-out count (#265). follow-ups-due mirrors the inbox
  // follow-up strip as-is. Never let a Telegram-side summary break on an
  // inbox read hiccup — fall back to null (rendered as no number) for BOTH.
  const inboxOpen = await safeCount(async () => {
    const res = await listOpenItems();
    return res.ok ? { leads: res.totalLeads, open: res.totalOpen } : null;
  }, 'open items');
  const inboxOpenCount = inboxOpen ? inboxOpen.leads : null;
  // Math.max(...,0) is defensive only — totalLeads <= totalOpen always by
  // construction (store.ts), so this never actually clamps.
  const inboxFilteredCount = inboxOpen ? Math.max(inboxOpen.open - inboxOpen.leads, 0) : null;

  // #229: ONE listDueFollowUps() read feeds both the count (unchanged — still
  // includes legacy-rebook-anchored items, matching the strip's own existing
  // behavior) and the named list (filtered — see isLegacyRebookAnchored's doc
  // on DueFollowUp for why a Neighbor draft's system follow-up must not
  // appear by name).
  const dueFollowUps = await safeCount(async () => {
    const res = await listDueFollowUps(now);
    return res.ok ? res.items : null;
  }, 'due follow-ups');
  const inboxFollowUpsDueCount = dueFollowUps ? dueFollowUps.length : null;
  const overdueFollowUps = dueFollowUps
    ? safeBuild(
        () =>
          dueFollowUps
            .filter((f: DueFollowUp) => !f.isLegacyRebookAnchored)
            .map((f: DueFollowUp) => ({
              displayName: pickDisplayName(f.contactName, f.contactPhone, f.contactEmail),
              daysOverdue: daysBetween(now, new Date(f.dueAt)),
            })),
        'overdue follow-ups named list',
      )
    : null;

  return {
    dateLabel: nyDateLabel(),
    installsToday: onDate(today),
    installsTomorrow: onDate(tomorrow),
    quotesToSendCount,
    rebookDraftCount,
    quotesAwaitingReplyCount,
    awaitingReplyNamed,
    changesRequestedCount,
    depositsPendingCount,
    depositsPendingNamed,
    inboxOpenCount,
    inboxFilteredCount,
    inboxFollowUpsDueCount,
    overdueFollowUps,
  };
}

async function safeCount<T>(read: () => Promise<T | null>, label: string): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`[opsDigest] ${label} read failed:`, err);
    return null;
  }
}

// ─── #229 render-side helpers (pure) ────────────────────────────────────────

function pluralDays(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

function agoLabel(days: number): string {
  return days === 0 ? 'today' : `${pluralDays(days)} ago`;
}

function overdueLabel(days: number): string {
  return days === 0 ? 'due today' : `${pluralDays(days)} overdue`;
}

/** Render up to `cap` lines via `toLine`, then an exact "+N more" when the
 *  list runs longer — N is always `items.length - shown.length`, so it can
 *  never drift from what was actually left off. */
function renderCapped<T>(items: T[], cap: number, toLine: (item: T) => string): string[] {
  const shown = items.slice(0, cap);
  const lines = shown.map(toLine);
  const overflow = items.length - shown.length;
  if (overflow > 0) lines.push(`+${overflow} more`);
  return lines;
}

/**
 * Render the digest. ALWAYS returns a message (the heartbeat) — even an
 * all-quiet morning sends, so a silent day means "broken", never "nothing
 * happening". Counts carry the pipeline; installs + (#229) overdue follow-ups /
 * awaiting-reply / deposits-pending are also listed by name beneath their
 * count, each capped at NAMED_LIST_CAP with an exact "+N more".
 */
export function opsDigestMessage(data: OpsDigestData, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, ''); // strip trailing slash so `${base}/` is clean
  const lines: string[] = [`☀️ YLL morning digest — ${data.dateLabel}`, ''];

  const installLine = (i: DigestInstall) =>
    `• Job #${i.jobNumber ?? '—'} ${i.customerName ?? '(no name)'} (${i.stageLabel})${i.isTest ? ' [TEST]' : ''}`;
  // Always show both counts (heartbeat), then list names under each day
  // present — capped (#229): the header count stays the TRUE total even when
  // the list beneath it is trimmed.
  lines.push(`🔧 Installs — today: ${data.installsToday.length} · tomorrow: ${data.installsTomorrow.length}`);
  if (data.installsToday.length) lines.push('Today:', ...renderCapped(data.installsToday, NAMED_LIST_CAP, installLine));
  if (data.installsTomorrow.length) {
    lines.push('Tomorrow:', ...renderCapped(data.installsTomorrow, NAMED_LIST_CAP, installLine));
  }

  lines.push(`📝 Quotes to send: ${data.quotesToSendCount}`);
  lines.push(`🏘️ Neighbor (rebook) drafts: ${data.rebookDraftCount}`);

  lines.push(`⏳ Quotes awaiting reply: ${data.quotesAwaitingReplyCount}`);
  if (data.awaitingReplyNamed.length) {
    lines.push(
      ...renderCapped(data.awaitingReplyNamed, NAMED_LIST_CAP, (q) => `• ${q.displayName} — sent ${agoLabel(q.daysSinceSent)}`),
    );
  }

  lines.push(`✏️ Changes requested: ${data.changesRequestedCount}`);

  lines.push(`💰 Deposits pending: ${data.depositsPendingCount}`);
  if (data.depositsPendingNamed.length) {
    lines.push(...renderCapped(data.depositsPendingNamed, NAMED_LIST_CAP, (d) => `• ${d.displayName} — ${d.amountLabel}`));
  }
  lines.push(`→ ${base}/admin/quotes`);

  lines.push('');
  const inboxBits: string[] = [];
  if (data.inboxOpenCount != null) inboxBits.push(`${data.inboxOpenCount} to respond`);
  // #265: surface what got excluded (system noise, no-shows, etc.) instead of
  // a silent cliff — only when nonzero, so a noise-free morning stays clean.
  // Mirrors /inbox's own InboxSummaryStrip "· N filtered" texture.
  if (data.inboxFilteredCount != null && data.inboxFilteredCount > 0) {
    inboxBits.push(`${data.inboxFilteredCount} filtered`);
  }
  if (data.inboxFollowUpsDueCount != null) inboxBits.push(`${data.inboxFollowUpsDueCount} follow-ups due`);
  lines.push(inboxBits.length ? `📥 Inbox — ${inboxBits.join(' · ')}` : '📥 Inbox');
  // #229: named detail — null (read failed) or [] (nothing after the rebook
  // filter) both render nothing extra here, same as the count above omitting
  // itself on a failed read.
  if (data.overdueFollowUps && data.overdueFollowUps.length) {
    lines.push(
      ...renderCapped(data.overdueFollowUps, NAMED_LIST_CAP, (f) => `• ${f.displayName} — ${overdueLabel(f.daysOverdue)}`),
    );
  }
  lines.push(`→ ${base}/inbox`);

  lines.push('');
  lines.push(`Dashboard → ${base}/`);

  return lines.join('\n');
}
