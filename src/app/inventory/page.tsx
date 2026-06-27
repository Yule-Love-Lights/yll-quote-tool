import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';

export const metadata = { title: 'Inventory — Yule Love Lights' };

// Placeholder for the future Inventory area (docs/dashboard/PLAN.md Phase 8):
// once a job is booked, auto-roll-up the material order (C9 bulbs, clips,
// mini-light strands, cords, stakes, wreaths, garland) from the quote's line
// items into purchase orders. Built later — this page reserves the nav slot.
export default function InventoryPage() {
  return (
    <OperatorShell active="inventory">
      <div className="max-w-3xl mx-auto w-full">
        <InventorySubNav active="stock" />
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
          Inventory
        </p>
        <h1 className="text-3xl font-semibold mb-3" style={{ color: 'var(--op-text)' }}>Inventory</h1>

        <div
          className="rounded-lg border p-6"
          style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
        >
          <p className="text-sm font-medium mb-2" style={{ color: 'var(--op-text)' }}>Coming soon.</p>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--op-text-dim)' }}>
            Once a quote is booked, this area will roll up the materials it needs — C9 bulbs, roofline
            clips, mini-light strands, extension cords, spritzer stakes, wreaths, and garland — into a
            purchase-order view, so ordering for the season is automatic from what was actually sold.
          </p>
        </div>
      </div>
    </OperatorShell>
  );
}
