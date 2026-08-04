'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { leadServiceToQuoteServiceType } from './leadServiceVocab';

// Operator view of the website lead-capture rows (#leads). Every WordPress form
// submission is saved to website_leads FIRST (source of truth), then synced to
// the right GHL pipeline. This page is the GHL-outage RECOVERY surface: it shows
// which leads are stuck ('pending'/'deferred') or gave up ('failed'), and lets an
// operator re-drive one by hand (the cron worker /api/leads/retry drains them
// automatically; this is the manual lever). Reachable at /admin/leads.
//
// Client component split off from page.tsx (a thin server component) so the
// HighLevel link can use HIGHLEVEL_LOCATION_ID — a server-only env var (no
// NEXT_PUBLIC_ prefix) that a 'use client' file can't read directly.

type Lead = {
  id: string;
  created_at: string;
  service: string;
  form_variant: string;
  name: string;
  email: string;
  phone: string;
  address: string | null;
  notes: string | null;
  sync_status: string;
  sync_error: string | null;
  retry_count: number;
  last_retried_at: string | null;
  ghl_contact_id: string | null;
  ghl_opportunity_id: string | null;
  is_test: boolean;
};

// UI filter label → the set of sync_status values it shows. 'Stuck' is the
// most actionable view (still needs a human or a retry); the rest are exact.
// The page itself opens on 'All' (see the `filter` useState below) so a fresh
// operator sees every lead, not just the recovery queue.
const FILTERS: Array<{ label: string; statuses: string[] | null }> = [
  { label: 'Stuck', statuses: ['pending', 'deferred', 'failed'] },
  { label: 'Pending', statuses: ['pending'] },
  { label: 'Deferred', statuses: ['deferred'] },
  { label: 'Failed', statuses: ['failed'] },
  { label: 'Synced', statuses: ['synced'] },
  // Abandoned-form leads (quote-forms-partial-save): captured WITHOUT SMS
  // consent, so they're never drip-synced — follow up by hand (call, or invite
  // them to complete the form). No Retry button (see RETRIABLE below).
  { label: 'Partial', statuses: ['partial'] },
  { label: 'Rate limited', statuses: ['rate_limited'] },
  { label: 'Spam', statuses: ['spam'] },
  { label: 'All', statuses: null },
];

// Which statuses an operator can manually re-drive. synced is done; spam never
// syncs — no retry button for those.
const RETRIABLE = new Set(['pending', 'deferred', 'failed', 'rate_limited']);

const STATUS_STYLE: Record<string, string> = {
  synced: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-700',
  deferred: 'bg-blue-100 text-blue-700',
  failed: 'bg-red-100 text-red-700',
  partial: 'bg-indigo-100 text-indigo-700',
  rate_limited: 'bg-orange-100 text-orange-700',
  spam: 'bg-gray-100 text-gray-500',
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLE[status] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${cls}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

// "Create quote" link (#leads → quote builder prefill): carries the lead's
// details as query params for QuoteBuilder's `prefill` prop (src/lib/quoteForm.ts
// applyPrefill) to seed the blank builder's initial state. Only non-empty
// fields are sent; an unrecognized/legacy lead.service is simply omitted
// (QuoteBuilder validates serviceType itself and ignores anything invalid).
// ghlContactId (operator feedback): when the lead already has a HighLevel
// contact, carry its id through so the quote saves LINKED to that contact from
// birth (quotes.highlevel_contact_id) instead of the operator having to
// re-pick the same contact by hand in the builder's HL autocomplete.
function quoteNewHref(lead: Lead): string {
  const params = new URLSearchParams();
  if (lead.name) params.set('name', lead.name);
  if (lead.email) params.set('email', lead.email);
  if (lead.phone) params.set('phone', lead.phone);
  if (lead.address) params.set('address', lead.address);
  const serviceType = leadServiceToQuoteServiceType(lead.service);
  if (serviceType) params.set('serviceType', serviceType);
  if (lead.ghl_contact_id) params.set('ghlContactId', lead.ghl_contact_id);
  const qs = params.toString();
  return qs ? `/quote/new?${qs}` : '/quote/new';
}

// HighLevel contact URL pattern — reused verbatim from the "View in HighLevel"
// button on the customer detail page (src/app/customers/[contactId]/page.tsx
// highLevelContactUrl). Not imported directly: that helper is private to a
// server component that also needs the raw env var; this client component only
// ever has the already-resolved locationId (passed down from page.tsx).
function highLevelContactUrl(locationId: string, contactId: string): string {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${encodeURIComponent(contactId)}`;
}

export default function LeadsAdminClient({ hlLocationId }: { hlLocationId: string | null }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('All');
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // The operator session cookie rides this same-origin fetch; a 401 (only
      // possible once the gate is live) bounces to /login.
      const res = await fetch('/api/admin/leads?status=all');
      if (res.status === 401) {
        window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load leads');
      setLeads(data.leads ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leads');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Defer the loading-state update out of the synchronous effect body
    // (react-hooks/set-state-in-effect is at error in this repo).
    queueMicrotask(load);
  }, []);

  const retry = async (id: string) => {
    setRetryingId(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/leads/${id}/retry`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Retry failed');
      setNotice(`Lead ${id.slice(0, 8)} re-driven → ${data.outcome}`);
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetryingId(null);
    }
  };

  const activeFilter = FILTERS.find((f) => f.label === filter) ?? FILTERS[0]!;
  const visible = activeFilter.statuses
    ? leads.filter((l) => activeFilter.statuses!.includes(l.sync_status))
    : leads;

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : '—';

  return (
    <OperatorShell active="leads">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights — Admin
          </p>
          <h1 className="text-2xl font-bold text-gray-900">Website leads</h1>
          <p className="text-sm text-gray-500 mt-1">
            Every website quote-request form saves here first, then syncs to GHL. Rows stuck{' '}
            <b>pending</b>/<b>deferred</b> (or <b>failed</b> after the auto-retries gave up) can be
            re-driven by hand below — the background worker retries them automatically every 10 min.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">{error}</div>
        )}
        {notice && (
          <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-700 mb-4">{notice}</div>
        )}

        {loading && <p className="text-sm text-gray-500">Loading…</p>}

        {!loading && (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => {
                const count = f.statuses
                  ? leads.filter((l) => f.statuses!.includes(l.sync_status)).length
                  : leads.length;
                return (
                  <button
                    key={f.label}
                    onClick={() => setFilter(f.label)}
                    className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
                      filter === f.label
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {f.label} ({count})
                  </button>
                );
              })}
            </div>
            <button
              onClick={load}
              className="text-xs font-medium px-2.5 py-1 rounded-md border bg-white text-gray-600 border-gray-300 hover:bg-gray-50 ml-auto"
            >
              Refresh
            </button>
          </div>
        )}

        {!loading && visible.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No leads with this status.</p>
          </div>
        )}

        {!loading && visible.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">Created</th>
                  <th className="text-left px-3 py-2">Service</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Contact</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Tries</th>
                  <th className="text-left px-3 py-2">Last try</th>
                  <th className="text-left px-3 py-2">Error</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr key={l.id} className="border-t border-gray-100 hover:bg-gray-50 align-top">
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{fmt(l.created_at)}</td>
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{l.service}</td>
                    <td className="px-3 py-2 text-gray-700">
                      <div className="flex items-center gap-2">
                        <span>{l.name || '—'}</span>
                        {l.is_test && (
                          <span
                            title="Test submission — excluded from real-lead reporting"
                            className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700"
                          >
                            Test
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-500 text-xs">
                      <div>{l.email}</div>
                      <div>{l.phone}</div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={l.sync_status} />
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">{l.retry_count}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmt(l.last_retried_at)}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs max-w-[18rem]">
                      <span title={l.sync_error ?? ''} className="line-clamp-2">
                        {l.sync_error ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link
                          href={quoteNewHref(l)}
                          className="text-xs px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100"
                        >
                          Create quote
                        </Link>
                        {l.ghl_contact_id && hlLocationId && (
                          <a
                            href={highLevelContactUrl(hlLocationId, l.ghl_contact_id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100"
                          >
                            HighLevel
                          </a>
                        )}
                        {RETRIABLE.has(l.sync_status) && (
                          <button
                            onClick={() => retry(l.id)}
                            disabled={retryingId === l.id}
                            className="text-xs px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                          >
                            {retryingId === l.id ? 'Retrying…' : 'Retry'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
