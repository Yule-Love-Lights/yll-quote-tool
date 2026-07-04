// Permanent Lighting (#88 P7) — operator BOM panel. Renders a computed
// PermanentBom (the Ascend/Dauer APL material list) grouped by category with a
// wholesale-cost summary. Operator-facing ordering + margin only — materials
// NEVER touch the customer price. Presentational (server component); the caller
// computes the bom via permanentBomFromQuote.

import type { PermanentBom, BomCategory } from '@/lib/permanent/bom';

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

export function PermanentBomPanel({ bom }: { bom: PermanentBom }) {
  const { lines, totals, flags } = bom;
  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: lines.filter((l) => l.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-sm text-gray-600 mb-3">
        <div className="flex justify-between gap-2">
          <dt>Total footage</dt>
          <dd className="text-gray-800 tabular-nums">{totals.totalFt} ft</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Lights</dt>
          <dd className="text-gray-800 tabular-nums">{totals.puckCount}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Corner singles</dt>
          <dd className="text-gray-800 tabular-nums">{totals.cornerSingles}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Track sections</dt>
          <dd className="text-gray-800 tabular-nums">{totals.trackSections}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Wholesale cost</dt>
          <dd className="text-gray-900 font-semibold tabular-nums">{money(totals.wholesaleCost)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Cost / ft</dt>
          <dd className="text-gray-800 tabular-nums">{money(totals.costPerFt)}</dd>
        </div>
      </dl>

      {flags.length > 0 && (
        <ul className="mb-3 text-xs text-amber-700 list-disc list-inside">
          {flags.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
            <th className="py-1 font-medium">SKU</th>
            <th className="py-1 font-medium">Item</th>
            <th className="py-1 font-medium text-right">Qty</th>
            <th className="py-1 font-medium text-right">Unit</th>
            <th className="py-1 font-medium text-right">Ext</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.cat}>
            <tr>
              <td colSpan={5} className="pt-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {CATEGORY_LABELS[g.cat]}
              </td>
            </tr>
            {g.items.map((l) => (
              <tr key={l.sku} className="border-t border-gray-100">
                <td className="py-1 font-mono text-xs text-gray-600 whitespace-nowrap">{l.sku}</td>
                <td className="py-1 text-gray-700">{l.description}</td>
                <td className="py-1 text-right tabular-nums text-gray-700">{l.qty}</td>
                <td className="py-1 text-right tabular-nums text-gray-500 whitespace-nowrap">{money(l.unitCost)}</td>
                <td className="py-1 text-right tabular-nums text-gray-700 whitespace-nowrap">{money(l.extCost)}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
