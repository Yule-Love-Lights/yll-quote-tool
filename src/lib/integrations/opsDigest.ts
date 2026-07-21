// src/lib/integrations/opsDigest.ts
// Morning ops digest (Phase 1 of the 2026-07-19 text-ops plan). collectOpsDigest
// gathers the day's operational snapshot via the existing data modules;
// opsDigestMessage is the PURE formatter (telegramMessages.ts style — no IO, no
// process.env, baseUrl passed in). The cron route /api/ops/digest sends the
// result through notifyTelegram every morning.

import { listQuotes, type QuoteListItem } from '@/lib/quotes';
import { listFulfillmentCards } from '@/lib/inventory/jobs';
import { FULFILLMENT_STAGE_LABELS } from '@/lib/inventory/fulfillmentStage';
import { deriveStatus } from '@/lib/quoteStatus';

const MAX_LINES = 5; // per-section cap; the counts carry the full totals

type DigestInstall = {
  jobNumber: number | null;
  customerName: string | null;
  stageLabel: string;
  isTest: boolean;
};
type DigestQuote = {
  quoteNumber: number | null;
  customerName: string | null;
  total: number | null;
};

export type OpsDigestData = {
  installsToday: DigestInstall[];
  installsTomorrow: DigestInstall[];
  quotesToSend: DigestQuote[];
  quotesToSendCount: number;
  depositsPending: DigestQuote[];
  depositsPendingCount: number;
};

/** Current date (YYYY-MM-DD) in the shop's timezone — never the server's. */
function nyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export async function collectOpsDigest(): Promise<OpsDigestData> {
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

  // Legacy rebook drafts (#155) are a deliberate separate send wave — counting
  // 130+ of them as "quotes to send" every morning would bury the real number.
  // Test quotes are simulation data, never operational work.
  const quotes = (await listQuotes()).filter((q) => !q.is_test && !q.legacy_rebook);
  // deriveStatus is the canonical lifecycle read: 'draft' = never sent and not
  // terminal; 'approved' = customer said yes, deposit not yet paid.
  const toSend = quotes.filter((q) => deriveStatus(q) === 'draft');
  const pending = quotes.filter((q) => deriveStatus(q) === 'approved');
  const asDigestQuote = (q: QuoteListItem): DigestQuote => ({
    quoteNumber: q.quote_number,
    customerName: q.customer_name,
    total: q.total,
  });

  return {
    installsToday: onDate(today),
    installsTomorrow: onDate(tomorrow),
    quotesToSend: toSend.slice(0, MAX_LINES).map(asDigestQuote),
    quotesToSendCount: toSend.length,
    depositsPending: pending.slice(0, MAX_LINES).map(asDigestQuote),
    depositsPendingCount: pending.length,
  };
}

/**
 * Render the digest, or null when there is nothing to say — an all-quiet
 * morning sends NO ping (a daily "nothing happening" message trains everyone
 * to ignore the channel).
 */
export function opsDigestMessage(data: OpsDigestData, baseUrl: string): string | null {
  const empty =
    !data.installsToday.length &&
    !data.installsTomorrow.length &&
    data.quotesToSendCount === 0 &&
    data.depositsPendingCount === 0;
  if (empty) return null;

  const lines: string[] = ['☀️ YLL morning digest'];

  const installLine = (i: DigestInstall) =>
    `• Job #${i.jobNumber ?? '—'} ${i.customerName ?? '(no name)'} (${i.stageLabel})${i.isTest ? ' [TEST]' : ''}`;
  if (data.installsToday.length) lines.push('Installs today:', ...data.installsToday.map(installLine));
  if (data.installsTomorrow.length) {
    lines.push('Installs tomorrow:', ...data.installsTomorrow.map(installLine));
  }

  const quoteLine = (q: DigestQuote) =>
    `• #${q.quoteNumber ?? '—'} ${q.customerName ?? '(no name)'}${q.total != null ? ` — $${q.total.toLocaleString()}` : ''}`;
  if (data.quotesToSendCount > 0) {
    lines.push(`Quotes to send: ${data.quotesToSendCount}`, ...data.quotesToSend.map(quoteLine));
    if (data.quotesToSendCount > data.quotesToSend.length) {
      lines.push(`…+${data.quotesToSendCount - data.quotesToSend.length} more`);
    }
  }
  if (data.depositsPendingCount > 0) {
    lines.push(`Deposits pending: ${data.depositsPendingCount}`, ...data.depositsPending.map(quoteLine));
    if (data.depositsPendingCount > data.depositsPending.length) {
      lines.push(`…+${data.depositsPendingCount - data.depositsPending.length} more`);
    }
  }

  lines.push(`Admin → ${baseUrl}/admin/quotes`);
  return lines.join('\n');
}
