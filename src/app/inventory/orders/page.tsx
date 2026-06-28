'use client';

// Auto purchase order (#82 Phase 3 — AI auto-ordering, email channel). Shows the
// demand-driven shortfall across booked (not-yet-prepped) jobs vs on-hand, and
// lets staff email it to the supplier (Thunder). The order is auto-COMPUTED; the
// SEND is human-gated — auto-placing real supplier orders unattended is not done.

import { useCallback, useEffect, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';

type POLine = { sku: string; name: string; needed: number; onHand: number; order: number };
type PO = { lines: POLine[]; jobCount: number };

export default function OrdersPage() {
  const [po, setPo] = useState<PO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [send, setSend] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory/purchase-order');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setPo((await res.json()) as PO);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build the purchase order');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const sendOrder = async () => {
    if (!window.confirm('Email this purchase order to the supplier (Thunder)?')) return;
    setSend('sending');
    setSendMsg(null);
    try {
      const res = await fetch('/api/inventory/purchase-order', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSend('sent');
      setSendMsg(`Order emailed to the supplier (${body.sent} item${body.sent === 1 ? '' : 's'}).`);
    } catch (err) {
      setSend('error');
      setSendMsg(err instanceof Error ? err.message : 'Send failed');
    }
  };

  return (
    <OperatorShell active="inventory">
      <main className="max-w-3xl mx-auto">
        <InventorySubNav active="orders" />

        <div className="mb-5">
          <h1 className="text-xl font-semibold" style={{ color: 'var(--op-text)' }}>Purchase order</h1>
          <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
            Auto-generated from booked jobs that haven&apos;t been prepped yet: their total material need
            minus what&apos;s on hand. Review, then email it to the supplier.
          </p>
        </div>

        {error && <p className="text-sm mb-4" style={{ color: '#b91c1c' }}>Couldn&apos;t build the order: {error}</p>}

        {loading ? (
          <p className="text-sm py-10 text-center" style={{ color: 'var(--op-text-dim)' }}>Building order…</p>
        ) : !po || po.lines.length === 0 ? (
          <div className="rounded-lg border p-8 text-sm text-center" style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-dim)', background: 'var(--op-bg-raised)' }}>
            Nothing to order — on-hand covers all booked jobs{po ? ` (${po.jobCount} active)` : ''}.
          </div>
        ) : (
          <>
            <p className="text-xs mb-2" style={{ color: 'var(--op-text-dim)' }}>
              Across {po.jobCount} booked job{po.jobCount === 1 ? '' : 's'} · {po.lines.length} SKU{po.lines.length === 1 ? '' : 's'} to order
            </p>
            <div className="rounded-lg border overflow-x-auto" style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase" style={{ color: 'var(--op-text-dim)', background: 'var(--op-bg)' }}>
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">SKU</th>
                    <th className="text-left px-3 py-2 font-semibold">Item</th>
                    <th className="text-right px-3 py-2 font-semibold">Need</th>
                    <th className="text-right px-3 py-2 font-semibold">On hand</th>
                    <th className="text-right px-3 py-2 font-semibold">Order</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((l) => (
                    <tr key={l.sku} className="border-t" style={{ borderColor: 'var(--op-border)' }}>
                      <td className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--op-text-2)' }}>{l.sku}</td>
                      <td className="px-3 py-2" style={{ color: 'var(--op-text)' }}>{l.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--op-text-dim)' }}>{l.needed}</td>
                      <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--op-text-dim)' }}>{l.onHand}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: 'var(--op-text)' }}>{l.order}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={sendOrder}
                disabled={send === 'sending' || send === 'sent'}
                className="rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ background: '#1f7a4d' }}
              >
                {send === 'sending' ? 'Sending…' : send === 'sent' ? 'Sent ✓' : 'Send to supplier'}
              </button>
              {sendMsg && (
                <span className="text-sm" style={{ color: send === 'error' ? '#b91c1c' : 'var(--op-text-2)' }}>{sendMsg}</span>
              )}
            </div>
          </>
        )}
      </main>
    </OperatorShell>
  );
}
