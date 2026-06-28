import { OnHandStock } from '@/components/inventory/OnHandStock';

export const metadata = { title: 'Inventory — Stock — Yule Love Lights' };

// The warehouse on-hand Stock table (#82 Slice 1c). Moved here from /inventory
// when the Overview became the inventory landing (#91). OnHandStock self-renders
// the OperatorShell + sub-nav (active="stock").
export default function InventoryStockPage() {
  return <OnHandStock />;
}
