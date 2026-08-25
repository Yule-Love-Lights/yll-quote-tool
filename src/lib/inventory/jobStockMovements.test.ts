// Row 386 (renamed row 397): recordJobStockMovements is the durable,
// append-only audit trail that survives the jobs-row snapshot the cancel
// route deliberately clears. Pure wiring tests — the two real callers
// (prepareJobMaterials, the cancel route) are covered in their own test
// files.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordJobStockMovements } from './jobStockMovements';

function makeDb(onInsert?: (table: string, rows: unknown[]) => { error: unknown } | void) {
  return {
    from(table: string) {
      return {
        async insert(rows: unknown[]) {
          const result = onInsert?.(table, rows);
          return { error: result?.error ?? null };
        },
      };
    },
  } as unknown as Parameters<typeof recordJobStockMovements>[0];
}

describe('recordJobStockMovements', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('no-ops (no insert call) when there is nothing to record', async () => {
    let called = false;
    const db = makeDb(() => {
      called = true;
    });
    await recordJobStockMovements(db, 'job-1', 'prep', []);
    expect(called).toBe(false);
  });

  it('inserts one row per movement, tagged with job_id + reason, signed qty_delta preserved', async () => {
    const inserted: unknown[] = [];
    const db = makeDb((table, rows) => {
      expect(table).toBe('job_stock_movements');
      inserted.push(...rows);
    });
    await recordJobStockMovements(db, 'job-1', 'prep', [
      { sku: 'SKU-A', qtyDelta: -2, before: 10, after: 8 },
      { sku: 'SKU-B', qtyDelta: -1, before: 5, after: 4 },
    ]);
    expect(inserted).toEqual([
      { job_id: 'job-1', sku: 'SKU-A', qty_delta: -2, before_qty: 10, after_qty: 8, reason: 'prep' },
      { job_id: 'job-1', sku: 'SKU-B', qty_delta: -1, before_qty: 5, after_qty: 4, reason: 'prep' },
    ]);
  });

  it('tags cancel_reversal rows distinctly from prep rows', async () => {
    const inserted: unknown[] = [];
    const db = makeDb((_table, rows) => {
      inserted.push(...rows);
    });
    await recordJobStockMovements(db, 'job-2', 'cancel_reversal', [
      { sku: 'SKU-A', qtyDelta: 2, before: 8, after: 10 },
    ]);
    expect(inserted).toEqual([
      { job_id: 'job-2', sku: 'SKU-A', qty_delta: 2, before_qty: 8, after_qty: 10, reason: 'cancel_reversal' },
    ]);
  });

  it('logs and does not throw when the insert reports an error', async () => {
    const db = makeDb(() => ({ error: { message: 'connection reset' } }));
    await expect(
      recordJobStockMovements(db, 'job-1', 'prep', [{ sku: 'SKU-A', qtyDelta: -1, before: 5, after: 4 }]),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it('logs and does not throw when the insert call itself throws', async () => {
    const db = {
      from() {
        return {
          async insert() {
            throw new Error('network down');
          },
        };
      },
    } as unknown as Parameters<typeof recordJobStockMovements>[0];
    await expect(
      recordJobStockMovements(db, 'job-1', 'prep', [{ sku: 'SKU-A', qtyDelta: -1, before: 5, after: 4 }]),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});
