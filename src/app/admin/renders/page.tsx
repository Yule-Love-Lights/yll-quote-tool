'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RenderListItem, StoredRender } from '@/lib/rendering/types';

// Internal-first approval gallery. Jason/Naldo see all renders here, open
// one, and approve or reject. Approved renders become visible on the
// customer proposal URL (Phase 5). Rejected ones stay in the gallery but
// won't show to customers.

type RenderDetail = {
  render: StoredRender;
  urls: Record<'source' | 'composite' | 'mask' | 'final', string | null>;
};

export default function RendersAdminPage() {
  const [items, setItems] = useState<RenderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RenderDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/renders');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const expand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/renders/${id}`);
      const data = await res.json();
      if (res.ok) setDetail(data as RenderDetail);
    } finally {
      setLoadingDetail(false);
    }
  };

  const approve = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/renders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', approver: 'naldo' }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Approve failed');
      await refresh();
      if (expandedId === id) await expand(id); // refresh detail
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setBusy(null);
    }
  };

  const reject = async (id: string) => {
    const reason = prompt('Reason for rejection?') ?? '';
    if (!reason.trim()) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/renders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', reason }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Reject failed');
      await refresh();
      if (expandedId === id) await expand(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this render and all its artifacts? This cannot be undone.')) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/renders/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      if (expandedId === id) { setExpandedId(null); setDetail(null); }
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-widest mb-1">
              Yule Love Lights — Admin
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Render Gallery</h1>
            <p className="text-sm text-gray-500 mt-1">
              Photoreal nighttime renders for proposals. Approve to make the render visible on the customer URL. Reject to kick it back.
              <span className="text-xs text-amber-600 ml-2">Artist&rsquo;s rendering — actual install may vary.</span>
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/" className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md">
              ← Home
            </Link>
            <Link href="/admin/renders/new" className="bg-green-600 hover:bg-green-700 text-white font-medium text-sm px-4 py-2 rounded-md">
              + New Render
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
            <p className="text-gray-500 mb-2">No renders yet.</p>
            <p className="text-xs text-gray-400">
              Renders are created by posting to <code>/api/renders</code> with a photo and vision data, or via the quote page (Phase 5 wiring).
            </p>
          </div>
        )}

        <div className="space-y-2">
          {items.map(r => {
            const isOpen = expandedId === r.id;
            return (
              <div key={r.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => expand(r.id)}
                  className="w-full text-left p-3 hover:bg-gray-50 flex items-center justify-between gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span>{fmtDate(r.created_at)}</span>
                      <StatusPill status={r.status} />
                      <span className="text-gray-400">v{r.version}</span>
                      <span className="text-gray-400">· {r.style}</span>
                    </div>
                    <div className="text-sm text-gray-700 mt-0.5 truncate">
                      {r.quote_id ? `Quote ${r.quote_id.slice(0, 8)}…` : 'No linked quote'}
                      {r.notes && <span className="text-gray-500"> — {r.notes}</span>}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5 flex gap-3">
                      {r.gemini_cost_usd != null && <span>${r.gemini_cost_usd.toFixed(2)}</span>}
                      {r.ssim_score != null && <span>SSIM {r.ssim_score.toFixed(3)}</span>}
                      {r.approved_at && <span>approved {fmtDate(r.approved_at)}</span>}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <span className="text-xs text-blue-600">{isOpen ? '▼ Hide' : '▶ View'}</span>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-200 p-3 bg-gray-50">
                    {loadingDetail && <p className="text-xs text-gray-500">Loading artifacts…</p>}
                    {detail && detail.render.id === r.id && (
                      <div>
                        {detail.render.status === 'failed' && detail.render.error_message && (
                          <div className="mb-3 bg-red-50 border border-red-200 rounded-md p-2 text-xs text-red-700">
                            <strong>Failed:</strong> {detail.render.error_message}
                          </div>
                        )}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <Artifact label="Source" url={detail.urls.source} />
                          <Artifact label="Composite" url={detail.urls.composite} />
                          <Artifact label="Mask" url={detail.urls.mask} />
                          <Artifact label="Final" url={detail.urls.final} highlight />
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2 justify-end">
                          {detail.render.status === 'ready' && (
                            <>
                              <button
                                disabled={busy === r.id}
                                onClick={() => approve(r.id)}
                                className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium text-sm px-4 py-1.5 rounded-md"
                              >
                                Approve
                              </button>
                              <button
                                disabled={busy === r.id}
                                onClick={() => reject(r.id)}
                                className="bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium text-sm px-4 py-1.5 rounded-md"
                              >
                                Reject
                              </button>
                            </>
                          )}
                          <button
                            disabled={busy === r.id}
                            onClick={() => remove(r.id)}
                            className="text-red-600 hover:bg-red-50 disabled:opacity-50 text-sm px-3 py-1.5 rounded-md"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: StoredRender['status'] }) {
  const styles: Record<StoredRender['status'], string> = {
    pending: 'bg-gray-100 text-gray-700 border-gray-300',
    rendering: 'bg-blue-50 text-blue-700 border-blue-200',
    ready: 'bg-amber-50 text-amber-800 border-amber-200',
    approved: 'bg-green-50 text-green-700 border-green-200',
    rejected: 'bg-gray-100 text-gray-500 border-gray-300',
    failed: 'bg-red-50 text-red-700 border-red-200',
  };
  return (
    <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border ${styles[status]}`}>
      {status}
    </span>
  );
}

function Artifact({ label, url, highlight }: { label: string; url: string | null; highlight?: boolean }) {
  return (
    <div>
      <div className={`text-xs font-semibold mb-1 ${highlight ? 'text-green-700' : 'text-gray-600'}`}>{label}</div>
      {url ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={label} className={`w-full rounded border ${highlight ? 'border-green-400' : 'border-gray-300'} hover:opacity-90 cursor-zoom-in`} />
        </a>
      ) : (
        <div className="w-full aspect-video bg-gray-100 border border-dashed border-gray-300 rounded flex items-center justify-center text-xs text-gray-400">
          not available
        </div>
      )}
    </div>
  );
}
