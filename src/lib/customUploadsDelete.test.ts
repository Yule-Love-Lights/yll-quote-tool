import { describe, it, expect, beforeEach, vi } from 'vitest';

// deleteCustomUpload (W2-028) — the .single() lookup used to treat ANY error
// (not-found OR a real transient DB failure) as "already gone" and return
// success. It must distinguish not-found (0 rows) from a real error, and
// surface the real error instead of silently swallowing it.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('./supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { deleteCustomUpload } from './customUploads';

function makeFake(opts: {
  lookup: { data: { path: string } | null; error: { message: string; code?: string } | null };
  removeError?: { message: string } | null;
  deleteError?: { message: string } | null;
}) {
  const calls = { removed: [] as string[][], deletedIds: [] as string[] };
  const client = {
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          calls.removed.push(paths);
          return { data: null, error: opts.removeError ?? null };
        },
      }),
    },
    from: (table: string) => {
      expect(table).toBe('custom_uploads');
      const b: Record<string, unknown> = {};
      let mode: 'select' | 'delete' = 'select';
      Object.assign(b, {
        select: () => {
          mode = 'select';
          return b;
        },
        delete: () => {
          mode = 'delete';
          return b;
        },
        eq: (_col: string, val: string) => {
          if (mode === 'delete') calls.deletedIds.push(val);
          return b;
        },
        single: async () => opts.lookup,
        then: (resolve: (v: unknown) => void) => resolve({ error: opts.deleteError ?? null }),
      });
      return b;
    },
  };
  return { client, calls };
}

beforeEach(() => {
  sbRef.current = null;
});

describe('deleteCustomUpload (W2-028)', () => {
  it('deletes the row + storage object on a normal hit', async () => {
    const fake = makeFake({ lookup: { data: { path: 'abc.png' }, error: null } });
    sbRef.current = fake.client;

    await deleteCustomUpload('id-1');

    expect(fake.calls.removed).toEqual([['abc.png']]);
    expect(fake.calls.deletedIds).toEqual(['id-1']);
  });

  it('treats a genuine not-found (no data, no error) as already-gone: no-op success', async () => {
    const fake = makeFake({ lookup: { data: null, error: null } });
    sbRef.current = fake.client;

    await expect(deleteCustomUpload('missing')).resolves.toBeUndefined();
    expect(fake.calls.removed).toHaveLength(0);
    expect(fake.calls.deletedIds).toHaveLength(0);
  });

  it('treats a PGRST116 (no rows) lookup error as already-gone: no-op success', async () => {
    const fake = makeFake({ lookup: { data: null, error: { message: 'no rows', code: 'PGRST116' } } });
    sbRef.current = fake.client;

    await expect(deleteCustomUpload('missing')).resolves.toBeUndefined();
    expect(fake.calls.removed).toHaveLength(0);
  });

  it('throws (does NOT silently succeed) on a real/transient lookup error', async () => {
    const fake = makeFake({ lookup: { data: null, error: { message: 'connection reset', code: '57P01' } } });
    sbRef.current = fake.client;

    await expect(deleteCustomUpload('id-1')).rejects.toThrow(/connection reset/i);
    expect(fake.calls.removed).toHaveLength(0);
    expect(fake.calls.deletedIds).toHaveLength(0);
  });
});
