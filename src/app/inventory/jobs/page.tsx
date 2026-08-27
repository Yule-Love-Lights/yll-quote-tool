'use client';

// Fulfillment Kanban (#82 Slice 3). Cards = jobs (auto-created on deposit-paid,
// #83), moved through the four materials-prep stages. Distinct from the dashboard
// Quotes WorkflowBoard — this board is operational (order → pick up → prep → stage
// for install). Each card opens a staff-only WORK ORDER: the projected materials
// list (design → SKUs) joined to on-hand stock. (PDF/email export is a follow-up.)

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import {
  FULFILLMENT_STAGES,
  FULFILLMENT_STAGE_LABELS,
  type FulfillmentStage,
} from '@/lib/inventory/fulfillmentStage';
import type { FulfillmentCard } from '@/lib/inventory/jobs';
import { PERMANENT_SIDE_LABEL, type PermanentSide } from '@/lib/permanent/types';
import { SkeletonBar } from '@/components/ui/LoadingSkeleton';

type MaterialRow = { sku: string; name: string; qty: number; onHand: number | null; short: boolean };
type UnboundConcept = { conceptKey: string; label: string; qty: number };
type WorkOrder = {
  job: { id: string; jobNumber: number | null; quoteId: string | null; designId: string | null; stage: FulfillmentStage; status: string; installDate: string | null; customerName: string | null; customerAddress: string | null; stockDecrementedAt: string | null; isTest: boolean };
  materials: { materials: MaterialRow[]; unbound: UnboundConcept[]; totalLines: number };
  // #192 review fix — same scoping the crew print sheet + purchasing email
  // surface; see WorkOrder.scopedSides in src/lib/inventory/jobs.ts.
  scopedSides: PermanentSide[] | null;
};

export default function JobsBoardPage() {
  const [cards, setCards] = useState<FulfillmentCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory/jobs');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const body = (await res.json()) as { cards: FulfillmentCard[] };
      setCards(Array.isArray(body.cards) ? body.cards : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer out of the synchronous effect body — load() calls setState (the
    // react-hooks/set-state-in-effect rule is at error in this repo).
    queueMicrotask(() => void load());
  }, [load]);

  const move = useCallback(async (id: string, stage: FulfillmentStage) => {
    const prev = cards;
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, stage } : c))); // optimistic
    try {
      const res = await fetch(`/api/inventory/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) throw new Error('move failed');
    } catch {
      setCards(prev); // revert on failure
    }
  }, [cards]);

  return (
    <OperatorShell active="inventory">
      <main className="max-w-[1400px] mx-auto">
        <InventorySubNav active="jobs" />

        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--op-text)' }}>Job fulfillment</h1>
            <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
              Booked jobs move through materials prep. A job appears here once its deposit is paid, and
              leaves once it&apos;s installed. Click a job for its work order.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="text-sm font-medium rounded-md px-3 py-1.5 border"
            style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Refresh
          </button>
        </div>

        {error && <p className="text-sm mb-4" style={{ color: '#b91c1c' }}>Couldn&apos;t load jobs: {error}</p>}
        {loading ? (
          // Row 410: the board is a fixed set of stage columns, so the
          // skeleton is those columns at their real minimum width — the page
          // never reflows from a one-line placeholder into a wide grid.
          <div
            role="status"
            aria-busy="true"
            className="grid gap-3 overflow-x-auto pb-2"
            style={{ gridTemplateColumns: `repeat(${FULFILLMENT_STAGES.length}, minmax(220px, 1fr))` }}
          >
            {FULFILLMENT_STAGES.map((stage) => (
              <section key={stage} className="rounded-lg border" style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)' }}>
                <header className="px-3 py-2 border-b" style={{ borderColor: 'var(--op-border)' }}>
                  <SkeletonBar className="h-4 w-24" />
                </header>
                <div className="p-2 flex flex-col gap-2 min-h-[60px]">
                  <SkeletonBar className="h-16" />
                </div>
              </section>
            ))}
            <span className="sr-only">Loading jobs…</span>
          </div>
        ) : cards.length === 0 ? (
          <div className="rounded-lg border p-8 text-sm text-center" style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-dim)', background: 'var(--op-bg-raised)' }}>
            No active jobs yet — a job appears here once a customer pays their deposit.
          </div>
        ) : (
          <div className="grid gap-3 overflow-x-auto pb-2" style={{ gridTemplateColumns: `repeat(${FULFILLMENT_STAGES.length}, minmax(220px, 1fr))` }}>
            {FULFILLMENT_STAGES.map((stage) => {
              const col = cards.filter((c) => c.stage === stage);
              return (
                <section key={stage} className="rounded-lg border" style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)' }}>
                  <header className="px-3 py-2 border-b flex items-center justify-between" style={{ borderColor: 'var(--op-border)' }}>
                    <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--op-text-2)' }}>{FULFILLMENT_STAGE_LABELS[stage]}</span>
                    <span className="text-xs tabular-nums" style={{ color: 'var(--op-text-dim)' }}>{col.length}</span>
                  </header>
                  <div className="p-2 flex flex-col gap-2 min-h-[60px]">
                    {col.map((c) => (
                      <JobCard key={c.id} card={c} onMove={move} onOpen={() => setOpenId(c.id)} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>

      {openId && <WorkOrderModal id={openId} onClose={() => setOpenId(null)} />}
    </OperatorShell>
  );
}

// Staff-lens fix (row 382/MED): pure extraction of the badge condition, same
// pattern as shortSkusFromPrepareResponse below (this repo has no
// jsdom/testing-library, so a JobCard render can't be unit-tested directly —
// the pure boolean the JSX condition reads on IS the testable unit, and the
// negative control below proves the JSX actually reads this function's
// result, not a copy of the logic).
export function shouldShowStuckStockBadge(card: Pick<FulfillmentCard, 'stockSnapshotPending'>): boolean {
  return !!card.stockSnapshotPending;
}

function JobCard({ card, onMove, onOpen }: { card: FulfillmentCard; onMove: (id: string, s: FulfillmentStage) => void; onOpen: () => void }) {
  return (
    <div className="rounded-md border p-2.5 text-sm" style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}>
      <div className="flex items-center gap-1.5 min-w-0">
        <button type="button" onClick={onOpen} className="font-semibold hover:underline" style={{ color: 'var(--op-primary)' }}>
          Job #{card.jobNumber ?? '—'}
        </button>
        {/* Test Quote (ledger #93) — VISIBLE on the Kanban, badged so a test
            job is obvious. It moves through stages but never deducts real
            on-hand or hits the supplier PO. */}
        {card.isTest && (
          <span
            className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
            style={{ background: '#ede9fe', color: '#6d28d9' }}
            title="Simulated test job — no real stock or supplier order"
          >
            Test
          </span>
        )}
        {/* Staff-lens fix (row 382/MED): stockSnapshotPending was on
            FulfillmentCard but only ever read by the daily digest — this
            board, the surface staff actually watch all day, rendered
            nothing. Same badge shape/placement as the Test pill above, the
            page's own amber "needs attention" color (matches the short-SKU
            warning in the work-order modal below), plain wording matching
            the corrected staff copy — no table/column names. */}
        {shouldShowStuckStockBadge(card) && (
          <span
            className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
            style={{ background: '#fef3c7', color: '#b45309' }}
            title="This job was prepped, but the record of exactly what it took didn't save — check on-hand against its materials before restocking"
          >
            Check stock
          </span>
        )}
      </div>
      {/* Customer-name link (mirrors /admin/quotes' idiom, #666): same routing
          rule as src/lib/dashboard/customers.ts customerRouteId —
          highlevel_contact_id, else customer_id. A walk-in with neither stays
          plain text. This board's own link styling (var(--op-primary), not
          Tailwind's text-blue-600) matches its other links (e.g. the job # button
          above, the print/design links in the work-order modal). */}
      {(() => {
        const routeId = card.highlevelContactId ?? card.customerId;
        return routeId ? (
          <Link
            href={`/customers/${encodeURIComponent(routeId)}`}
            className="mt-0.5 truncate block hover:underline"
            style={{ color: 'var(--op-primary)' }}
          >
            {card.customerName ?? 'Customer'}
          </Link>
        ) : (
          <div className="mt-0.5 truncate" style={{ color: 'var(--op-text)' }}>{card.customerName ?? 'Customer'}</div>
        );
      })()}
      {card.customerAddress && <div className="text-[11px] truncate" style={{ color: 'var(--op-text-dim)' }}>{card.customerAddress}</div>}
      <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: 'var(--op-text-dim)' }}>
        <span>{card.itemCount} item{card.itemCount === 1 ? '' : 's'}</span>
      </div>
      <label className="mt-2 block">
        <span className="sr-only">Move job to stage</span>
        <select
          value={card.stage}
          onChange={(e) => onMove(card.id, e.target.value as FulfillmentStage)}
          className="w-full text-xs rounded border px-1.5 py-1"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)', color: 'var(--op-text-2)' }}
        >
          {FULFILLMENT_STAGES.map((s) => (
            <option key={s} value={s}>Move to: {FULFILLMENT_STAGE_LABELS[s]}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

// Fix round 3 (Finding MED, PR #926): pure extraction of `PrepareResult.short`
// from the /prepare response body, mirroring ColorRequestPanel.tsx's
// applyOutcomeFromResponse — this repo's pattern for testing a fetch response
// shape without jsdom/testing-library (see that file's tests; this repo's
// component tests use exactly this extraction-plus-pure-test approach).
// Defensive against a malformed/missing body (non-array `short`, non-string
// entries) — a bad body degrades to "nothing flagged short", never a throw.
export function shortSkusFromPrepareResponse(body: unknown): string[] {
  const short = (body as { short?: unknown } | null)?.short;
  return Array.isArray(short) ? short.filter((s): s is string => typeof s === 'string') : [];
}

function WorkOrderModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<WorkOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const emailOrder = async () => {
    setEmailStatus('sending');
    try {
      const res = await fetch(`/api/inventory/jobs/${id}/email-order`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'failed');
      setEmailStatus('sent');
    } catch {
      setEmailStatus('error');
    }
  };

  const [prepareStatus, setPrepareStatus] = useState<'idle' | 'preparing' | 'error'>('idle');
  // Fix round 3 (Finding MED, PR #926): PrepareResult's `short` field — SKUs
  // the on-hand floor clamped, so this prep deducted LESS than the job needed
  // — reaches staff via the WhatsApp bot's reply text already; this modal is
  // the PRIMARY staff surface for the same action and was silently dropping
  // it. Populated once from the prepare response and kept for the rest of
  // this modal session (the field is ephemeral — not persisted on the job
  // row — so it can't be recovered from a later `load()`/reopen).
  const [prepareShort, setPrepareShort] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/inventory/jobs/${id}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setData((await res.json()) as WorkOrder);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load work order');
    }
  }, [id]);

  useEffect(() => {
    // Defer out of the synchronous effect body (react-hooks/set-state-in-effect).
    queueMicrotask(() => void load());
  }, [load]);

  const prepare = async () => {
    if (!window.confirm("Deduct this job's materials from on-hand stock and mark it prepped?")) return;
    setPrepareStatus('preparing');
    try {
      const res = await fetch(`/api/inventory/jobs/${id}/prepare`, { method: 'POST' });
      if (!res.ok) throw new Error('prepare failed');
      // Fix round 3: capture `short` before the reload below replaces `data` —
      // it's not part of the work-order shape `load()` re-fetches.
      const json = await res.json().catch(() => null);
      setPrepareShort(shortSkusFromPrepareResponse(json));
      setPrepareStatus('idle');
      await load(); // refresh on-hand + the prepped flag
    } catch {
      setPrepareStatus('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="mt-10 w-full max-w-2xl rounded-lg shadow-xl" style={{ background: 'var(--op-bg-raised)' }} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--op-border)' }}>
          <div className="flex items-center gap-1.5">
            <h2 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>
              Work order{data?.job.jobNumber != null ? ` — Job #${data.job.jobNumber}` : ''}
            </h2>
            {/* Test Quote (ledger #93) — same badge as the Kanban card, so the
                modal alone (opened via a stale tab / direct link) still makes a
                test job obvious. */}
            {data?.job.isTest && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
                style={{ background: '#ede9fe', color: '#6d28d9' }}
                title="Simulated test job — no real stock or supplier order"
              >
                Test
              </span>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-sm" style={{ color: 'var(--op-text-dim)' }}>Close ✕</button>
        </header>
        <div className="p-4">
          {error ? (
            <p className="text-sm" style={{ color: '#b91c1c' }}>{error}</p>
          ) : !data ? (
            // Row 410 fix round (staff lens MED): the real drawer is a
            // customer line, a stage/action row, the prep button and a
            // materials TABLE — several hundred pixels. Five thin lines held a
            // sixth of that and the drawer still ballooned right as a staffer
            // reached for "Mark prepared". Mirror the real shape instead.
            <div role="status" aria-busy="true" className="flex flex-col gap-3">
              <SkeletonBar className="h-5 w-64" />
              <SkeletonBar className="h-5 w-80" />
              <SkeletonBar className="h-9 w-40" />
              <SkeletonBar className="h-64" />
              <span className="sr-only">Loading work order…</span>
            </div>
          ) : (
            <>
              {(data.job.customerName || data.job.customerAddress) && (
                <div className="mb-1 text-sm" style={{ color: 'var(--op-text)' }}>
                  {data.job.customerName}{data.job.customerAddress ? ` · ${data.job.customerAddress}` : ''}
                </div>
              )}
              <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm" style={{ color: 'var(--op-text-2)' }}>
                <span>Stage: <strong style={{ color: 'var(--op-text)' }}>{FULFILLMENT_STAGE_LABELS[data.job.stage]}</strong></span>
                <a href={`/inventory/jobs/${data.job.id}/print`} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline" style={{ color: 'var(--op-primary)' }}>
                  Print / Save PDF ↗
                </a>
                <button
                  type="button"
                  onClick={emailOrder}
                  disabled={emailStatus === 'sending'}
                  className="font-medium hover:underline disabled:opacity-60"
                  style={{ color: emailStatus === 'error' ? '#b91c1c' : 'var(--op-primary)' }}
                >
                  {emailStatus === 'sending'
                    ? 'Sending…'
                    : emailStatus === 'sent'
                      ? 'Order emailed ✓'
                      : emailStatus === 'error'
                        ? 'Email failed — retry'
                        : 'Email order ✉'}
                </button>
                {data.job.quoteId && (
                  <a href={`/quote/${data.job.quoteId}`} className="hover:underline" style={{ color: 'var(--op-primary)' }}>Open design / quote →</a>
                )}
              </div>

              <div className="mb-3">
                {data.job.stockDecrementedAt ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium" style={{ color: '#1f7a4d' }}>✓ Stock deducted — job prepped</span>
                    {/* Fix round 3 (Finding MED): same amber already used below
                        for a per-SKU on-hand shortage (m.short) — reused here,
                        not a new pattern, so a clamped prep doesn't read as a
                        full one on the surface staff actually use. */}
                    {prepareShort.length > 0 && (
                      <span className="text-xs font-medium" style={{ color: '#b45309' }}>
                        ⚠ Short on {prepareShort.length} SKU{prepareShort.length === 1 ? '' : 's'} (not enough on-hand): {prepareShort.join(', ')} — check stock before loading.
                      </span>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={prepare}
                    disabled={prepareStatus === 'preparing'}
                    className="rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                    style={{ background: '#1f7a4d' }}
                  >
                    {prepareStatus === 'preparing'
                      ? 'Deducting…'
                      : prepareStatus === 'error'
                        ? 'Prep failed — retry'
                        : 'Mark prepared — deduct stock'}
                  </button>
                )}
              </div>

              {/* #192 review fix (parity) — same note as the crew print sheet +
                  purchasing email, shown ABOVE the materials table so staff read
                  the explanation before the narrowed numbers. */}
              {data.scopedSides && data.scopedSides.length > 0 && (
                <p
                  className="mb-2 rounded-md border px-2 py-1.5 text-xs"
                  style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-hover)', color: 'var(--op-text-2)' }}
                >
                  Booked scope: {data.scopedSides.map((s) => PERMANENT_SIDE_LABEL[s]).join(', ')} — accessories/gaps remain whole-job.
                </p>
              )}

              <h3 className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--op-text-dim)' }}>Materials</h3>
              {data.materials.materials.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
                  No bound materials projected yet{data.job.designId ? '' : ' (this job has no linked design)'}.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs uppercase" style={{ color: 'var(--op-text-dim)' }}>
                      <th className="text-left py-1 font-semibold">SKU</th>
                      <th className="text-left py-1 font-semibold">Item</th>
                      <th className="text-right py-1 font-semibold">Need</th>
                      <th className="text-right py-1 font-semibold">On hand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.materials.materials.map((m) => (
                      <tr key={m.sku} className="border-t" style={{ borderColor: 'var(--op-border)' }}>
                        <td className="py-1.5 font-mono text-xs" style={{ color: 'var(--op-text-2)' }}>{m.sku}</td>
                        <td className="py-1.5" style={{ color: 'var(--op-text)' }}>{m.name}</td>
                        <td className="py-1.5 text-right tabular-nums" style={{ color: 'var(--op-text)' }}>{m.qty}</td>
                        <td className="py-1.5 text-right tabular-nums" style={{ color: m.short ? '#b45309' : 'var(--op-text-dim)' }}>
                          {m.onHand === null
                            ? 'not tracked'
                            : m.short
                              ? `${m.onHand} — order ${m.qty - m.onHand} more`
                              : m.onHand}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {data.materials.unbound.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: '#b45309' }}>Unbound concepts (no SKU yet)</h3>
                  <ul className="text-sm" style={{ color: 'var(--op-text-2)' }}>
                    {data.materials.unbound.map((u) => (
                      <li key={u.conceptKey}>{u.label} × {u.qty}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
