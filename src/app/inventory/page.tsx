import { OnHandStock } from '@/components/inventory/OnHandStock';

export const metadata = { title: 'Inventory — Yule Love Lights' };

// The Inventory "Stock" page (#82 Slice 1c): the warehouse on-hand stock table.
// Thin server wrapper (keeps the page title) around the client table component.
export default function InventoryPage() {
  return <OnHandStock />;
}
