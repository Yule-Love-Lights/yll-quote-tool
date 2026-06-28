import type { ReactNode } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import { listFulfillmentCards } from '@/lib/inventory/jobs';
import { listOnHand } from '@/lib/inventory/onHand';
import { lowStockItems } from '@/lib/inventory/lowStock';
import { buildSupplierPurchaseOrder } from '@/lib/inventory/purchaseOrder';
import { listCatalog } from '@/lib/inventory/catalog';
import { buildInventoryOverview } from '@/lib/inventory/inventoryOverview';

export const metadata = { title: 'Inventory — Yule Love Lights' };
// Live operational data (jobs, stock, shortfall) — never statically cache it.
export const dynamic = 'force-dynamic';

// Inventory landing = the Overview (#91): a glance at the job pipeline + what
// needs attention. Server-rendered: it reuses the existing data functions
// (fulfillment cards, low-stock, the purchase-order shortfall) and the pure
// buildInventoryOverview aggregator. Each source is fetched defensively so one
// failure degrades to an empty section instead of blanking the page.
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export default async function InventoryOverviewPage() {
  const [cards, onHand, po, catalog] = await Promise.all([
    safe(listFulfillmentCards(), []),
    safe(listOnHand(), []),
    safe(buildSupplierPurchaseOrder(), { lines: [], jobCount: 0 }),
    safe(listCatalog(), []),
  ]);

  const nameBySku = new Map(catalog.map((c) => [c.sku, c.name]));
  const lowStock = lowStockItems(onHand).map((l) => ({
    sku: l.sku,
    name: nameBySku.get(l.sku) ?? l.sku,
    onHand: l.onHand,
    reorderPoint: l.reorderPoint,
  }));

  const ov = buildInventoryOverview({
    cards,
    lowStock,
    toOrder: {
      lines: po.lines.map((l) => ({ sku: l.sku, name: l.name, order: l.order })),
      jobCount: po.jobCount,
    },
  });

  return (
    <OperatorShell active="inventory">
      <main className="max-w-[1100px] mx-auto">
        <InventorySubNav active="overview" />

        <div className="mb-5">
          <h1 className="text-xl font-semibold" style={{ color: 'var(--op-text)' }}>Inventory overview</h1>
          <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
            A glance at where jobs stand and what needs attention.
          </p>
        </div>

        {/* Job pipeline — one tile per fulfillment stage, click through to the board */}
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
            Job pipeline
          </h2>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${ov.stages.length}, minmax(0, 1fr))` }}>
            {ov.stages.map((s) => (
              <Link
                key={s.stage}
                href="/inventory/jobs"
                className="rounded-lg border p-4 transition-opacity hover:opacity-80"
                style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
              >
                <div className="text-3xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>{s.count}</div>
                <div className="mt-1 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
                  {s.label}
                </div>
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--op-text-dim)' }}>
            {ov.totalJobs === 0
              ? 'No active jobs yet — a job appears here once a deposit is paid.'
              : `${ov.totalJobs} active job${ov.totalJobs === 1 ? '' : 's'} in the pipeline.`}
          </p>
        </section>

        {/* Needs attention */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Low stock" href="/inventory/stock" linkLabel="Stock →">
            {ov.lowStock.total === 0 ? (
              <Empty>Everything&apos;s above its reorder point.</Empty>
            ) : (
              <>
                <ul>
                  {ov.lowStock.items.map((i) => (
                    <AttnRow
                      key={i.sku}
                      sku={i.sku}
                      name={i.name}
                      right={<span className="tabular-nums" style={{ color: '#b45309' }}>{i.onHand} / {i.reorderPoint}</span>}
                    />
                  ))}
                </ul>
                {ov.lowStock.total > ov.lowStock.items.length && (
                  <MoreLink n={ov.lowStock.total - ov.lowStock.items.length} href="/inventory/stock" />
                )}
              </>
            )}
          </Card>

          <Card title="Materials to order" href="/inventory/orders" linkLabel="Orders →">
            {ov.toOrder.total === 0 ? (
              <Empty>Nothing to order right now.</Empty>
            ) : (
              <>
                <p className="mb-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>
                  Shortfall across {ov.toOrder.jobCount} active job{ov.toOrder.jobCount === 1 ? '' : 's'}.
                </p>
                <ul>
                  {ov.toOrder.lines.map((l) => (
                    <AttnRow
                      key={l.sku}
                      sku={l.sku}
                      name={l.name}
                      right={<span className="tabular-nums" style={{ color: 'var(--op-text)' }}>order {l.order}</span>}
                    />
                  ))}
                </ul>
                {ov.toOrder.total > ov.toOrder.lines.length && (
                  <MoreLink n={ov.toOrder.total - ov.toOrder.lines.length} href="/inventory/orders" />
                )}
              </>
            )}
          </Card>
        </div>
      </main>
    </OperatorShell>
  );
}

function Card({ title, href, linkLabel, children }: { title: string; href: string; linkLabel: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border p-4" style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>{title}</h2>
        <Link href={href} className="text-xs font-medium hover:underline" style={{ color: 'var(--op-primary)' }}>{linkLabel}</Link>
      </div>
      {children}
    </section>
  );
}

function AttnRow({ sku, name, right }: { sku: string; name: string; right: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 border-t py-1.5 text-sm first:border-t-0" style={{ borderColor: 'var(--op-border)' }}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-mono text-xs" style={{ color: 'var(--op-text-dim)' }}>{sku}</span>
        <span className="truncate" style={{ color: 'var(--op-text)' }}>{name}</span>
      </span>
      <span className="shrink-0 text-xs">{right}</span>
    </li>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-sm" style={{ color: 'var(--op-text-dim)' }}>{children}</p>;
}

function MoreLink({ n, href }: { n: number; href: string }) {
  return (
    <Link href={href} className="mt-2 inline-block text-xs font-medium hover:underline" style={{ color: 'var(--op-primary)' }}>
      +{n} more →
    </Link>
  );
}
