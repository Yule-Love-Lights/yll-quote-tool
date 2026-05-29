'use client';

// Admin variant review grid for a single quote.
//
// Operator workflow:
//   1. Variants were already generated (via /admin/renders/new "Render all 7
//      variants" or by /api/quotes/[id]/render-variants directly).
//   2. This page fetches every variant for the quote, displays them in a
//      grid with metadata (status, model, cost), and offers per-variant
//      Approve/Reject + a single "Approve all" action.
//   3. Approved variants become visible on the customer portal.
//
// Auth: ADMIN_SECRET cached in sessionStorage (same pattern as /admin/renders).

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { use } from 'react';
import type { RenderVariant, StoredRender } from '@/lib/rendering/types';
import { PORTAL_VARIANTS } from '@/lib/rendering/types';
import { VARIANT_LABELS } from '@/lib/rendering/variants';

type VariantRender = StoredRender & {
  urls: { final: string | null; composite: string | null; source: string | null };
};

type RendersResponse = { renders: VariantRender[] };

const ALL_VARIANTS_ORDER: RenderVariant[] = ['full', ...PORTAL_VARIANTS];

function getAdminSecret(): string | null {
  if (typeof window === 'undefined') return null;
  const cached = window.sessionStorage.getItem('yll:adminSecret');
  if (cached) return cached;
  const entered = window.prompt('Admin secret required:');
  if (!entered) return null;
  window.sessionStorage.setItem('yll:adminSecret', entered);
  return entered;
}

export default function QuoteVariantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: quoteId } = use(params);
  const [renders, setRenders] = useState<VariantRender[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const secret = getAdminSecret();
      if (!secret) {
        setError('Admin secret required');
        setLoading(false);
        return;
      }
      const res = await fetch(`/api/quotes/${quoteId}/renders?include=all`, {
        headers: { 'x-admin-secret': secret },
      });
      const data = await res.json() as RendersResponse | { error: string };
      if (!res.ok) throw new Error(('error' in data && data.error) || 'Failed to load');
      setRenders((data as RendersResponse).renders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => {
    // Defer in a microtask so refresh()'s loading-state update isn't dispatched
    // synchronously within the effect (microtasks flush before paint).
    queueMicrotask(refresh);
  }, [refresh]);

  const approveAll = async () => {
    const secret = getAdminSecret();
    if (!secret) return;
    setBusy('approveAll');
    try {
      const res = await fetch(`/api/quotes/${quoteId}/renders`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': secret,
        },
        body: JSON.stringify({ action: 'approve-all', approver: 'naldo' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const setRenderStatus = async (renderId: string, action: 'approve' | 'reject') => {
    const secret = getAdminSecret();
    if (!secret) return;
    setBusy(renderId);
    try {
      const reason = action === 'reject' ? (window.prompt('Reject reason?') ?? 'no reason') : undefined;
      const res = await fetch(`/api/renders/${renderId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': secret,
        },
        body: JSON.stringify({ action, approver: 'naldo', reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  // Fill in a "missing" placeholder for variants that don't have a row yet.
  // Lets the operator see at a glance "we have full + santas + ridge but
  // wreaths/spritzers haven't been generated."
  const byVariant = new Map<RenderVariant, VariantRender>();
  for (const r of renders) byVariant.set(r.variant, r);

  const totalApproved = renders.filter(r => r.status === 'approved').length;
  const totalReady = renders.filter(r => r.status === 'ready').length;
  const totalCost = renders.reduce((s, r) => s + (r.gemini_cost_usd ?? 0), 0);

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-start mb-6">
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-widest mb-1">
              Yule Love Lights — Admin
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Variant Renders</h1>
            <p className="text-sm text-gray-500 mt-1 font-mono">
              Quote {quoteId}
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/admin/quotes"
              className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
            >
              ← Quotes
            </Link>
            <Link
              href={`/admin/renders/new`}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm px-4 py-2 rounded-md"
            >
              + New variant batch
            </Link>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 flex items-center justify-between flex-wrap gap-3">
          <div className="text-sm text-gray-700 space-x-4">
            <span><strong>{renders.length}</strong> variant{renders.length === 1 ? '' : 's'} on file</span>
            <span><strong className="text-green-700">{totalApproved}</strong> approved</span>
            <span><strong className="text-amber-700">{totalReady}</strong> awaiting review</span>
            <span><strong>${totalCost.toFixed(2)}</strong> total Gemini spend</span>
          </div>
          <button
            type="button"
            onClick={approveAll}
            disabled={busy === 'approveAll' || totalReady === 0}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2 rounded-md"
          >
            {busy === 'approveAll'
              ? 'Approving…'
              : totalReady === 0
                ? 'Nothing to approve'
                : `Approve all ${totalReady} ready`}
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-3 rounded-md mb-4">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center text-gray-500 py-12">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {ALL_VARIANTS_ORDER.map(variant => {
              const r = byVariant.get(variant);
              return (
                <VariantCard
                  key={variant}
                  variant={variant}
                  render={r}
                  busy={busy === r?.id}
                  onApprove={r ? () => setRenderStatus(r.id, 'approve') : undefined}
                  onReject={r ? () => setRenderStatus(r.id, 'reject') : undefined}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function VariantCard({
  variant,
  render,
  busy,
  onApprove,
  onReject,
}: {
  variant: RenderVariant;
  render: VariantRender | undefined;
  busy: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const label = VARIANT_LABELS[variant];
  const isFull = variant === 'full';

  if (!render) {
    return (
      <div className={`bg-white border-2 border-dashed border-gray-300 rounded-lg p-4 text-center ${isFull ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
        <p className="text-sm font-semibold text-gray-700">{label}</p>
        <p className="text-xs text-gray-400 mt-1">Not yet rendered</p>
      </div>
    );
  }

  const statusColor = {
    approved: 'bg-green-100 text-green-800 border-green-300',
    ready: 'bg-amber-100 text-amber-800 border-amber-300',
    rendering: 'bg-blue-100 text-blue-800 border-blue-300',
    pending: 'bg-gray-100 text-gray-800 border-gray-300',
    rejected: 'bg-red-100 text-red-800 border-red-300',
    failed: 'bg-red-100 text-red-800 border-red-300',
  }[render.status];

  return (
    <div className={`bg-white border border-gray-200 rounded-lg overflow-hidden ${isFull ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
      {render.urls.final ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={render.urls.final}
          alt={`${label} render`}
          className={`w-full ${isFull ? 'aspect-[16/10]' : 'aspect-[4/3]'} object-cover bg-gray-100`}
        />
      ) : (
        <div className={`w-full ${isFull ? 'aspect-[16/10]' : 'aspect-[4/3]'} bg-gray-100 flex items-center justify-center text-gray-400 text-xs`}>
          {render.status === 'rendering' ? 'Rendering…' : 'No final image'}
        </div>
      )}
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900">{label}</p>
          <span className={`text-[10px] uppercase font-semibold border rounded px-1.5 py-0.5 ${statusColor}`}>
            {render.status}
          </span>
        </div>
        <p className="text-[11px] text-gray-500 font-mono">
          {render.model} · {render.style} · ${(render.gemini_cost_usd ?? 0).toFixed(3)}
        </p>
        {render.status === 'ready' && (
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={onApprove}
              className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onReject}
              className="flex-1 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 text-xs font-medium px-3 py-1.5 rounded"
            >
              Reject
            </button>
          </div>
        )}
        {render.rejected_reason && (
          <p className="text-[11px] text-red-700 italic">Rejected: {render.rejected_reason}</p>
        )}
      </div>
    </div>
  );
}
