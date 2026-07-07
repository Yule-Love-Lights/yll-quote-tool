'use client';

// Auto purchase order (#82 Phase 3 — AI auto-ordering, email channel). Shows the
// demand-driven shortfall across booked (not-yet-prepped) jobs vs on-hand and
// on-order, and lets staff email it to the supplier (Thunder). The order is
// auto-COMPUTED; the SEND is human-gated — auto-placing real supplier orders
// unattended is not done. Below the preview, the "Open orders" section (P8,
// folds in #110 W7-002) is the on-order ledger: every sent order stays open
// until staff mark it received (adds its quantities to on-hand) or cancelled
// (drops it from the delta math without touching stock).

import { useCallback, useEffect, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';

type POLine = { sku: string; name: string; needed: number; onHand: number; onOrder: number; order: number };
type PO = { lines: POLine[]; jobCount: number };

type OrderLine = { sku: string; name: string; qty: number };
type InventoryOrder = {
  id: string;
  created_at: string;
  channel: 'manual' | 'auto-cron' | 'auto-webhook';
  status: 'open' | 'received' | 'cancelled';
  lines: OrderLine[];
  job_count: number;
};

const CHANNEL_LABELS: Record<InventoryOrder['channel'], string> = {
  manual: 'Manual',
  'auto-cron': 'Auto cron',
  'auto-webhook': 'Auto webhook',
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function OrdersPage() {
  const [po, setPo] = useState<PO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [send, setSend] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  const [openOrders, setOpenOrders] = useState<InventoryOrder[]>([]);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [receiveQty, setReceiveQty] = useState<Record<string, Record<string, number>>>({});
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

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

  const loadOpenOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory/orders?status=open');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const body = (await res.json()) as { orders: InventoryOrder[] };
      const orders = Array.isArray(body.orders) ? body.orders : [];
      setOpenOrders(orders);
      // Pre-fill the receive-qty inputs with the ordered qty for any order not
      // already tracked (don't clobber quantities staff already edited).
      setReceiveQty((prev) => {
        const next = { ...prev };
        for (const o of orders) {
          if (!next[o.id]) {
            next[o.id] = Object.fromEntries(o.lines.map((l) => [l.sku, l.qty]));
          }
        }
        return next;
      });
      setOrdersError(null);
    } catch (err) {
      setOrdersError(err instanceof Error ? err.message : 'Failed to load open orders');
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
      void loadOpenOrders();
    });
  }, [load, loadOpenOrders]);

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
      await loadOpenOrders(); // the new sent order shows up below
    } catch (err) {
      setSend('error');
      setSendMsg(err instanceof Error ? err.message : 'Send failed');
    }
  };

  const markReceived = async (order: InventoryOrder) => {
    if (!window.confirm('Mark this order received? Its quantities will be added to on-hand stock.')) return;
    setBusyOrderId(order.id);
    try {
      const edited = receiveQty[order.id] ?? {};
      const lines = order.lines.map((l) => ({ sku: l.sku, qty: edited[l.sku] ?? l.qty }));
      const res = await fetch(`/api/inventory/orders/${order.id}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      // Receiving changes on-hand, so the shortfall preview must reload too.
      await Promise.all([loadOpenOrders(), load()]);
    } catch (err) {
      setOrdersError(err instanceof Error ? err.message : 'Failed to mark the order received');
    } finally {
      setBusyOrderId(null);
    }
  };

  const cancelOrder = async (order: InventoryOrder) => {
    if (!window.confirm("Cancel this order? It's cleared from the on-order math but stock is untouched.")) return;
    setBusyOrderId(order.id);
    try {
      const res = await fetch(`/api/inventory/orders/${order.id}/cancel`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      await loadOpenOrders();
    } catch (err) {
      setOrdersError(err instanceof Error ? err.message : 'Failed to cancel the order');
    } finally {
      setBusyOrderId(null);
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
                    <th className="text-right px-3 py-2 font-semibold">On order</th>
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
                      <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--op-text-dim)' }}>{l.onOrder}</td>
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

        <div className="mt-10 mb-3">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--op-text)' }}>Open orders</h2>
          <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
            Sent purchase orders still on the way. Mark one received when the shipment arrives (adds its
            quantities to on-hand stock) — lower the receive qty first if it arrived short.
          </p>
        </div>

        {ordersError && <p className="text-sm mb-4" style={{ color: '#b91c1c' }}>Couldn&apos;t load open orders: {ordersError}</p>}

        {ordersLoading ? (
          <p className="text-sm py-10 text-center" style={{ color: 'var(--op-text-dim)' }}>Loading open orders…</p>
        ) : openOrders.length === 0 ? (
          <div className="rounded-lg border p-8 text-sm text-center" style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-dim)', background: 'var(--op-bg-raised)' }}>
            No open orders.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {openOrders.map((order) => {
              const busy = busyOrderId === order.id;
              return (
                <div key={order.id} className="rounded-lg border p-4" style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="text-sm" style={{ color: 'var(--op-text)' }}>
                      <span className="font-semibold">{fmtDate(order.created_at)}</span>
                      <span style={{ color: 'var(--op-text-dim)' }}> · {CHANNEL_LABELS[order.channel]} · {order.job_count} job{order.job_count === 1 ? '' : 's'}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void markReceived(order)}
                        disabled={busy}
                        className="rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                        style={{ background: '#1f7a4d' }}
                      >
                        {busy ? 'Working…' : 'Mark received'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void cancelOrder(order)}
                        disabled={busy}
                        className="text-sm font-medium hover:underline disabled:opacity-60"
                        style={{ color: '#b91c1c' }}
                      >
                        Cancel order
                      </button>
                    </div>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs uppercase" style={{ color: 'var(--op-text-dim)' }}>
                        <th className="text-left py-1 font-semibold">SKU</th>
                        <th className="text-left py-1 font-semibold">Item</th>
                        <th className="text-right py-1 font-semibold">Ordered</th>
                        <th className="text-right py-1 font-semibold">Receive qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.lines.map((l) => (
                        <tr key={l.sku} className="border-t" style={{ borderColor: 'var(--op-border)' }}>
                          <td className="py-1.5 font-mono text-xs" style={{ color: 'var(--op-text-2)' }}>{l.sku}</td>
                          <td className="py-1.5" style={{ color: 'var(--op-text)' }}>{l.name}</td>
                          <td className="py-1.5 text-right tabular-nums" style={{ color: 'var(--op-text-dim)' }}>{l.qty}</td>
                          <td className="py-1.5 text-right">
                            <input
                              type="number"
                              min={0}
                              disabled={busy}
                              value={receiveQty[order.id]?.[l.sku] ?? l.qty}
                              onChange={(e) => {
                                const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
                                setReceiveQty((prev) => ({
                                  ...prev,
                                  [order.id]: { ...prev[order.id], [l.sku]: v },
                                }));
                              }}
                              className="w-20 text-right tabular-nums rounded border px-1.5 py-1 text-sm disabled:opacity-60"
                              style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)', color: 'var(--op-text)' }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </OperatorShell>
  );
}
