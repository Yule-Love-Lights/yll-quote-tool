'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import type { JobAdminCard } from '@/lib/jobs';
import { JOB_STATUSES, type JobStatus } from '@/lib/jobStatus';
import { JobStatusBadge, JOB_STATUS_LABELS } from '@/components/admin/JobStatusBadge';

// Operator BILLING list of jobs (ledger #83). A job is auto-created when a quote
// is booked (deposit paid) and flows to_schedule → installed → requires_invoicing
// → done. This is the billing view; the /inventory/jobs Kanban is the separate
// materials-fulfillment view of the same rows. Test jobs (#93) are VISIBLE here,
// badged.

export default function JobsAdminPage() {
  const [items, setItems] = useState<JobAdminCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'All' | JobStatus>('All');
  const [search, setSearch] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      // The operator session cookie rides this same-origin fetch; a 401 (only
      // possible once the gate is live) bounces to /login.
      const res = await fetch('/api/jobs');
      if (res.status === 401) {
        window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setItems(data.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Defer the loading-state update out of the synchronous effect body
    // (react-hooks/set-state-in-effect is at error in this repo).
    queueMicrotask(refresh);
  }, []);

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  const fmtInstall = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  const term = search.trim().toLowerCase();
  const visible = items.filter((j) => {
    if (statusFilter !== 'All' && j.status !== statusFilter) return false;
    if (!term) return true;
    return [j.customerName, j.customerAddress, j.quoteId, j.jobNumber != null ? `#${j.jobNumber}` : null]
      .some((v) => v != null && String(v).toLowerCase().includes(term));
  });

  return (
    <OperatorShell active="quotes">
      <div className="max-w-6xl mx-auto">
        <BillingSubNav active="jobs" />

        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Yule Love Lights — Admin
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Jobs</h1>
            <p className="text-sm text-gray-500 mt-1">
              Booked jobs, from deposit paid through install and invoicing. Click a job for its detail + to mark it complete.
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">{error}</div>
        )}

        {loading && <p className="text-sm text-gray-500">Loading…</p>}

        {!loading && items.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No jobs yet — a job appears here once a customer pays their deposit.</p>
          </div>
        )}

        {!loading && items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap gap-1">
              {(['All', ...JOB_STATUSES] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
                    statusFilter === s
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {s === 'All' ? 'All' : JOB_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, address, job #…"
              className="flex-1 min-w-[12rem] text-sm border border-gray-300 rounded-md px-3 py-1.5"
            />
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {visible.length} of {items.length}
            </span>
          </div>
        )}

        {items.length > 0 && visible.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No jobs match this filter.</p>
          </div>
        )}

        {visible.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">Created</th>
                  <th className="text-left px-3 py-2">Job</th>
                  <th className="text-left px-3 py-2">Customer</th>
                  <th className="text-left px-3 py-2">Address</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Items</th>
                  <th className="text-left px-3 py-2">Install</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((j) => (
                  <tr key={j.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDate(j.createdAt)}</td>
                    <td className="px-3 py-2 text-xs font-mono text-gray-500 whitespace-nowrap" title={`Job ID: ${j.id}`}>
                      {j.jobNumber != null ? `#${j.jobNumber}` : j.id.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      <div className="flex items-center gap-2">
                        <span>{j.customerName ?? '—'}</span>
                        {j.isTest && (
                          <span
                            title="Simulated test job — excluded from dashboard metrics"
                            className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700"
                          >
                            Test
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-500 truncate max-w-[14rem]">{j.customerAddress ?? '—'}</td>
                    <td className="px-3 py-2">
                      <JobStatusBadge status={j.status} />
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">{j.itemCount}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtInstall(j.installDate)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Link href={`/admin/jobs/${j.id}`} className="text-gray-700 hover:bg-gray-100 text-xs px-2 py-1 rounded mr-1">
                        Detail
                      </Link>
                      {j.quoteId && (
                        <Link href={`/quote/${j.quoteId}`} className="text-gray-700 hover:bg-gray-100 text-xs px-2 py-1 rounded">
                          Quote
                        </Link>
                      )}
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
