'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { QuoteListItem } from '@/lib/quotes';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { deriveStatus, APPROVED_DISPLAYS_AS, statusMatchesFilter, type QuoteStatus } from '@/lib/quoteStatus';
import { PipelineActionsMenu } from '@/components/admin/PipelineActionsMenu';
import { YllNeighborBadge } from '@/components/admin/YllNeighborBadge';
import { NceBadge } from '@/components/admin/NceBadge';
import { DepositRateChip } from '@/components/admin/DepositRateChip';
import { SERVICE_TYPE_LABELS, SERVICE_TYPES, DEFAULT_SERVICE_TYPE, type ServiceType } from '@/lib/serviceType';
import { ServiceTypeBadge } from '@/components/admin/ServiceTypeBadge';
import { QuotesListSkeleton } from './QuotesListSkeleton';

// Admin page for the `quotes` table: list + per-row delete + bulk delete
// all. Used to clean up fake/test customer rows while we iterate on the
// quote form.

// The lifecycle status of a row. Now sourced from the canonical model
// (src/lib/quoteStatus.ts, ledger #83): deriveStatus prefers the persisted
// `status` column for states timestamps can't express (declined /
// changes_requested / cancelled / abandoned) and otherwise computes the latest state
// from the lifecycle timestamps — so the same row reads identically here, on the
// dashboard Workflow board, and in the data layer. Supersedes the old local
// Draft/Sent/Viewed/Approved derivation (audit Finding #40).
function rowStatus(q: QuoteListItem): QuoteStatus {
  return deriveStatus(q);
}

// Display label + badge style per canonical status. Title-cased for the UI.
// Row 242 (Jason's ruling — no third stage): 'approved' reads + colors
// IDENTICALLY to 'sent' (APPROVED_DISPLAYS_AS === 'Sent') — see quoteStatus.ts
// for the rationale. deriveStatus/canTransition/money guards are unaffected;
// this is presentation only. The row-below badge for an approved-derived
// quote still reads this map directly (STATUS_LABELS[code]/STATUS_STYLES[code]
// with code='approved'), so both entries must actually hold sent's values,
// not just the filter chip.
const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  approved: APPROVED_DISPLAYS_AS,
  booked: 'Booked',
  changes_requested: 'Changes',
  declined: 'Declined',
  cancelled: 'Cancelled',
  abandoned: 'Abandoned',
};

const STATUS_STYLES: Record<QuoteStatus, string> = {
  booked: 'bg-emerald-100 text-emerald-700',
  // Row 242: no distinct color for approved — takes sent's exact style.
  approved: 'bg-blue-100 text-blue-700',
  viewed: 'bg-purple-100 text-purple-700',
  sent: 'bg-blue-100 text-blue-700',
  draft: 'bg-amber-100 text-amber-700',
  changes_requested: 'bg-orange-100 text-orange-700',
  declined: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
  abandoned: 'bg-gray-200 text-gray-600',
};

// The statuses offered as filter chips. Ordered along the lifecycle; the
// portal branch states (Changes/Declined) and the staff-only terminal state
// (Abandoned, #235's "Mark abandoned" action) sit at the end. `cancelled` is
// deliberately NOT offered here — prod has zero cancelled quotes ever.
// Row 242: `approved` is ALSO deliberately not offered here — no separate
// Approved chip. Unlike cancelled (which is simply invisible to every filter
// except "All"), an approved-unpaid quote must still show up under the Sent
// chip — statusMatchesFilter (quoteStatus.ts) folds it in below, so dropping
// this entry doesn't orphan those quotes from filtering entirely.
const FILTER_STATUSES: QuoteStatus[] = [
  'draft',
  'sent',
  'viewed',
  'booked',
  'changes_requested',
  'declined',
  'abandoned',
];

export default function QuotesAdminPage() {
  const [items, setItems] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Audit fix (Finding #40): client-side status filter + text search over the
  // already-loaded list so "what is still un-sent" is answerable at a glance.
  const [statusFilter, setStatusFilter] = useState<'All' | QuoteStatus>('All');
  // Second chip row (this task): filter by service-line type, composing with
  // statusFilter + search as AND conditions.
  const [serviceFilter, setServiceFilter] = useState<'All' | ServiceType>('All');
  // Test-only toggle (this task): narrows to is_test rows; AND's with every
  // other filter. Kept separate from serviceFilter (a radio) rather than as a
  // fourth service-type option, since "permanent AND test" must stay
  // expressible — a radio would make Test mutually exclusive with the real
  // service types. Off by default: test quotes stay visible either way (see
  // listQuotes()'s "intentionally keeps test quotes VISIBLE" comment) — this
  // only narrows TO them, it never hides them.
  const [testOnly, setTestOnly] = useState(false);
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
      window.location.assign(`/login?from=${encodeURIComponent(window.location.pathname)}`);
    }
    return res;
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this quote? This cannot be undone.')) return;
    setBusy(id);
    try {
      const res = await adminFetch(`/api/quotes/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // PS-G3: the API blocks deleting a booked/approved quote with a 428 that
        // tells a developer which header would force it through. An operator
        // should never see that raw instruction — translate it to plain English.
        if (res.status === 428 && body.code === 'confirm-required') {
          throw new Error(
            'This quote is booked — cancel its job/invoice first, or contact the owner to force-delete.',
          );
        }
        throw new Error(body.error ?? 'Delete failed');
      }
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  const fmtMoney = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  // Audit fix (Finding #40): apply the status filter + text search client-side.
  // Search matches name / address / phone / email / quote-id prefix.
  // Row 242: statusMatchesFilter (not a raw ===) so the Sent chip also
  // catches a derived-'approved' row now that Approved has no chip of its
  // own — see FILTER_STATUSES's comment above.
  const term = search.trim().toLowerCase();
  const visible = items.filter(q => {
    if (statusFilter !== 'All' && !statusMatchesFilter(rowStatus(q), statusFilter)) return false;
    if (serviceFilter !== 'All' && (q.service_type ?? DEFAULT_SERVICE_TYPE) !== serviceFilter) return false;
    if (testOnly && !q.is_test) return false;
    if (!term) return true;
    // Device check 2026-08-26: typing the "#1262" the list itself displays
    // found nothing — the haystack had the UUID but not the quote number. Same
    // `#${n}` idiom as the jobs and invoices lists, so "#1262" and "1262" both
    // match.
    return [
      q.customer_name,
      q.customer_address,
      q.customer_phone,
      q.customer_email,
      q.id,
      q.quote_number != null ? `#${q.quote_number}` : null,
    ].some(v => v != null && v.toLowerCase().includes(term));
  });

  return (
    <OperatorShell active="quotes">
      <div className="max-w-none mx-auto">
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

        {/* Same rich skeleton the route's loading.tsx shows (#171b) — was a
            bare "Loading…" line, which made the route-transition skeleton
            morph into something sparser before morphing again into the real
            table once the client-side GET /api/quotes fetch resolved. */}
        {loading && <QuotesListSkeleton />}

        {!loading && items.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No quotes yet.</p>
          </div>
        )}

        {/* Audit fix (Finding #40): status filter + text search so un-sent
            (Draft) quotes are legible at a glance. Two separate labeled rows
            (this task, per operator device-check feedback on #666 — stage and
            service-type sat side by side and read as one confusing group):
            stage (the status lifecycle) first, service line underneath. Label
            style matches this section's existing muted-heading idiom (see the
            detail page's "Customer" / "Lifecycle" headings). */}
        {!loading && items.length > 0 && (
          <div className="mb-3">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Stage</span>
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
            </div>
            {/* Service-type chip row — filters by service line, composing with
                the status chips + search as AND conditions. */}
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Service</span>
              <div className="flex flex-wrap gap-1">
                {(['All', ...SERVICE_TYPES] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setServiceFilter(s)}
                    className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
                      serviceFilter === s
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {s === 'All' ? 'All' : SERVICE_TYPE_LABELS[s]}
                  </button>
                ))}
                {/* Test-only toggle: a separate boolean, not a service-type
                    option (see the testOnly state comment above). A divider
                    + distinct color keeps it from reading as a fifth service
                    type. */}
                <span className="w-px self-stretch bg-gray-300 mx-1" aria-hidden="true" />
                <button
                  onClick={() => setTestOnly(v => !v)}
                  aria-pressed={testOnly}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
                    testOnly
                      ? 'bg-violet-600 text-white border-violet-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  Test only
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name, address, phone, email, quote #…"
                className="flex-1 min-w-[12rem] text-sm border border-gray-300 rounded-md px-3 py-1.5"
              />
              <span className="text-xs text-gray-500 whitespace-nowrap">
                {visible.length} of {items.length}
              </span>
            </div>
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
                        {/* Row 409 staff-lens LOW: this row carries the name plus
                            up to five badges; it never wrapped, and the deposit
                            chip is one more thing to push off the edge. */}
                        <div className="flex flex-wrap items-center gap-2">
                          {/* Customer-name link (this task): same routing rule as
                              src/lib/dashboard/customers.ts customerRouteId —
                              highlevel_contact_id, else customer_id. A walk-in
                              with neither stays plain text. */}
                          {(() => {
                            const routeId = q.highlevel_contact_id ?? q.customer_id;
                            return routeId ? (
                              <Link href={`/customers/${encodeURIComponent(routeId)}`} className="font-medium hover:underline" style={{ color: 'var(--op-primary)' }}>
                                {q.customer_name ?? '—'}
                              </Link>
                            ) : (
                              <span>{q.customer_name ?? '—'}</span>
                            );
                          })()}
                          {/* Service-line badge (#123) — shared chip (row 419). */}
                          <ServiceTypeBadge serviceType={q.service_type} />
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
                          {/* YLL Neighbor (#158) — migrated from last year's Jobber data (#155). */}
                          {q.legacy_rebook && <YllNeighborBadge />}
                          {/* NCE (#198) — the barter/trade network tag. Tags coexist. */}
                          {q.is_nce && <NceBadge />}
                          {/* Row 409 — the deposit rate this quote is really on,
                              beside the tag that implies one. Amber when the two
                              disagree; nothing here corrects it (Jason's ruling). */}
                          <DepositRateChip
                            isNce={q.is_nce}
                            rate={q.deposit_rate}
                            frozen={q.deposit_rate_frozen}
                          />
                          {/* View-only portal (#176) — mirrors the detail page's pill. */}
                          {q.view_only && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">
                              View-only
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
                        {/* PS-G4: Send/Resend used to live here as a second,
                            channel-less way to do what the Options menu's
                            Send (email + text) / Send email / Send text
                            already does — dropped as a duplicate. The menu
                            is now the one place to send a quote. */}
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
