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

  // W5-028: aiFailureNotes is injected raw into a synthetic assistant message
  // the analyzer imitates as ground truth — cap length + strip control chars
  // so an oversized/control-char-laden write can't poison the corpus text.
  it('caps + strips control characters from aiFailureNotes/notes/houseStyle/address before insert', async () => {
    const service = makeFake();
    serviceRef.current = service.client;
    let inserted: Record<string, unknown> | undefined;
    service.client.from = ((t: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.insert = (row: Record<string, unknown>) => {
        inserted = row;
        return builder;
      };
      builder.single = async () => ({ data: { id: 'new-id' }, error: null });
      void t;
      return builder;
    }) as typeof service.client.from;

    const longNote = 'x'.repeat(5000);
    await saveTrainingHouse({
      ...PAYLOAD,
      aiFailureNotes: `bad\x00data\x07${longNote}`,
      notes: `note\x01here${longNote}`,
      houseStyle: `style\x02${longNote}`,
      address: `addr\x03${longNote}`,
    });

    expect(inserted).toBeDefined();
    for (const key of ['ai_failure_notes', 'notes', 'house_style', 'address'] as const) {
      const v = inserted![key] as string;
      expect(v.length).toBeLessThanOrEqual(2000);
      expect(v).not.toMatch(/[\x00-\x1f]/);
    }
  });

  it('leaves short, clean text fields untouched', async () => {
    const service = makeFake();
    serviceRef.current = service.client;
    let inserted: Record<string, unknown> | undefined;
    service.client.from = ((t: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.insert = (row: Record<string, unknown>) => {
        inserted = row;
        return builder;
      };
      builder.single = async () => ({ data: { id: 'new-id' }, error: null });
      void t;
      return builder;
    }) as typeof service.client.from;

    await saveTrainingHouse({ ...PAYLOAD, notes: 'clean note', houseStyle: 'Colonial', address: '1 Main St' });

    expect(inserted!.notes).toBe('clean note');
    expect(inserted!.house_style).toBe('Colonial');
    expect(inserted!.address).toBe('1 Main St');
  });

  // #167 slice 3: source is written explicitly on every insert rather than left
  // to the column default, so an archive promotion that forgets it can't land a
  // satellite-traced house in the ground-photo few-shot pool.
  it.each([
    ['defaults to manual when unset', undefined, 'manual'],
    ['stamps archive when the promote path passes it', 'archive' as const, 'archive'],
  ])('%s', async (_label, source, expected) => {
    const service = makeFake();
    serviceRef.current = service.client;
    let inserted: Record<string, unknown> | undefined;
    service.client.from = ((t: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.insert = (row: Record<string, unknown>) => {
        inserted = row;
        return builder;
      };
      builder.single = async () => ({ data: { id: 'new-id' }, error: null });
      void t;
      return builder;
    }) as typeof service.client.from;

    await saveTrainingHouse({ ...PAYLOAD, ...(source ? { source } : {}) });

    expect(inserted!.source).toBe(expected);
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

  // #167 slice 3 — corpus isolation. Archive houses are traced on overhead
  // satellites; analyzePhoto presents few-shot exemplars to the model as ground
  // truth whose coordinate style it should match, so serving one for a
  // ground-level customer photo teaches the wrong geometry. The pool must be
  // filtered POSITIVELY to 'manual' so a future source value can't inherit
  // ground-photo retrieval by default.
  it('restricts the few-shot pool to manual (ground-level) houses', async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const service = makeFake();
    serviceRef.current = service.client;
    service.client.from = ((t: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'is', 'not', 'in', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.eq = (col: string, val: unknown) => {
        eqCalls.push([col, val]);
        return builder;
      };
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      void t;
      return builder;
    }) as typeof service.client.from;

    await getTrainingFewShot();

    expect(eqCalls).toContainEqual(['source', 'manual']);
  });
});
