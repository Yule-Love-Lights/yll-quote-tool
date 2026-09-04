// Shared chrome for the time-tracking pages: /admin/time-tracking, its
// per-person record, and /my-hours (Jason S62).
//
// PRESENTATION ONLY. Nothing here reads data, counts hours or touches money;
// every figure is handed in already formatted. It exists so the three pages
// share one look — the dashboard's raised-card vocabulary (KpiCard, the
// inbox summary strip) instead of bare Tailwind greys laid straight on the
// cream operator surface, which is what they had until S62 and what read as
// a wireframe on a real screen.
//
// SERVER-SAFE on purpose: no hooks and no 'use client', so the server pages
// render these directly and the client editors (ManualShiftEditor,
// ShiftPayPanel, RateHistorySection) import the same class strings for
// their inputs and buttons without a second copy of the styling.

import Link from 'next/link';
import type { ReactNode } from 'react';

import { RANGE_KEYS, rangeLabel, type RangeKey } from '@/lib/personHours';

/* ── form controls, as class strings the client editors share ──────────── */

export const inputClass =
  'rounded-md border px-2.5 py-1.5 text-sm text-gray-900 bg-white border-gray-300 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200';
export const labelClass = 'block text-xs font-medium text-gray-600';
export const btnPrimary =
  'inline-flex items-center rounded-md px-3.5 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50';
export const btnPrimaryStyle = { background: 'var(--brand-evergreen-3)' } as const;
export const btnSecondary =
  'inline-flex items-center rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50';
export const btnTextDanger =
  'text-xs font-medium text-red-700 hover:underline disabled:opacity-40 disabled:no-underline';
export const btnTextQuiet =
  'text-xs font-medium text-gray-500 hover:text-gray-900 hover:underline';

/* ── page header ──────────────────────────────────────────────────────── */

export function PageHeader({
  eyebrow = 'Yule Love Lights',
  title,
  subtitle,
  back,
  badges,
  aside,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** A link back up the tree, drawn above the eyebrow. */
  back?: { href: string; label: string };
  /** Pills drawn beside the title (Office / Field / inactive). */
  badges?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back && (
          <p className="mb-2 text-xs">
            <Link
              href={back.href}
              className="inline-flex items-center gap-1 font-medium hover:underline"
              style={{ color: 'var(--op-text-dim)' }}
            >
              <span aria-hidden="true">←</span> {back.label}
            </Link>
          </p>
        )}
        <p
          className="mb-1 text-xs font-semibold uppercase tracking-widest"
          style={{ color: 'var(--brand-evergreen-3)' }}
        >
          {eyebrow}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--op-text)' }}>
            {title}
          </h1>
          {badges}
        </div>
        {subtitle && (
          <p className="mt-1 text-sm" style={{ color: 'var(--op-text-dim)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {aside}
    </div>
  );
}

/* ── stat tiles ───────────────────────────────────────────────────────── */

/**
 * One figure with a label, the dashboard's KpiCard shape. `tone` colours the
 * number only: 'warn' for a figure that wants a look (open exceptions, hours
 * still owed), 'good' for one that is fine as it stands.
 */
export function StatTile({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'muted';
}) {
  const color =
    tone === 'warn'
      ? '#92400e'
      : tone === 'good'
        ? '#166534'
        : tone === 'muted'
          ? 'var(--op-text-dim)'
          : 'var(--op-text)';
  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>;
}

/* ── the card every section sits in ───────────────────────────────────── */

/**
 * A raised white card with a titled header. The long explanatory copy the
 * review lenses asked for over the last sessions is real and stays — it just
 * no longer sits as a wall of grey text ABOVE every table. It goes in `help`,
 * a closed-by-default disclosure under the header: still in the markup (so
 * the page tests that pin those sentences keep passing, and a screen reader
 * still reaches it), one click away for anyone who wants it, out of the way
 * for the admin who opens this page every Friday.
 *
 * `flush` drops the body padding so a table or a day list can run edge to
 * edge; `footer` draws a tinted band under the body (the add-a-shift form).
 */
export function Card({
  title,
  subtitle,
  aside,
  help,
  helpLabel = 'How this is counted',
  flush = false,
  footer,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  flush?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="mb-6 overflow-hidden rounded-xl border shadow-sm"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <header
        className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b px-4 py-3.5 sm:px-5"
        style={{ borderColor: 'var(--op-border)' }}
      >
        <div className="min-w-0">
          <h2 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-sm" style={{ color: 'var(--op-text-dim)' }}>
              {subtitle}
            </p>
          )}
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </header>
      {help && (
        <details className="group border-b px-4 sm:px-5" style={{ borderColor: 'var(--op-border)' }}>
          <summary
            className="cursor-pointer select-none py-2 text-xs font-medium hover:underline"
            style={{ color: 'var(--op-text-dim)' }}
          >
            {helpLabel}
          </summary>
          <div className="space-y-2 pb-3 text-sm" style={{ color: 'var(--op-text-2)' }}>
            {help}
          </div>
        </details>
      )}
      <div className={flush ? '' : 'px-4 py-4 sm:px-5'}>{children}</div>
      {footer && (
        <div
          className="border-t px-4 py-3.5 sm:px-5"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)' }}
        >
          {footer}
        </div>
      )}
    </section>
  );
}

/** A small heading inside a card body, for a second list under the first. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3
      className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide"
      style={{ color: 'var(--op-text-dim)' }}
    >
      {children}
    </h3>
  );
}

/* ── pills ────────────────────────────────────────────────────────────── */

export type PillTone = 'neutral' | 'green' | 'amber' | 'blue' | 'red' | 'gold';

const PILL: Record<PillTone, string> = {
  // The class string STARTS with `rounded-full bg-<tone>-50` on purpose:
  // HoursDayList.test finds the midnight-sweep badge by exactly that prefix.
  neutral: 'rounded-full bg-gray-100 text-gray-700',
  green: 'rounded-full bg-green-50 text-green-800',
  amber: 'rounded-full bg-amber-50 text-amber-800',
  blue: 'rounded-full bg-blue-50 text-blue-800',
  red: 'rounded-full bg-red-50 text-red-800',
  gold: 'rounded-full text-[#7A5E20] bg-[#F4ECD8]',
};

/** The pill classes on their own, for a Link that wants to look like one. */
export function pillClass(tone: PillTone, nowrap = false): string {
  return `${PILL[tone]} px-2 py-0.5 text-xs font-medium${nowrap ? ' whitespace-nowrap' : ''}`;
}

/**
 * `nowrap` is OFF by default. The longest pill on a shift row ("Closed by
 * the midnight sweep — tell the office what time you stopped") was clipped
 * mid-sentence at 375px when it could not wrap, and that clip hides from any
 * overflow measurement. A pill that must stay on one line asks for it.
 */
export function Pill({
  tone = 'neutral',
  nowrap = false,
  children,
}: {
  tone?: PillTone;
  nowrap?: boolean;
  children: ReactNode;
}) {
  return <span className={pillClass(tone, nowrap)}>{children}</span>;
}

/* ── range tabs ───────────────────────────────────────────────────────── */

/** Last 7 / 30 / 90 days / All time, as a segmented control. Plain links, so
 * the choice lives in the URL and survives a refresh. */
export function RangeTabs({ basePath, range }: { basePath: string; range: RangeKey }) {
  return (
    <nav
      aria-label="Range"
      className="inline-flex rounded-lg border p-0.5"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)' }}
    >
      {RANGE_KEYS.map((key) => {
        const active = key === range;
        return (
          <Link
            key={key}
            href={`${basePath}?range=${key}`}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-1 text-xs font-medium whitespace-nowrap ${
              active ? 'text-white shadow-sm' : 'hover:bg-white'
            }`}
            style={
              active
                ? { background: 'var(--brand-evergreen)' }
                : { color: 'var(--op-text-dim)' }
            }
          >
            {rangeLabel(key)}
          </Link>
        );
      })}
    </nav>
  );
}

/* ── notices ──────────────────────────────────────────────────────────── */

export function ErrorNote({ title, items }: { title?: ReactNode; items: ReactNode[] }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {title && <p className="font-medium">{title}</p>}
      {items.length > 0 && (
        <ul className={`list-disc pl-5 ${title ? 'mt-1' : ''}`}>
          {items.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WarnNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-md border border-dashed px-3 py-6 text-center text-sm"
      style={{ borderColor: 'var(--op-border-mid)', color: 'var(--op-text-dim)' }}
    >
      {children}
    </div>
  );
}
