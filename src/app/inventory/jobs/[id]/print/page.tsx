// Printable WORK ORDER for one job (#82 Slice 3 — PDF export). A clean,
// chrome-free page (no OperatorShell): the job's materials pick-list joined to
// on-hand, black-on-white for print. Staff hit Print → "Save as PDF". Server-
// rendered from the shared getJobWorkOrder so it always matches the board modal.

import { notFound, redirect } from 'next/navigation';
import { authGateEngaged, getOperator } from '@/lib/auth/supabaseServer';
import { getJobWorkOrder } from '@/lib/inventory/jobs';
import { FULFILLMENT_STAGE_LABELS } from '@/lib/inventory/fulfillmentStage';
import { PERMANENT_SIDE_LABEL } from '@/lib/permanent/types';
import { PrintButton } from '@/components/inventory/PrintButton';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

export default async function WorkOrderPrintPage({ params }: { params: Promise<{ id: string }> }) {
  // Defense in depth behind the middleware perimeter — re-check at render so this
  // staff work order (customer PII + pick list) never serves anonymously even if
  // the perimeter is bypassed. Engaged by default; dormant only on the explicit
  // AUTH_GATE_ENABLED=false opt-out (ledger #347, matches the #81 operator-page
  // pattern).
  if (authGateEngaged() && !(await getOperator())) {
    redirect('/login?from=/inventory/jobs');
  }
  const { id } = await params;
  const wo = await getJobWorkOrder(id);
  if (!wo) notFound();
  const { job, materials } = wo;
  // #192 review fix (parity) — same "Booked scope" note as the admin BOM
  // panel/print sheet, so a crew member pulling from this sheet knows WHY the
  // pick-list is narrower than the full measured house.
  const scopedSideNote = wo.scopedSides ? wo.scopedSides.map((s) => PERMANENT_SIDE_LABEL[s]).join(', ') : null;

  return (
    <main
      style={{
        maxWidth: '760px',
        margin: '0 auto',
        padding: '24px',
        color: '#111',
        background: '#fff',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <style>{`
        @media print { .no-print { display: none !important; } body { background: #fff; } }
        @page { margin: 0.5in; }
      `}</style>

      <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <PrintButton />
      </div>

      {job.isTest && (
        // Test Quote (ledger #93) — this banner is NOT inside .no-print: it must
        // stay visible on the printed/PDF sheet, since that's exactly the copy
        // that could otherwise be mistaken for a real work order in the field.
        <div
          style={{
            border: '2px solid #b45309',
            background: '#fef3c7',
            color: '#92400e',
            borderRadius: '6px',
            padding: '8px 12px',
            marginBottom: '14px',
            fontSize: '13px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            textAlign: 'center',
          }}
        >
          TEST — do not pull real stock
        </div>
      )}

      <header style={{ borderBottom: '2px solid #1f7a4d', paddingBottom: '10px', marginBottom: '14px' }}>
        <div style={{ fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#1f7a4d', fontWeight: 700 }}>
          Yule Love Lights — Work Order
        </div>
        <h1 style={{ fontSize: '22px', fontWeight: 700, margin: '4px 0 0' }}>
          Job #{job.jobNumber ?? '—'}
        </h1>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: '13px', marginBottom: '18px' }}>
        <div><strong>Customer:</strong> {job.customerName ?? '—'}</div>
        <div><strong>Stage:</strong> {FULFILLMENT_STAGE_LABELS[job.stage]}</div>
        <div><strong>Address:</strong> {job.customerAddress ?? '—'}</div>
        <div><strong>Install date:</strong> {fmtDate(job.installDate)}</div>
      </section>

      {scopedSideNote && (
        <p style={{ fontSize: '12px', color: '#1d4ed8', background: '#eff6ff', border: '1px solid #dbeafe', borderRadius: '6px', padding: '6px 8px', margin: '0 0 14px' }}>
          Booked scope: {scopedSideNote} — accessories/gaps remain whole-job.
        </p>
      )}

      <h2 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#555', margin: '0 0 6px' }}>
        Materials
      </h2>
      {materials.materials.length === 0 ? (
        <p style={{ fontSize: '13px', color: '#666' }}>
          No bound materials projected{job.designId ? '' : ' (this job has no linked design)'}.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #999', textAlign: 'left' }}>
              <th style={{ padding: '4px 6px', width: '34px' }}>✓</th>
              <th style={{ padding: '4px 6px' }}>SKU</th>
              <th style={{ padding: '4px 6px' }}>Item</th>
              <th style={{ padding: '4px 6px', textAlign: 'right' }}>Need</th>
              <th style={{ padding: '4px 6px', textAlign: 'right' }}>On hand</th>
            </tr>
          </thead>
          <tbody>
            {materials.materials.map((m) => (
              <tr key={m.sku} style={{ borderBottom: '1px solid #ddd' }}>
                <td style={{ padding: '5px 6px', fontSize: '15px' }}>☐</td>
                <td style={{ padding: '5px 6px', fontFamily: 'ui-monospace, monospace', fontSize: '12px' }}>{m.sku}</td>
                <td style={{ padding: '5px 6px' }}>{m.name}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.qty}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: m.short ? '#b45309' : '#666' }}>
                  {m.onHand === null ? 'not tracked' : m.short ? `${m.onHand} — short` : m.onHand}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {materials.unbound.length > 0 && (
        <section style={{ marginTop: '16px' }}>
          <h2 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#b45309', margin: '0 0 4px' }}>
            Unbound — no SKU set yet
          </h2>
          <ul style={{ fontSize: '13px', margin: 0, paddingLeft: '18px' }}>
            {materials.unbound.map((u) => (
              <li key={u.conceptKey}>{u.label} × {u.qty}</li>
            ))}
          </ul>
        </section>
      )}

      <footer style={{ marginTop: '24px', fontSize: '11px', color: '#999', borderTop: '1px solid #eee', paddingTop: '8px' }}>
        Staff work order — not customer-facing. Generated {new Date().toLocaleString('en-US')}.
      </footer>
    </main>
  );
}
