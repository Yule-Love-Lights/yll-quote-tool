import { describe, it, expect, beforeEach, vi } from 'vitest';

// #90 RLS hardening: training.ts read/write paths must go through the RLS-bypassing
// SERVICE-ROLE client (preferring it over anon). training_houses holds PII (address
// + house photos) and already has RLS enabled in prod, so the old pure-anon paths
// were silently returning nothing. These tests pin the service-role behavior.

const { serviceRef, anonRef } = vi.hoisted(() => ({
  serviceRef: { current: null as unknown },
  anonRef: { current: null as unknown },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => serviceRef.current,
  getSupabaseClient: () => anonRef.current,
}));

import { saveTrainingHouse, getTrainingFewShot } from './training';
import type { TrainingHousePayload } from './training';

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

const PAYLOAD: TrainingHousePayload = {
  photos: [],
  santasLines: [],
  gingerbreadLines: [],
  miniLightDetections: [],
  spritzers: [],
  wreaths: [],
  garland: [],
};

beforeEach(() => {
  serviceRef.current = null;
  anonRef.current = null;
});

describe('saveTrainingHouse', () => {
  it('writes through the service-role client when configured (RLS-safe)', async () => {
    const service = makeFake();
    const anon = makeFake();
    serviceRef.current = service.client;
    anonRef.current = anon.client;

    const res = await saveTrainingHouse(PAYLOAD);

    expect(res).toEqual({ id: 'new-id' });
    expect(service.fromCalls).toContain('training_houses');
    expect(anon.fromCalls).not.toContain('training_houses');
  });

  it('returns null when Supabase is unconfigured', async () => {
    expect(await saveTrainingHouse(PAYLOAD)).toBeNull();
  });
});

describe('getTrainingFewShot', () => {
  it('reads through the service-role client when configured (RLS-safe)', async () => {
    const service = makeFake();
    const anon = makeFake();
    serviceRef.current = service.client;
    anonRef.current = anon.client;

    await getTrainingFewShot();

    expect(service.fromCalls).toContain('training_houses');
    expect(anon.fromCalls).not.toContain('training_houses');
  });
});
