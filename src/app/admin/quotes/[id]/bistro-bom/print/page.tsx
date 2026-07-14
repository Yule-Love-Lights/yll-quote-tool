// Permanent Bistro Lighting (#117) — printable ORDER SHEET for a bistro
// quote's BOM. Chrome-free, black-on-white (no OperatorShell): staff hit
// Print → "Save as PDF" and order from three suppliers. Grouped BY SUPPLIER
// (not by category, unlike the permanent sheet) since each supplier group
// heading links straight to that supplier's ordering page. Operator-facing
// ordering only; materials never touch the customer price. 404s for a
// non-bistro or empty-job quote (no permanentBistro block, or nothing to
// order → no BOM).

import type { CSSProperties } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getOperator } from '@/lib/auth/supabaseServer';
import { getQuoteRaw } from '@/lib/quotes';
import { bistroBomFromQuote } from '@/lib/permanentBistro/bomFromQuote';
import { listCatalog } from '@/lib/inventory/catalog';
import { costOverridesFromBistroCatalog } from '@/lib/inventory/bistroCatalog';
import type { BistroSupplier } from '@/lib/permanentBistro/bom';
import { PrintButton } from '@/components/inventory/PrintButton';

export const dynamic = 'force-dynamic';

const SUPPLIER_LABELS: Record<BistroSupplier, string> = {
  thunder: 'Thunder Lighting Supply',
  'home-depot': 'Home Depot',
  amazon: 'Amazon',
};
const SUPPLIER_ORDER: BistroSupplier[] = ['thunder', 'home-depot', 'amazon'];

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function BistroBomPrintPage({ params }: { params: Promise<{ id: string }> }) {
  // Defense in depth behind the middleware perimeter — re-check at render so this
  // staff order sheet (customer PII) never serves anonymously even if the
  // perimeter is bypassed. Dormant until the auth gate is live (matches the
  // #81 operator-page pattern).
  if (process.env.AUTH_GATE_ENABLED === 'true' && !(await getOperator())) {
    redirect('/login?from=/admin/quotes');
  }
  const { id } = await params;
  const quote = await getQuoteRaw(id);
  if (!quote) notFound();
  // Live inventory_catalog costs override the engine's built-in fallback
  // prices when a SKU's been re-priced; a catalog read failure swallows to []
  // → an empty override map → every SKU falls back. Page already 404s for a
  // non-bistro/empty quote below, so the fetch stays unconditional.
  const bom = bistroBomFromQuote(quote.inputs, costOverridesFromBistroCatalog(await listCatalog()));
  if (!bom) notFound(); // not a permanent-bistro quote / an empty job

  const groups = SUPPLIER_ORDER.map((supplier) => ({
    supplier,
    url: bom.lines.find((l) => l.supplier === supplier)?.url,
    items: bom.lines.filter((l) => l.supplier === supplier),
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

      <header style={{ borderBottom: '2px solid #1f7a4d', paddingBottom: '10px', marginBottom: '14px' }}>
        <div style={{ fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#1f7a4d', fontWeight: 700 }}>
          Yule Love Lights — Permanent Bistro Order Sheet
        </div>
        <h1 style={{ fontSize: '22px', fontWeight: 700, margin: '4px 0 0' }}>
          {quote.quote_number != null ? `Quote #${quote.quote_number}` : `Quote ${id.slice(0, 8)}`}
        </h1>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: '13px', marginBottom: '18px' }}>
        <div><strong>Customer:</strong> {quote.customer_name ?? '—'}</div>
        <div><strong>Total footage:</strong> {bom.totals.totalFootage} ft ({bom.totals.strands} strand{bom.totals.strands === 1 ? '' : 's'})</div>
        <div><strong>Address:</strong> {quote.customer_address ?? '—'}</div>
        <div><strong>Poles:</strong> {bom.totals.poles}</div>
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
          <tbody key={g.supplier}>
            <tr>
              <td colSpan={6} style={{ padding: '8px 6px 2px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#555' }}>
                {g.url ? (
                  <a href={g.url} target="_blank" rel="noopener noreferrer" style={{ color: '#1f7a4d' }}>
                    {SUPPLIER_LABELS[g.supplier]} ↗
                  </a>
                ) : (
                  SUPPLIER_LABELS[g.supplier]
                )}
              </td>
            </tr>
            {g.items.map((l) => (
              <tr key={l.sku} style={{ borderBottom: '1px solid #ddd' }}>
                <td style={{ padding: '5px 6px', fontSize: '15px' }}>☐</td>
                <td style={{ padding: '5px 6px', fontFamily: 'ui-monospace, monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>
                  {/* Per-row link, not just the heading — Home Depot's post + concrete
                      are DIFFERENT product pages, so the group heading link alone
                      (the first item's URL) would send staff to the wrong page for
                      the other one. Thunder rows all share one URL; this is harmless
                      redundancy there. */}
                  <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
                    {l.sku}
                  </a>
                </td>
                <td style={{ padding: '5px 6px' }}>{l.description}</td>
                <td style={{ padding: '5px 6px', ...num }}>{l.asNeeded ? 'as needed' : l.qty}</td>
                <td style={{ padding: '5px 6px', ...num, color: '#666' }}>{money(l.unitCost)}</td>
                <td style={{ padding: '5px 6px', ...num }}>{money(l.extCost)}</td>
              </tr>
            ))}
          </tbody>
        ))}
        <tfoot>
          <tr style={{ borderTop: '2px solid #999', fontWeight: 700 }}>
            <td colSpan={5} style={{ padding: '6px', textAlign: 'right' }}>Total</td>
            <td style={{ padding: '6px', ...num }}>{money(bom.totals.extCostTotal)}</td>
          </tr>
        </tfoot>
      </table>

      <footer style={{ marginTop: '24px', fontSize: '11px', color: '#999', borderTop: '1px solid #eee', paddingTop: '8px' }}>
        Staff order sheet, not customer-facing. Materials never affect the customer price. Generated {new Date().toLocaleString('en-US')}.
      </footer>
    </main>
  );
}
