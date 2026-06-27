// Tests for the design erasure path (audit fix: customer-photo-retention-deletion).
// Proves deleteDesign removes BOTH the row and every bucket object under the
// design's `{id}/` prefix, and that deleteDesignsForQuote fans out to the
// designs linked to a quote. Supabase service client is mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sbRef } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
}));

import { deleteDesign, deleteDesignsForQuote } from './designs';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Fake Supabase: records storage list/remove calls + row deletes.
function makeSb(opts: {
  // objects returned by storage.list(prefix)
  objects?: Array<{ name: string }>;
  listError?: { message: string } | null;
  removeError?: { message: string } | null;
  rowDeleteError?: { message: string } | null;
  // rows returned by from('designs').select('id').eq('quote_id', q)
  designRows?: Array<{ id: string }>;
}) {
  const calls = {
    listedPrefixes: [] as string[],
    removedPaths: [] as string[][],
    deletedIds: [] as string[],
  };

  const storage = {
    from: () => ({
      list: async (prefix: string) => {
        calls.listedPrefixes.push(prefix);
        return { data: opts.objects ?? [], error: opts.listError ?? null };
      },
      remove: async (paths: string[]) => {
        calls.removedPaths.push(paths);
        return { data: null, error: opts.removeError ?? null };
      },
    }),
  };

  // Table builder: supports .delete().eq() (awaited) and .select().eq() (awaited).
  function tableBuilder() {
    let mode: 'delete' | 'select' = 'select';
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      delete: () => {
        mode = 'delete';
        return b;
      },
      select: () => {
        mode = 'select';
        return b;
      },
      eq: (col: string, val: string) => {
        if (mode === 'delete') (b as { _deleteId?: string })._deleteId = val;
        return b;
      },
      then: (resolve: (v: unknown) => void) => {
        if (mode === 'delete') {
          calls.deletedIds.push((b as { _deleteId?: string })._deleteId ?? '');
          resolve({ error: opts.rowDeleteError ?? null });
        } else {
          resolve({ data: opts.designRows ?? [], error: null });
        }
      },
    });
    return b;
  }

  return {
    client: { storage, from: () => tableBuilder() },
    calls,
  };
}

describe('deleteDesign (audit fix: customer-photo-retention-deletion)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('removes both the bucket objects and the row', async () => {
    const { client, calls } = makeSb({
      objects: [{ name: 'photo.jpg' }, { name: 'satellite.png' }],
    });
    sbRef.current = client;

    const ok = await deleteDesign(ID);

    expect(ok).toBe(true);
    expect(calls.listedPrefixes).toEqual([ID]);
    expect(calls.removedPaths).toEqual([[`${ID}/photo.jpg`, `${ID}/satellite.png`]]);
    expect(calls.deletedIds).toEqual([ID]);
  });

  it('still deletes the row when there are no bucket objects', async () => {
    const { client, calls } = makeSb({ objects: [] });
    sbRef.current = client;

    const ok = await deleteDesign(ID);

    expect(ok).toBe(true);
    expect(calls.removedPaths).toEqual([]); // nothing to remove
    expect(calls.deletedIds).toEqual([ID]);
  });

  it('still deletes the row when storage removal fails (best-effort cleanup)', async () => {
    const { client, calls } = makeSb({
      objects: [{ name: 'photo.jpg' }],
      removeError: { message: 'boom' },
    });
    sbRef.current = client;

    const ok = await deleteDesign(ID);

    expect(ok).toBe(true);
    expect(calls.deletedIds).toEqual([ID]); // row still gone
  });

  it('reports failure when the row delete errors', async () => {
    const { client } = makeSb({
      objects: [],
      rowDeleteError: { message: 'db down' },
    });
    sbRef.current = client;

    const ok = await deleteDesign(ID);
    expect(ok).toBe(false);
  });

  it('returns false when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await deleteDesign(ID)).toBe(false);
  });
});

describe('deleteDesignsForQuote', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('deletes every design linked to the quote and returns the count', async () => {
    const id2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const { client, calls } = makeSb({
      designRows: [{ id: ID }, { id: id2 }],
      objects: [{ name: 'photo.jpg' }],
    });
    sbRef.current = client;

    const n = await deleteDesignsForQuote('quote-1');

    expect(n).toBe(2);
    expect(calls.deletedIds.sort()).toEqual([ID, id2].sort());
  });

  it('returns 0 when the quote has no linked designs', async () => {
    const { client } = makeSb({ designRows: [] });
    sbRef.current = client;
    expect(await deleteDesignsForQuote('quote-1')).toBe(0);
  });

  it('returns 0 when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await deleteDesignsForQuote('quote-1')).toBe(0);
  });
});
