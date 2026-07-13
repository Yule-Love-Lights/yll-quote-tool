// Permanent Lighting (#88 P7) — printable ORDER SHEET for a permanent quote's
// BOM. Chrome-free, black-on-white (no OperatorShell): staff hit Print → "Save
// as PDF" and order the Ascend/Dauer APL material list. Operator-facing ordering
// + margin only; materials never touch the customer price. 404s for a non-
// permanent quote (no permanent block → no BOM).

import type { CSSProperties } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getOperator } from '@/lib/auth/supabaseServer';
import { getQuoteRaw } from '@/lib/quotes';
import { permanentBomFromQuote } from '@/lib/permanent/bomFromQuote';
import { catalogCostOverrides } from '@/lib/inventory/catalog';
import type { BomCategory } from '@/lib/permanent/bom';
import { PrintButton } from '@/components/inventory/PrintButton';

export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<BomCategory, string> = {
  lights: 'Lights',
  track: 'Track',
  power: 'Power',
  data: 'Data / signal',
  extension: 'Extensions',
  accessory: 'Accessory',
};
const CATEGORY_ORDER: BomCategory[] = ['lights', 'track', 'power', 'data', 'extension', 'accessory'];

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function PermanentBomPrintPage({ params }: { params: Promise<{ id: string }> }) {
  // WT-29: this page renders full customer PII + margin data for any quote UUID
  // — it had no gate at all. Same dormant-until-live pattern as the rest of the
  // operator surface (e.g. src/app/inventory/page.tsx).
  if (process.env.AUTH_GATE_ENABLED === 'true' && !(await getOperator())) {
    redirect('/login?from=/admin/quotes');
  }
  const { id } = await params;
  const quote = await getQuoteRaw(id);
  if (!quote) notFound();
  // P8 — live inventory_catalog costs override the engine's built-in fallback
  // prices; a catalog read failure swallows to [] → an empty override map →
  // every SKU falls back. Page already 404s for a non-permanent quote below, so
  // the fetch stays unconditional (this page never renders for holiday/event).
  const bom = permanentBomFromQuote(quote.inputs, await catalogCostOverrides());
  if (!bom) notFound(); // not a permanent quote / no permanent inputs

  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: bom.lines.filter((l) => l.category === cat),
  })).filter((g) => g.items.length > 0);

  const th: CSSProperties = { padding: '4px 6px' };
  const num: CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

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

      {/* WT-30: a test quote's badge (Kanban/admin list) doesn't carry over to
          print — staff could pull real materials for a job that never
          decrements real stock. */}
      {quote.is_test && (
        <div
          style={{
            border: '2px solid #6d28d9',
            background: '#ede9fe',
            color: '#6d28d9',
            fontWeight: 700,
            fontSize: '13px',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            padding: '8px 12px',
            marginBottom: '14px',
            textAlign: 'center',
          }}
        >
          TEST QUOTE — do not pull real stock
        </div>
      )}

      <header style={{ borderBottom: '2px solid #1f7a4d', paddingBottom: '10px', marginBottom: '14px' }}>
        <div style={{ fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#1f7a4d', fontWeight: 700 }}>
          Yule Love Lights — Permanent Lighting Order Sheet
        </div>
        <h1 style={{ fontSize: '22px', fontWeight: 700, margin: '4px 0 0' }}>
          {quote.quote_number != null ? `Quote #${quote.quote_number}` : `Quote ${id.slice(0, 8)}`}
        </h1>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: '13px', marginBottom: '18px' }}>
        <div><strong>Customer:</strong> {quote.customer_name ?? '—'}</div>
        <div><strong>Total footage:</strong> {bom.totals.totalFt} ft</div>
        <div><strong>Address:</strong> {quote.customer_address ?? '—'}</div>
        <div><strong>Lights:</strong> {bom.totals.puckCount} ({bom.totals.cornerSingles} corner singles)</div>
        <div><strong>Track sections:</strong> {bom.totals.trackSections}</div>
        <div><strong>Wholesale cost:</strong> {money(bom.totals.wholesaleCost)} ({money(bom.totals.costPerFt)}/ft)</div>
      </section>

      {bom.flags.length > 0 && (
        <ul style={{ fontSize: '12px', color: '#b45309', margin: '0 0 14px', paddingLeft: '18px' }}>
          {bom.flags.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #999', textAlign: 'left' }}>
            <th style={{ ...th, width: '34px' }}>✓</th>
            <th style={th}>SKU</th>
            <th style={th}>Item</th>
            <th style={{ ...th, ...num }}>Qty</th>
            <th style={{ ...th, ...num }}>Unit</th>
            <th style={{ ...th, ...num }}>Ext</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.cat}>
            <tr>
              <td colSpan={6} style={{ padding: '8px 6px 2px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#555' }}>
                {CATEGORY_LABELS[g.cat]}
              </td>
            </tr>
            {g.items.map((l) => (
              <tr key={l.sku} style={{ borderBottom: '1px solid #ddd' }}>
                <td style={{ padding: '5px 6px', fontSize: '15px' }}>☐</td>
                <td style={{ padding: '5px 6px', fontFamily: 'ui-monospace, monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>{l.sku}</td>
                <td style={{ padding: '5px 6px' }}>{l.description}</td>
                <td style={{ padding: '5px 6px', ...num }}>{l.qty}</td>
                <td style={{ padding: '5px 6px', ...num, color: '#666' }}>{money(l.unitCost)}</td>
                <td style={{ padding: '5px 6px', ...num }}>{money(l.extCost)}</td>
              </tr>
            ))}
          </tbody>
        ))}
        <tfoot>
          <tr style={{ borderTop: '2px solid #999', fontWeight: 700 }}>
            <td colSpan={5} style={{ padding: '6px', textAlign: 'right' }}>Total wholesale</td>
            <td style={{ padding: '6px', ...num }}>{money(bom.totals.wholesaleCost)}</td>
          </tr>
        </tfoot>
      </table>

      <footer style={{ marginTop: '24px', fontSize: '11px', color: '#999', borderTop: '1px solid #eee', paddingTop: '8px' }}>
        Staff order sheet — not customer-facing. Materials never affect the customer price. Generated {new Date().toLocaleString('en-US')}.
      </footer>
    </main>
  );
}
