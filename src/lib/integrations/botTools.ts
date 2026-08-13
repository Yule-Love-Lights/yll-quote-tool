// src/lib/integrations/botTools.ts
// Read tools for the staff text-ops bot (Phase 1 of the 2026-07-19 text-ops
// plan): status lookups + the install schedule. Data comes in via the existing
// data modules (quotes / fulfillment cards) and one plain-text reply goes out —
// no process.env, no direct Supabase, so the tools stay trivially mockable and
// reusable by a future MCP server (the plan's tool-layer idea).

import { listQuotes, type QuoteListItem } from '@/lib/quotes';
import { listFulfillmentCards, type FulfillmentCard } from '@/lib/inventory/jobs';
import { FULFILLMENT_STAGE_LABELS } from '@/lib/inventory/fulfillmentStage';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';

const MAX_HITS = 5; // cap each hit list so a common surname never balloons a reply

// Bot wording over the canonical lifecycle — deriveStatus stays the single
// source of truth for WHICH state a quote is in; only the phrasing is local.
const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft, not sent',
  sent: 'Sent, not viewed',
  viewed: 'Sent + viewed',
  approved: 'Approved, deposit pending',
  booked: 'Booked (deposit paid)',
  changes_requested: 'Changes requested',
  declined: 'Declined',
  cancelled: 'Cancelled',
  abandoned: 'Abandoned',
};

function quoteLine(q: QuoteListItem): string {
  const num = q.quote_number != null ? `#${q.quote_number}` : '#—';
  const money = q.total != null ? ` — $${q.total.toLocaleString()}` : '';
  const test = q.is_test ? ' [TEST]' : '';
  return `${num} ${q.customer_name ?? '(no name)'} — ${STATUS_LABELS[deriveStatus(q)]}${money}${test}`;
}

function jobLine(c: FulfillmentCard): string {
  const num = c.jobNumber != null ? `#${c.jobNumber}` : '#—';
  const install = c.installDate ? `, install ${c.installDate.slice(0, 10)}` : '';
  const test = c.isTest ? ' [TEST]' : '';
  return `Job ${num} ${c.customerName ?? '(no name)'} — ${FULFILLMENT_STAGE_LABELS[c.stage]}${install}${test}`;
}

/** Current date (YYYY-MM-DD) in the shop's timezone — never the server's. */
function nyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Look up quotes + jobs by customer name (case-insensitive substring) or by an
 * exact quote/job number. Searches BOTH sides — staff rarely know which one
 * they're asking about.
 */
export async function runStatusTool(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return 'Who or which number should I look up?';
  const numeric = /^\d+$/.test(q) ? Number(q) : null;
  const needle = q.toLowerCase();

  // Legacy rebook DRAFTS excluded on purpose: 130+ not-yet-sent legacy quotes
  // (#155) carry real customer names and would flood any name search. Once a
  // legacy quote is actually sent (the send wave), it's a live quote staff
  // legitimately ask about — only the unsent backlog stays invisible here.
  const quotes = (await listQuotes()).filter(
    (r) => !(r.legacy_rebook && deriveStatus(r) === 'draft'),
  );
  const quoteHits = quotes.filter((r) =>
    numeric != null
      ? r.quote_number === numeric
      : (r.customer_name ?? '').toLowerCase().includes(needle),
  );
  const jobHits = (await listFulfillmentCards()).filter((c) =>
    numeric != null
      ? c.jobNumber === numeric
      : (c.customerName ?? '').toLowerCase().includes(needle),
  );

  if (!quoteHits.length && !jobHits.length) return `No quote or job matching "${q}".`;

  const lines: string[] = [];
  quoteHits.slice(0, MAX_HITS).forEach((r) => lines.push(quoteLine(r)));
  if (quoteHits.length > MAX_HITS) lines.push(`…+${quoteHits.length - MAX_HITS} more quotes`);
  jobHits.slice(0, MAX_HITS).forEach((c) => lines.push(jobLine(c)));
  if (jobHits.length > MAX_HITS) lines.push(`…+${jobHits.length - MAX_HITS} more jobs`);
  return lines.join('\n');
}

/**
 * Installs on the fulfillment board for today / tomorrow / the next 7 days,
 * bucketed by the shop's (America/New_York) calendar date — a late-evening ET
 * ask must not roll to the UTC "tomorrow". installDate compares on its date
 * part only (first 10 chars) so a date-only or full-ISO value both work.
 */
export async function runScheduleTool(when: 'today' | 'tomorrow' | 'week'): Promise<string> {
  const today = nyToday();
  const [from, to] =
    when === 'today'
      ? [today, today]
      : when === 'tomorrow'
        ? [addDays(today, 1), addDays(today, 1)]
        : [today, addDays(today, 6)];

  const hits = (await listFulfillmentCards())
    .filter((c) => {
      const d = c.installDate?.slice(0, 10);
      return !!d && d >= from && d <= to;
    })
    .sort((a, b) => (a.installDate ?? '').localeCompare(b.installDate ?? ''));

  if (!hits.length) {
    const label =
      when === 'today' ? 'today' : when === 'tomorrow' ? 'tomorrow' : 'in the next 7 days';
    return `No installs scheduled ${label}.`;
  }
  return hits
    .map((c) => {
      const num = c.jobNumber != null ? `#${c.jobNumber}` : '#—';
      const test = c.isTest ? ' [TEST]' : '';
      return `${c.installDate!.slice(0, 10)} — Job ${num} ${c.customerName ?? '(no name)'} (${FULFILLMENT_STAGE_LABELS[c.stage]})${test}`;
    })
    .join('\n');
}
