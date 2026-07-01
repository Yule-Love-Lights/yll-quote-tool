'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { QuoteListItem } from '@/lib/quotes';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { PipelineActionsMenu } from '@/components/admin/PipelineActionsMenu';

// Admin page for the `quotes` table: list + per-row delete + bulk delete
// all. Used to clean up fake/test customer rows while we iterate on the
// quote form.

// The lifecycle status of a row. Now sourced from the canonical model
// (src/lib/quoteStatus.ts, ledger #83): deriveStatus prefers the persisted
// `status` column for states timestamps can't express (declined /
// changes_requested / cancelled / lost) and otherwise computes the latest state
// from the lifecycle timestamps — so the same row reads identically here, on the
// dashboard Workflow board, and in the data layer. Supersedes the old local
// Draft/Sent/Viewed/Approved derivation (audit Finding #40).
function rowStatus(q: QuoteListItem): QuoteStatus {
  return deriveStatus(q);
}

// Display label + badge style per canonical status. Title-cased for the UI.
const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  approved: 'Approved',
  booked: 'Booked',
  changes_requested: 'Changes',
  declined: 'Declined',
  cancelled: 'Cancelled',
  lost: 'Lost',
};

const STATUS_STYLES: Record<QuoteStatus, string> = {
  booked: 'bg-emerald-100 text-emerald-700',
  approved: 'bg-green-100 text-green-700',
  viewed: 'bg-purple-100 text-purple-700',
  sent: 'bg-blue-100 text-blue-700',
  draft: 'bg-amber-100 text-amber-700',
  changes_requested: 'bg-orange-100 text-orange-700',
  declined: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
  lost: 'bg-gray-200 text-gray-600',
};

// The statuses offered as filter chips. Ordered along the lifecycle; the two
// portal branch states (Changes/Declined) sit at the end.
const FILTER_STATUSES: QuoteStatus[] = [
  'draft',
  'sent',
  'viewed',
  'approved',
  'booked',
  'changes_requested',
  'declined',
];

export default function QuotesAdminPage() {
  const [items, setItems] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Audit fix (Finding #40): client-side status filter + text search over the
  // already-loaded list so "what is still un-sent" is answerable at a glance.
  const [statusFilter, setStatusFilter] = useState<'All' | QuoteStatus>('All');
  const [search, setSearch] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/quotes');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Kick off the initial load in a microtask so refresh()'s loading-state
    // update isn't dispatched synchronously within the effect. Microtasks flush
    // before paint, so there's no visible flash.
    queueMicrotask(refresh);
  }, []);

  // The operator session (httpOnly cookie set at /login) rides every same-origin
  // request automatically — no client-held secret, no prompt. A 401 means the
  // session lapsed (only possible once the auth gate is live); bounce to /login.
  const adminFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const res = await fetch(url, init);
    if (res.status === 401) {
      window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
    }
    return res;
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this quote? This cannot be undone.')) return;
    setBusy(id);
    try {
      const res = await adminFetch(`/api/quotes/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  // "Send to customer" — copies the portal URL to clipboard + stamps
  // quote_sent_at + advances the HighLevel pipeline card to "Bid Sent".
  // Naldo then pastes the URL into iMessage / email / wherever.
  const sendToCustomer = async (id: string) => {
    const portalUrl = `${window.location.origin}/portal/${id}`;

    // Copy first — if Zapier is down we still want Naldo to have the URL.
    let copied = false;
    try {
      await navigator.clipboard.writeText(portalUrl);
      copied = true;
    } catch {
      // Some browsers block clipboard outside HTTPS — fall through.
    }

    setBusy(id);
    try {
      const res = await fetch(`/api/quotes/${id}/send`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Send failed');
      const stage = data.stageUpdated
        ? '\nHighLevel: card moved to Bid Sent.'
        : data.stageError
          ? `\nHighLevel: ${data.stageError}`
          : '';
      const already = data.alreadySent ? ' (already sent earlier)' : '';
      alert(
        `Portal URL${copied ? ' copied to clipboard' : ''}${already}:\n\n${portalUrl}${stage}`,
      );
      await refresh();
    } catch (err) {
      alert(
        `${err instanceof Error ? err.message : 'Send failed'}\n\n` +
          `Portal URL${copied ? ' (copied)' : ''}: ${portalUrl}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  const fmtMoney = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  // Audit fix (Finding #40): apply the status filter + text search client-side.
  // Search matches name / address / phone / email / quote-id prefix.
  const term = search.trim().toLowerCase();
  const visible = items.filter(q => {
    if (statusFilter !== 'All' && rowStatus(q) !== statusFilter) return false;
    if (!term) return true;
    return [q.customer_name, q.customer_address, q.customer_phone, q.customer_email, q.id]
      .some(v => v != null && v.toLowerCase().includes(term));
  });

  return (
    <OperatorShell active="quotes">
      <div className="max-w-6xl mx-auto">
        <BillingSubNav active="quotes" />
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Yule Love Lights — Admin
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Quotes</h1>
            <p className="text-sm text-gray-500 mt-1">
              Every quote saved from the quote tool. Delete test rows here to keep the database clean while iterating.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/" className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md">
              ← Home
            </Link>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}

        {loading && <p className="text-sm text-gray-500">Loading…</p>}

        {!loading && items.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No quotes yet.</p>
          </div>
        )}

        {/* Audit fix (Finding #40): status filter + text search so un-sent
            (Draft) quotes are legible at a glance. */}
        {!loading && items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap gap-1">
              {(['All', ...FILTER_STATUSES] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
                    statusFilter === s
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {s === 'All' ? 'All' : STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, address, phone, email, ID…"
              className="flex-1 min-w-[12rem] text-sm border border-gray-300 rounded-md px-3 py-1.5"
            />
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {visible.length} of {items.length}
            </span>
          </div>
        )}

        {/* overflow-x-auto (NOT hidden): the actions column outgrew the
            viewport — Edit/Portal/Send/Delete — and overflow-hidden was
            CLIPPING Delete off-screen with no way to reach it (#30). */}
        {items.length > 0 && visible.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No quotes match this filter.</p>
          </div>
        )}

        {visible.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">Created</th>
                  <th className="text-left px-3 py-2">Quote</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Address</th>
                  <th className="text-left px-3 py-2">Phone</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(q => {
                  // Lifecycle badge from the canonical status model (#83):
                  // persisted `status` for the branch states (Declined/Changes),
                  // else the latest timestamp-derived state (Booked > Approved >
                  // Viewed > Sent > Draft). "Viewed" (#68) tooltip shows the open
                  // count + last-open time; "Declined" shows the customer reason.
                  const code = rowStatus(q);
                  const status = { code, label: STATUS_LABELS[code], className: STATUS_STYLES[code] };
                  const viewedTitle = q.viewed_at
                    ? `Opened ${q.view_count ?? 1}×${q.last_viewed_at ? ` — last ${fmtDate(q.last_viewed_at)}` : ''}`
                    : undefined;
                  const badgeTitle =
                    status.code === 'viewed'
                      ? viewedTitle
                      : status.code === 'declined' && q.decline_reason
                        ? `Declined: ${q.decline_reason}`
                        : undefined;
                  return (
                    <tr key={q.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDate(q.created_at)}</td>
                      {/* Sequential display number (#83, SPEC §4.6) when allocated;
                          falls back to the truncated UUID (#77) on legacy rows. */}
                      <td className="px-3 py-2 text-xs font-mono text-gray-500 whitespace-nowrap" title={`Quote ID: ${q.id}`}>
                        {q.quote_number != null ? `#${q.quote_number}` : q.id.slice(0, 8)}
                      </td>
                      <td className="px-3 py-2 text-gray-700">
                        <div className="flex items-center gap-2">
                          <span>{q.customer_name ?? '—'}</span>
                          <span
                            title={badgeTitle}
                            className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${status.className}`}
                          >
                            {status.label}
                          </span>
                          {/* Test Quote (ledger #93) — kept VISIBLE in the admin
                              list (only the dashboard metrics exclude it), badged
                              so it's never mistaken for real data. */}
                          {q.is_test && (
                            <span
                              title="Simulated test quote — excluded from dashboard metrics"
                              className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700"
                            >
                              Test
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-gray-500 truncate max-w-[14rem]">{q.customer_address ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{q.customer_phone ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-500 truncate max-w-[12rem]">{q.customer_email ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">{fmtMoney(q.total)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Link
                          href={`/quote/${q.id}`}
                          className="text-gray-700 hover:bg-gray-100 text-xs px-2 py-1 rounded mr-1"
                        >
                          Edit
                        </Link>
                        <Link
                          href={`/portal/${q.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-700 hover:bg-gray-100 text-xs px-2 py-1 rounded mr-1"
                        >
                          Portal ↗
                        </Link>
                        <button
                          disabled={busy === q.id || !!q.customer_approved_at}
                          onClick={() => sendToCustomer(q.id)}
                          title={
                            q.customer_approved_at
                              ? 'Already approved — cannot resend'
                              : q.quote_sent_at
                                ? 'Already sent — clicking copies the URL again'
                                : 'Copy portal URL and mark as sent'
                          }
                          className="text-blue-700 hover:bg-blue-50 disabled:opacity-50 text-xs px-2 py-1 rounded mr-1"
                        >
                          {q.quote_sent_at ? 'Resend' : 'Send'}
                        </button>
                        <button
                          disabled={busy === q.id}
                          onClick={() => remove(q.id)}
                          className="text-red-600 hover:bg-red-50 disabled:opacity-50 text-xs px-2 py-1 rounded mr-1"
                        >
                          Delete
                        </button>
                        <PipelineActionsMenu quoteId={q.id} onDone={refresh} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
