'use client';
import { useState } from 'react';
import Link from 'next/link';
import { pipelineActions, type PipelineRecord, type PipelineAction } from '@/lib/pipeline/pipelineActions';

async function run(action: PipelineAction, rec: PipelineRecord): Promise<Response | null> {
  const q = rec.quoteId;
  switch (action.kind) {
    case 'send':
      return fetch(`/api/quotes/${q}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: action.channel }),
      });
    case 'mark-approved':
      return fetch(`/api/quotes/${q}/staff-approve`, { method: 'POST' });
    case 'convert-to-job': {
      const entered = window.prompt('Deposit received (USD)? Enter 0 if none.', '');
      if (entered === null) return null; // user cancelled
      const depositUsd = Number(entered);
      if (!Number.isFinite(depositUsd) || depositUsd < 0) {
        alert('Enter a number >= 0');
        return null;
      }
      const post = (force: boolean) =>
        fetch(`/api/quotes/${q}/convert-to-job`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(force ? { depositUsd, force: true } : { depositUsd }),
        });
      const res = await post(false);
      // Abandoned-checkout override: if a customer Valor checkout is flagged in
      // flight, the operator can confirm no payment landed and book anyway.
      if (res.status === 409) {
        const body = await res.clone().json().catch(() => ({}));
        if ((body as { code?: string }).code === 'payment-in-flight') {
          const ok = window.confirm(
            'A customer card payment may be in progress for this quote. Only book manually if you’ve confirmed no payment was taken. Book anyway?',
          );
          if (!ok) return null;
          return post(true);
        }
      }
      return res;
    }
    case 'create-job':
      // Booked but job auto-create failed: re-run it via convert-to-job's
      // already-booked branch (idempotent createJobFromQuote). depositUsd is
      // ignored on an already-booked quote; force:true clears any stale
      // valor_order_ref in-flight guard. No prompt needed.
      return fetch(`/api/quotes/${q}/convert-to-job`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ depositUsd: 0, force: true }),
      });
    case 'mark-complete':
      return rec.job ? fetch(`/api/jobs/${rec.job.id}/complete`, { method: 'POST' }) : null;
    case 'collect-payment':
      return rec.invoice ? fetch(`/api/invoices/${rec.invoice.id}/mark-paid`, { method: 'POST' }) : null;
    case 'close':
      if (!rec.job) return null;
      if (!window.confirm('Close this job/invoice? Marks it paid + done.')) return null;
      return fetch(`/api/jobs/${rec.job.id}/close`, { method: 'POST' });
    case 'cancel':
      if (!rec.job) return null;
      if (!window.confirm('Cancel this booking? Refunds are handled manually in Valor.')) return null;
      return fetch(`/api/jobs/${rec.job.id}/cancel`, { method: 'POST' });
    case 'amend':
      // Navigate to the quote builder (edit page) — no fetch needed.
      window.location.assign(`/quote/${q}`);
      return null;
    default:
      return null;
  }
}

export function PipelineActionsMenu({
  quoteId,
  onDone,
}: {
  quoteId: string;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rec, setRec] = useState<PipelineRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/pipeline/${quoteId}`);
      if (res.ok) {
        setRec(await res.json());
      } else {
        setFetchError('Could not load actions');
      }
    } catch {
      setFetchError('Could not load actions');
    }
  }

  async function onPick(action: PipelineAction) {
    if (action.kind === 'details') return; // rendered as a <Link>, not a button
    if (!rec) return;
    setBusy(true);
    try {
      const res = await run(action, rec);
      if (res && !res.ok) {
        const body = await res.json().catch(() => ({}));
        alert((body as { error?: string }).error ?? 'Action failed');
      }
      if (res && res.ok) {
        setOpen(false);
        onDone?.();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={toggle}
        className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50 text-gray-700"
      >
        Options ▾
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-52 rounded-md border border-gray-200 bg-white shadow-lg py-1">
          {fetchError ? (
            <p className="px-3 py-2 text-xs text-red-600">{fetchError}</p>
          ) : !rec ? (
            <p className="px-3 py-2 text-xs text-gray-400">Loading…</p>
          ) : (
            pipelineActions(rec).map((a, i) =>
              a.kind === 'details' ? (
                <Link
                  key={i}
                  href={a.href}
                  className="block px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  {a.label}
                </Link>
              ) : (
                <button
                  key={i}
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(a)}
                  className="block w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {a.label}
                </button>
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}
