import Link from 'next/link';
import type { WorkflowBoard as WorkflowBoardData, StageBucket } from '@/lib/dashboard/workflowBoard';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/** A status sub-row: a colored dot, its label, then count · value. Rendered as a
 *  link when `href` is given (the Quotes rows deep-link to the admin list). */
type StatusRow = { key: string; label: string; dot: string; bucket: StageBucket; href?: string };

function StatusRowItem({ row }: { row: StatusRow }) {
  const { label, dot, bucket, href } = row;
  const inner = (
    <>
      <span className="flex items-center gap-2 min-w-0">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full shrink-0"
          style={{ background: dot }}
        />
        <span className="truncate" style={{ color: 'var(--op-text-2)' }}>
          {label}
        </span>
      </span>
      <span className="tabular-nums shrink-0 pl-2" style={{ color: 'var(--op-text)' }}>
        <span className="font-medium">{bucket.count}</span>
        {bucket.totalUsd > 0 && (
          <span style={{ color: 'var(--op-text-dim)' }}>{` · ${fmtMoney(bucket.totalUsd)}`}</span>
        )}
        {/* Row 389: this total may include a frozen/unreconciled invoice —
            flag it here rather than silently dropping it from the sum. */}
        {bucket.staleCount > 0 && (
          <span
            title={`${bucket.staleCount} of ${bucket.count} unreconciled — this total is provisional`}
            aria-label={`${bucket.staleCount} unreconciled invoice${bucket.staleCount === 1 ? '' : 's'} in this total`}
            style={{ color: 'var(--op-warning, #b45309)' }}
          >
            {' ⚠'}
          </span>
        )}
      </span>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="flex items-center justify-between gap-2 rounded-md -mx-2 px-2 py-1.5 text-base transition-colors hover:bg-[var(--op-bg-hover)]"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 px-0 py-1.5 text-base">{inner}</div>
  );
}

function StageColumn({
  title,
  accent,
  headline,
  rows,
  emptyLabel,
  isEmpty,
  footnote,
  ariaLabel,
}: {
  title: string;
  accent: string;
  headline: { count: number; valueUsd: number; suffix: string };
  rows: StatusRow[];
  emptyLabel: string;
  isEmpty: boolean;
  footnote?: string;
  ariaLabel: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className="flex flex-col rounded-xl border shadow-sm"
      style={{
        background: 'var(--op-bg-raised)',
        borderColor: 'var(--op-border)',
        borderTop: `3px solid ${accent}`,
      }}
    >
      <header className="px-4 pt-4 pb-3">
        <h3
          className="text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--op-text-dim)' }}
        >
          {title}
        </h3>
        <div className="mt-1 flex items-baseline gap-2">
          <span
            className="text-3xl font-semibold tabular-nums leading-none"
            style={{ color: 'var(--op-text)' }}
          >
            {headline.count}
          </span>
          <span className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
            {headline.suffix}
            {headline.valueUsd > 0 ? ` · ${fmtMoney(headline.valueUsd)}` : ''}
          </span>
        </div>
      </header>
      <div className="px-4 pb-4 border-t pt-2" style={{ borderColor: 'var(--op-border)' }}>
        {isEmpty ? (
          <p className="py-2 text-base" style={{ color: 'var(--op-text-dim)' }}>
            {emptyLabel}
          </p>
        ) : (
          <div className="flex flex-col">
            {rows.map((row) => (
              <StatusRowItem key={row.key} row={row} />
            ))}
          </div>
        )}
        {footnote && (
          <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--op-text-dim)' }}>
            {footnote}
          </p>
        )}
      </div>
    </section>
  );
}

// Canonical-ish status dot colors. Quotes mirror the lifecycle intent (gold
// draft → blue sent → green approved → evergreen booked); Jobs use a sensible
// billing progression. Pulled from the operator/brand palette in globals.css.
const QUOTE_DOTS = {
  draft: 'var(--brand-gold)',
  sent: '#378ADD',
  approved: '#639922',
  booked: 'var(--brand-evergreen)',
} as const;

const JOB_DOTS = {
  to_schedule: 'var(--brand-gold)',
  installed: '#639922',
  requires_invoicing: '#D4537E',
  done: 'var(--brand-evergreen)',
  cancelled: 'var(--op-text-dim)',
} as const;

const INVOICE_DOTS = {
  draft: 'var(--brand-gold)',
  awaiting_payment: '#D4537E',
  paid: 'var(--brand-evergreen)',
  cancelled: 'var(--op-text-dim)',
} as const;

const QUOTES_HREF = '/admin/quotes';
const INVOICES_HREF = '/admin/invoices';

// Row 396 (MED): a bucket's ⚠ (staleCount > 0, rendered inside
// StatusRowItem above) used to link to the same unfiltered INVOICES_HREF as
// everything else — a bucket reading "3 unreconciled" gave the owner no way
// to find WHICH three. /admin/invoices now reads ?stale=1 and filters to
// just the unreconciled rows (isStaleInvoiceSnapshot, the same check this
// board's own queries.ts already runs) — route a stale bucket's link there
// instead of the plain list. Pure, exported for its own unit test (no
// jsdom/testing-library in this repo — same pattern as
// admin/jobs/[id]/page.tsx's cancelActionMessage).
export function invoicesRowHref(bucket: StageBucket): string {
  return bucket.staleCount > 0 ? `${INVOICES_HREF}?stale=1` : INVOICES_HREF;
}

/** The Jobber-style pipeline board (ledger #83): Quotes · Jobs · Invoices.
 *  All three columns are live from real data — Invoices wired to the #83 Phase 3
 *  billing flow (its money lens is the outstanding balance still to collect). */
export function WorkflowBoard({ board }: { board: WorkflowBoardData }) {
  const q = board.quotes;
  const j = board.jobs;
  const inv = board.invoices;

  // Quotes headline = booked (the deals that converted), mirroring the KPI strip.
  const quoteRows: StatusRow[] = [
    { key: 'draft', label: 'Draft', dot: QUOTE_DOTS.draft, bucket: q.draft, href: QUOTES_HREF },
    { key: 'sent', label: 'Awaiting response', dot: QUOTE_DOTS.sent, bucket: q.awaitingResponse, href: QUOTES_HREF },
    { key: 'approved', label: 'Approved · awaiting deposit', dot: QUOTE_DOTS.approved, bucket: q.approved, href: QUOTES_HREF },
    { key: 'booked', label: 'Booked · deposit paid', dot: QUOTE_DOTS.booked, bucket: q.booked, href: QUOTES_HREF },
  ];
  const quotesTotal = q.draft.count + q.awaitingResponse.count + q.approved.count + q.booked.count;

  // "Active" jobs = everything still in flight (before done / cancelled).
  const activeJobsCount =
    j.to_schedule.count + j.scheduled.count + j.installed.count + j.requires_invoicing.count;
  const activeJobsUsd =
    j.to_schedule.totalUsd + j.scheduled.totalUsd + j.installed.totalUsd + j.requires_invoicing.totalUsd;
  const jobRows: StatusRow[] = [
    { key: 'to_schedule', label: 'To schedule', dot: JOB_DOTS.to_schedule, bucket: j.to_schedule },
    // WT-19: the 'scheduled' bucket was removed — no code path ever writes a job
    // into 'scheduled' (jobs jump to_schedule → installed), so it always read 0.
    { key: 'installed', label: 'Installed', dot: JOB_DOTS.installed, bucket: j.installed },
    { key: 'requires_invoicing', label: 'Requires invoicing', dot: JOB_DOTS.requires_invoicing, bucket: j.requires_invoicing },
    { key: 'done', label: 'Done', dot: JOB_DOTS.done, bucket: j.done },
    { key: 'cancelled', label: 'Cancelled', dot: JOB_DOTS.cancelled, bucket: j.cancelled },
  ];
  const jobsTotal = jobRows.reduce((sum, r) => sum + r.bucket.count, 0);

  // Invoices column: the money lens is the OUTSTANDING balance (draft +
  // awaiting_payment) — what's still to collect. Paid/cancelled show counts.
  const invoiceRows: StatusRow[] = [
    { key: 'draft', label: 'Draft', dot: INVOICE_DOTS.draft, bucket: inv.draft, href: invoicesRowHref(inv.draft) },
    { key: 'awaiting_payment', label: 'Awaiting payment', dot: INVOICE_DOTS.awaiting_payment, bucket: inv.awaiting_payment, href: invoicesRowHref(inv.awaiting_payment) },
    { key: 'paid', label: 'Paid', dot: INVOICE_DOTS.paid, bucket: inv.paid, href: invoicesRowHref(inv.paid) },
    { key: 'cancelled', label: 'Cancelled', dot: INVOICE_DOTS.cancelled, bucket: inv.cancelled, href: invoicesRowHref(inv.cancelled) },
  ];
  const invoicesTotal = invoiceRows.reduce((sum, r) => sum + r.bucket.count, 0);
  const outstandingCount = inv.draft.count + inv.awaiting_payment.count;
  const outstandingUsd = inv.draft.totalUsd + inv.awaiting_payment.totalUsd;

  return (
    <section aria-label="Workflow pipeline" className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--op-text)' }}>
          Workflow
        </h2>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
          Quotes → Jobs → Invoices
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <StageColumn
          ariaLabel="Quotes pipeline"
          title="Quotes"
          accent="#D4537E"
          headline={{ count: q.booked.count, valueUsd: q.booked.totalUsd, suffix: 'booked' }}
          rows={quoteRows}
          isEmpty={quotesTotal === 0}
          emptyLabel="No quotes yet."
        />

        <StageColumn
          ariaLabel="Jobs pipeline"
          title="Jobs"
          accent="#639922"
          headline={{ count: activeJobsCount, valueUsd: activeJobsUsd, suffix: 'active' }}
          rows={jobRows}
          isEmpty={jobsTotal === 0}
          emptyLabel="No jobs yet — a job is created when a deposit is paid."
          footnote="Auto-created when a deposit is paid. Scheduling runs in home.works."
        />

        <StageColumn
          ariaLabel="Invoices pipeline"
          title="Invoices"
          accent="#378ADD"
          headline={{ count: outstandingCount, valueUsd: outstandingUsd, suffix: 'outstanding' }}
          rows={invoiceRows}
          isEmpty={invoicesTotal === 0}
          emptyLabel="No invoices yet — created when a job is marked complete."
          footnote="Auto-created when a job is completed. The 50% balance is collected via Valor after install."
        />
      </div>
    </section>
  );
}
