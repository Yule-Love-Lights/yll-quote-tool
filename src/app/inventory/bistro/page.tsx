import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getOperator } from '@/lib/auth/supabaseServer';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import { BISTRO_CATALOG, type BistroSupplier } from '@/lib/inventory/bistroCatalog';

export const metadata = { title: 'Bistro reorder reference — Yule Love Lights' };

// Permanent Bistro (#117) — a STATIC reorder reference, not a live stock
// table (there's no inventory_catalog row for these SKUs — see
// bistroCatalog.ts's header). Lists every SKU across the 3 suppliers with what
// drives its quantity on a job, so staff can order ahead of a scheduled
// install without opening a specific quote's order sheet.

const SUPPLIER_LABELS: Record<BistroSupplier, string> = {
  thunder: 'Thunder Lighting Supply',
  'home-depot': 'Home Depot',
  amazon: 'Amazon',
};
const SUPPLIER_ORDER: BistroSupplier[] = ['thunder', 'home-depot', 'amazon'];

const money = (n: number) => (n > 0 ? `$${n.toFixed(2)}` : '—');

export default async function BistroInventoryPage() {
  if (process.env.AUTH_GATE_ENABLED === 'true' && !(await getOperator())) {
    redirect('/login?from=/inventory/bistro');
  }

  const groups = SUPPLIER_ORDER.map((supplier) => ({
    supplier,
    items: BISTRO_CATALOG.filter((c) => c.supplier === supplier),
  })).filter((g) => g.items.length > 0);

  return (
    <OperatorShell active="inventory">
      <main className="max-w-3xl mx-auto">
        <InventorySubNav active="bistro" />

        <div className="mb-4">
          <h1 className="text-xl font-semibold text-gray-900">Bistro reorder reference</h1>
          <p className="text-sm text-gray-500">
            Permanent Bistro Lighting materials, by supplier. Quantities for a specific job come from that
            quote&apos;s order sheet (Admin → Quotes → the quote → Print order sheet). This page is the standing
            catalog for stocking up ahead of installs.
          </p>
        </div>

        {groups.map((g) => (
          <div key={g.supplier} className="mb-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              {SUPPLIER_LABELS[g.supplier]}
            </h2>
            <div className="border border-gray-100 rounded">
              <div className="flex items-center gap-3 px-3 py-2 text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                <span className="w-24 shrink-0">SKU</span>
                <span className="flex-1">Item</span>
                <span className="w-44 shrink-0">Drives quantity by</span>
                <span className="w-16 text-right shrink-0">Unit cost</span>
                <span className="w-14 text-right shrink-0">Order</span>
              </div>
              {g.items.map((item) => (
                <div key={item.sku} className="flex items-center gap-3 px-3 py-2 border-b border-gray-100 last:border-b-0">
                  <span className="font-mono text-xs text-gray-500 w-24 shrink-0">{item.sku}</span>
                  <span className="flex-1 truncate text-sm text-gray-800" title={item.name}>
                    {item.name}
                  </span>
                  <span className="w-44 shrink-0 text-xs text-gray-500">{item.driver}</span>
                  <span className="w-16 text-right shrink-0 text-sm text-gray-600 tabular-nums">
                    {money(item.unitCost)}
                  </span>
                  <span className="w-14 text-right shrink-0">
                    <Link
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-700 hover:underline"
                    >
                      Order ↗
                    </Link>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </main>
    </OperatorShell>
  );
}
