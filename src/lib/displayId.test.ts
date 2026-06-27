import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the supabase module the same way designs.test.ts does: a controllable
// ref the test swaps per-case. displayId.ts imports getSupabaseServiceClient
// from './supabase'; '@/lib/supabase' resolves to the same file via the @ alias.
const { sbRef } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
}));

import { allocateNumber } from './displayId';

describe('allocateNumber', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('throws when the service client is not configured', async () => {
    sbRef.current = null;
    await expect(allocateNumber('quote_number_seq')).rejects.toThrow(/not configured/i);
  });

  it('returns the nextval the RPC hands back', async () => {
    const rpc = vi.fn(async () => ({ data: 1000, error: null }));
    sbRef.current = { rpc };
    const n = await allocateNumber('quote_number_seq');
    expect(n).toBe(1000);
    expect(rpc).toHaveBeenCalledWith('allocate_display_number', { seq_name: 'quote_number_seq' });
  });

  it('allocates monotonically across calls (sequence semantics)', async () => {
    let counter = 999;
    const rpc = vi.fn(async () => ({ data: ++counter, error: null }));
    sbRef.current = { rpc };
    const a = await allocateNumber('quote_number_seq');
    const b = await allocateNumber('quote_number_seq');
    const c = await allocateNumber('quote_number_seq');
    expect([a, b, c]).toEqual([1000, 1001, 1002]);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('coerces a bigint-as-string RPC result to a number', async () => {
    const rpc = vi.fn(async () => ({ data: '1005', error: null }));
    sbRef.current = { rpc };
    expect(await allocateNumber('quote_number_seq')).toBe(1005);
  });

  it('throws on an RPC error', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'sequence missing' } }));
    sbRef.current = { rpc };
    await expect(allocateNumber('quote_number_seq')).rejects.toThrow(/sequence missing/);
  });

  it('throws when the RPC returns a non-numeric value', async () => {
    const rpc = vi.fn(async () => ({ data: 'not-a-number', error: null }));
    sbRef.current = { rpc };
    await expect(allocateNumber('quote_number_seq')).rejects.toThrow(/non-numeric/i);
  });
});
