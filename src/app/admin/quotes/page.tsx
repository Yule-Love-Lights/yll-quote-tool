'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { QuoteListItem } from '@/lib/quotes';

// Admin page for the `quotes` table. Mirrors /admin/renders pattern: list +
// per-row delete + bulk delete all. Used to clean up fake/test customer rows
// while we iterate on the quote form.

function getAdminSecret(): string | null {
  if (typeof window === 'undefined') return null;
  const cached = window.sessionStorage.getItem('yll:adminSecret');
  if (cached) return cached;
  const entered = window.prompt('Admin secret required for delete:');
  if (!entered) return null;
  window.sessionStorage.setItem('yll:adminSecret', entered);
  return entered;
}

function clearAdminSecret() {
  if (typeof window !== 'undefined') window.sessionStorage.removeItem('yll:adminSecret');
}

export default function QuotesAdminPage() {
  const [items, setItems] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  const adminFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const secret = getAdminSecret();
    if (!secret) throw new Error('Admin secret required');
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-admin-secret': secret },
    });
    if (res.status === 401) clearAdminSecret();
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
    const portalUrl = `${window.location.origin}/portal-snowglobe/${id}`;

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

  const removeAll = async () => {
    if (items.length === 0) return;
    const ok = confirm(`Delete ALL ${items.length} quote${items.length === 1 ? '' : 's'}? This cannot be undone.`);
    if (!ok) return;
    setBusy('ALL');
    try {
      const res = await adminFetch('/api/quotes', { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Bulk delete failed');
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Bulk delete failed');
    } finally {
      setBusy(null);
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  const fmtMoney = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-widest mb-1">
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
            <Link href="/admin/renders" className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md">
              Renders
            </Link>
            {items.length > 0 && (
              <button
                disabled={busy !== null}
                onClick={removeAll}
                className="bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 font-medium text-sm px-4 py-2 rounded-md"
              >
                Delete all ({items.length})
              </button>
            )}
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

        {items.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">Created</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Address</th>
                  <th className="text-left px-3 py-2">Phone</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map(q => {
                  const status = q.customer_approved_at
                    ? { label: 'Approved', className: 'bg-green-100 text-green-700' }
                    : q.quote_sent_at
                      ? { label: 'Sent', className: 'bg-blue-100 text-blue-700' }
                      : null;
                  return (
                    <tr key={q.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDate(q.created_at)}</td>
                      <td className="px-3 py-2 text-gray-700">
                        <div className="flex items-center gap-2">
                          <span>{q.customer_name ?? '—'}</span>
                          {status && (
                            <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${status.className}`}>
                              {status.label}
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
                          href={`/portal-snowglobe/${q.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-700 hover:bg-gray-100 text-xs px-2 py-1 rounded mr-1"
                        >
                          Portal ↗
                        </Link>
                        <Link
                          href={`/admin/quotes/${q.id}/video`}
                          className="text-gray-700 hover:bg-gray-100 text-xs px-2 py-1 rounded mr-1"
                        >
                          Video
                        </Link>
                        <button
                          disabled={busy === q.id || busy === 'ALL' || !!q.customer_approved_at}
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
                          disabled={busy === q.id || busy === 'ALL'}
                          onClick={() => remove(q.id)}
                          className="text-red-600 hover:bg-red-50 disabled:opacity-50 text-xs px-2 py-1 rounded"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
