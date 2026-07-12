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

import { saveTrainingHouse, getTrainingFewShot, getTrainingHouseGroundTruthPairs } from './training';
import type { TrainingHousePayload } from './training';
import type { AiSnapshot } from './training/knownVsAi';

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

// ─── #109 Phase 2: operator_known_numbers save + fail-open ─────────────────

const AI_SNAPSHOT: AiSnapshot = {
  miniLights: 5, wreaths: 2, spritzers: 1, garland: 0, santasFootage: 40, gingerbreadFootage: 20,
};

describe('saveTrainingHouse — operator_known_numbers (#109 Phase 2)', () => {
  it('a legacy payload (no operatorKnownNumbers) never references the new column and returns exactly {id} (byte-for-byte)', async () => {
    const service = makeFake();
    serviceRef.current = service.client;
    let inserted: Record<string, unknown> | undefined;
    service.client.from = ((t: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) builder[m] = () => builder;
      builder.insert = (row: Record<string, unknown>) => { inserted = row; return builder; };
      builder.single = async () => ({ data: { id: 'new-id' }, error: null });
      void t;
      return builder;
    }) as typeof service.client.from;

    const res = await saveTrainingHouse(PAYLOAD);

    expect(res).toEqual({ id: 'new-id' });
    expect(inserted).toBeDefined();
    expect('operator_known_numbers' in inserted!).toBe(false);
  });

  it('persists known + aiSnapshot + computed misses, and returns {id, misses}', async () => {
    const service = makeFake();
    serviceRef.current = service.client;
    let inserted: Record<string, unknown> | undefined;
    service.client.from = ((t: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) builder[m] = () => builder;
      builder.insert = (row: Record<string, unknown>) => { inserted = row; return builder; };
      builder.single = async () => ({ data: { id: 'new-id' }, error: null });
      void t;
      return builder;
    }) as typeof service.client.from;

    const res = await saveTrainingHouse({
      ...PAYLOAD,
      operatorKnownNumbers: { known: { wreaths: 5 }, aiSnapshot: AI_SNAPSHOT },
    });

    expect(res).toEqual({ id: 'new-id', misses: [{ type: 'wreaths', ai: 2, known: 5, big: true }] });
    const okn = inserted!.operator_known_numbers as Record<string, unknown>;
    expect(okn.known).toEqual({ wreaths: 5 });
    expect(okn.aiSnapshot).toEqual(AI_SNAPSHOT);
    expect(okn.misses).toEqual([{ type: 'wreaths', ai: 2, known: 5, big: true }]);
  });

  it('persists an aiSnapshot-only save (Auto-Analyze ran, operator recorded nothing) with no misses key returned', async () => {
    const service = makeFake();
    serviceRef.current = service.client;
    let inserted: Record<string, unknown> | undefined;
    service.client.from = ((t: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) builder[m] = () => builder;
      builder.insert = (row: Record<string, unknown>) => { inserted = row; return builder; };
      builder.single = async () => ({ data: { id: 'new-id' }, error: null });
      void t;
      return builder;
    }) as typeof service.client.from;

    const res = await saveTrainingHouse({ ...PAYLOAD, operatorKnownNumbers: { aiSnapshot: AI_SNAPSHOT } });

    expect(res).toEqual({ id: 'new-id' }); // no `misses` key — nothing to compare
    const okn = inserted!.operator_known_numbers as Record<string, unknown>;
    expect(okn.aiSnapshot).toEqual(AI_SNAPSHOT);
    expect(okn.known).toBeUndefined();
    expect(okn.misses).toBeUndefined();
  });

  // FAIL-OPEN: the operator_known_numbers column may not be migrated yet on
  // this environment. The first insert attempt (which references the column)
  // fails with an undefined-column error; the save must retry WITHOUT the
  // column and still succeed — mirroring the S25 permanent-training-loop
  // degrade-on-missing-column/table pattern.
  it.each(['42703', 'PGRST204'])('fails open and retries without the column on a %s undefined-column error', async (code) => {
    const service = makeFake();
    serviceRef.current = service.client;
    const insertedRows: Record<string, unknown>[] = [];
    let attempt = 0;
    service.client.from = ((t: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) builder[m] = () => builder;
      builder.insert = (row: Record<string, unknown>) => { insertedRows.push(row); return builder; };
      builder.single = async () => {
        attempt += 1;
        if (attempt === 1) {
          return { data: null, error: { code, message: 'column training_houses.operator_known_numbers does not exist' } };
        }
        return { data: { id: 'new-id' }, error: null };
      };
      void t;
      return builder;
    }) as typeof service.client.from;

    const res = await saveTrainingHouse({
      ...PAYLOAD,
      operatorKnownNumbers: { known: { wreaths: 5 }, aiSnapshot: AI_SNAPSHOT },
    });

    // Still succeeds, and the readout is still computed/returned even though
    // it wasn't persisted this time.
    expect(res).toEqual({ id: 'new-id', misses: [{ type: 'wreaths', ai: 2, known: 5, big: true }] });
    expect(insertedRows).toHaveLength(2);
    expect('operator_known_numbers' in insertedRows[0]).toBe(true); // first attempt tried it
    expect('operator_known_numbers' in insertedRows[1]).toBe(false); // retry omits it
  });

  it('surfaces a real (non-column) DB error as null, without retrying', async () => {
    const service = makeFake();
    serviceRef.current = service.client;
    let attempts = 0;
    service.client.from = (() => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) builder[m] = () => builder;
      builder.insert = () => builder;
      builder.single = async () => { attempts += 1; return { data: null, error: { code: '23505', message: 'duplicate key' } }; };
      return builder;
    }) as typeof service.client.from;

    const res = await saveTrainingHouse({
      ...PAYLOAD,
      operatorKnownNumbers: { known: { wreaths: 5 }, aiSnapshot: AI_SNAPSHOT },
    });

    expect(res).toBeNull();
    expect(attempts).toBe(1); // no retry for a non-undefined-column error
  });
});

describe('getTrainingHouseGroundTruthPairs (#109 Phase 2)', () => {
  it('returns [] when Supabase is unconfigured', async () => {
    expect(await getTrainingHouseGroundTruthPairs()).toEqual([]);
  });

  it('returns only rows with BOTH known + aiSnapshot, skipping partial/null rows', async () => {
    const service = makeFake();
    serviceRef.current = service.client;
    service.client.from = (() => {
      const builder: Record<string, unknown> = {};
      for (const m of ['not', 'order', 'limit']) builder[m] = () => builder;
      builder.select = () => builder;
      builder.then = (resolve: (v: unknown) => void) => resolve({
        data: [
          { operator_known_numbers: { known: { wreaths: 5 }, aiSnapshot: AI_SNAPSHOT } },
          { operator_known_numbers: { aiSnapshot: AI_SNAPSHOT } }, // no known — skipped
          { operator_known_numbers: { known: { wreaths: 3 } } }, // no aiSnapshot — skipped
          { operator_known_numbers: null }, // skipped
        ],
        error: null,
      });
      return builder;
    }) as typeof service.client.from;

    const pairs = await getTrainingHouseGroundTruthPairs();

    expect(pairs).toEqual([{ known: { wreaths: 5 }, aiSnapshot: AI_SNAPSHOT }]);
  });

  it.each(['42703', 'PGRST204'])('fails open to [] on a %s undefined-column error', async (code) => {
    const service = makeFake();
    serviceRef.current = service.client;
    service.client.from = (() => {
      const builder: Record<string, unknown> = {};
      for (const m of ['not', 'order', 'limit']) builder[m] = () => builder;
      builder.select = () => builder;
      builder.then = (resolve: (v: unknown) => void) => resolve({
        data: null,
        error: { code, message: 'column training_houses.operator_known_numbers does not exist' },
      });
      return builder;
    }) as typeof service.client.from;

    expect(await getTrainingHouseGroundTruthPairs()).toEqual([]);
  });
});
