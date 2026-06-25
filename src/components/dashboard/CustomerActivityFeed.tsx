import Link from 'next/link';
import type { ActivityEvent, ActivityKind } from '@/lib/dashboard/activity';

// One combined activity timeline for a customer (view history + lifecycle).
// Server component — purely presentational over the pre-built event list.

const PILL: Record<ActivityKind, { label: string; cls: string }> = {
  created: { label: 'Created', cls: 'bg-gray-100 text-gray-600' },
  sent: { label: 'Sent', cls: 'bg-blue-100 text-blue-700' },
  viewed: { label: 'Viewed', cls: 'bg-green-100 text-green-700' },
  approved: { label: 'Approved', cls: 'bg-emerald-600 text-white' },
};

// This is a server component, so toLocaleString runs on the server (UTC on
// Vercel). Pin to Eastern (Long Island) + an "ET" marker so staff see the real
// local open time, not a UTC time misread as local.
function fmtDateTime(iso: string): string {
  return (
    new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    }) + ' ET'
  );
}

export function CustomerActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <section
      className="rounded-lg border mt-6"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
          Activity
        </h2>
        <p className="text-xs mt-0.5" style={{ color: 'var(--op-text-dim)' }}>
          Every time this customer opened a quote, plus when each quote was created, sent, and approved.
        </p>
      </div>
      {events.length === 0 ? (
        <div className="p-6 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>
          No activity yet.
        </div>
      ) : (
        <ul>
          {events.map((e, i) => {
            const pill = PILL[e.kind];
            return (
              <li
                key={`${e.quoteId}-${e.kind}-${e.at}-${i}`}
                className="flex items-center gap-3 px-4 py-2.5 border-t"
                style={{ borderColor: 'var(--op-border)' }}
              >
                <span className={`shrink-0 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded ${pill.cls}`}>
                  {pill.label}
                </span>
                <Link
                  href={`/quote/${e.quoteId}`}
                  className="text-xs font-mono hover:underline"
                  style={{ color: 'var(--op-primary)' }}
                >
                  Quote {e.quoteId.slice(0, 8)}
                </Link>
                <span className="ml-auto text-xs whitespace-nowrap" style={{ color: 'var(--op-text-dim)' }}>
                  {fmtDateTime(e.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
