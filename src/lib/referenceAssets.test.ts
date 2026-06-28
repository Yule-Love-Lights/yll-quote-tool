import { describe, it, expect, beforeEach, vi } from 'vitest';

// #90 RLS hardening: referenceAssets.ts read/write paths must go through the
// RLS-bypassing SERVICE-ROLE client (preferring it over anon). reference_assets
// already has RLS enabled in prod, so the old pure-anon paths silently returned
// nothing / failed to write. These tests pin the service-role behavior.

const { serviceRef, anonRef } = vi.hoisted(() => ({
  serviceRef: { current: null as unknown },
  anonRef: { current: null as unknown },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => serviceRef.current,
  getSupabaseClient: () => anonRef.current,
}));

import { saveReferenceAsset, getReferenceAssetsForAnalysis } from './referenceAssets';

function makeFake() {
  const fromCalls: string[] = [];
  const builder: Record<string, unknown> = {};
  const ret = () => builder;
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) {
    builder[m] = ret;
  }
  builder.single = async () => ({ data: { id: 'new-id' }, error: null });
  builder.maybeSingle = async () => ({ data: { id: 'new-id' }, error: null });
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  const client = {
    from: (t: string) => {
      fromCalls.push(t);
      return builder;
    },
    rpc: async () => ({ data: 1, error: null }),
  };
  return { client, fromCalls };
}

beforeEach(() => {
  serviceRef.current = null;
  anonRef.current = null;
});

describe('saveReferenceAsset', () => {
  it('writes through the service-role client when configured (RLS-safe)', async () => {
    const service = makeFake();
    const anon = makeFake();
    serviceRef.current = service.client;
    anonRef.current = anon.client;

    const res = await saveReferenceAsset({
      assetType: 'wreath',
      size: '24',
      base64: 'x',
      mediaType: 'image/png',
    });

    expect(res).toEqual({ id: 'new-id' });
    expect(service.fromCalls).toContain('reference_assets');
    expect(anon.fromCalls).not.toContain('reference_assets');
  });

  it('returns null when Supabase is unconfigured', async () => {
    expect(
      await saveReferenceAsset({ assetType: 'wreath', size: '24', base64: 'x', mediaType: 'image/png' }),
    ).toBeNull();
  });
});

describe('getReferenceAssetsForAnalysis', () => {
  it('reads through the service-role client when configured (RLS-safe)', async () => {
    const service = makeFake();
    const anon = makeFake();
    serviceRef.current = service.client;
    anonRef.current = anon.client;

    await getReferenceAssetsForAnalysis();

    expect(service.fromCalls).toContain('reference_assets');
    expect(anon.fromCalls).not.toContain('reference_assets');
  });
});
