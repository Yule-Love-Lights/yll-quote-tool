// Writing the rate history — ledger row 506.
//
// The pure resolver has its own file (crewMemberRates.test.ts). This one is
// about the two things the WRITES have to guarantee, both of which are
// invariants rather than behaviours:
//
//   1. `crew_members.base_rate_cents` is DERIVED. Every write recomputes it
//      from the history, so the number ~40 screens display and the number the
//      money maths resolves against can never name different figures.
//   2. No edit may leave TODAY without a rate. That is what makes (1) an
//      invariant instead of something that holds until somebody deletes the
//      wrong row.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type RateRow = {
  id: string;
  crew_member_id: string;
  rate_cents_per_hour: number;
  effective_from: string;
  created_at: string;
  created_by: string | null;
};

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      rates: [] as RateRow[],
      crew: [] as { id: string; base_rate_cents: number }[],
      seq: 0,
    },
  },
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));

function makeDb() {
  return {
    from(table: string) {
      if (table === 'crew_member_rates') {
        let list = [...stateRef.current.rates];
        const b = {
          select: () => b,
          upsert: (payload: Record<string, unknown>) => {
            const i = stateRef.current.rates.findIndex(
              (r) =>
                r.crew_member_id === payload.crew_member_id &&
                r.effective_from === payload.effective_from,
            );
            if (i >= 0) {
              stateRef.current.rates[i] = {
                ...stateRef.current.rates[i]!,
                rate_cents_per_hour: Number(payload.rate_cents_per_hour),
                created_by: (payload.created_by as string | null) ?? null,
              };
            } else {
              stateRef.current.seq += 1;
              stateRef.current.rates.push({
                id: `rate-${stateRef.current.seq}`,
                crew_member_id: String(payload.crew_member_id),
                rate_cents_per_hour: Number(payload.rate_cents_per_hour),
                effective_from: String(payload.effective_from),
                created_at: '2026-09-04T00:00:00.000Z',
                created_by: (payload.created_by as string | null) ?? null,
              });
            }
            return Promise.resolve({ error: null });
          },
          delete: () => {
            const filters: [string, unknown][] = [];
            const d = {
              eq: (col: string, val: unknown) => {
                filters.push([col, val]);
                if (filters.length === 2) {
                  stateRef.current.rates = stateRef.current.rates.filter(
                    (r) => !filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v),
                  );
                  return Promise.resolve({ error: null });
                }
                return d;
              },
            };
            return d;
          },
          eq: (col: string, val: unknown) => {
            list = list.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
            return b;
          },
          order: () =>
            Promise.resolve({
              data: [...list].sort((x, y) => (x.effective_from < y.effective_from ? -1 : 1)),
              error: null,
            }),
        };
        return b as never;
      }

      if (table === 'crew_members') {
        let list = [...stateRef.current.crew];
        const b = {
          select: () => b,
          eq: (col: string, val: unknown) => {
            list = list.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
            return b;
          },
          maybeSingle: () => Promise.resolve({ data: list[0] ? { ...list[0] } : null, error: null }),
          update: (payload: Record<string, unknown>) => {
            const chain = {
              eq: (col: string, val: unknown) => {
                const row = stateRef.current.crew.find(
                  (r) => (r as unknown as Record<string, unknown>)[col] === val,
                );
                if (row && payload.base_rate_cents !== undefined) {
                  row.base_rate_cents = Number(payload.base_rate_cents);
                }
                return {
                  select: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: row ? { ...row } : null, error: null }),
                  }),
                };
              },
            };
            return chain;
          },
        };
        return b as never;
      }

      throw new Error(`crewMemberRatesWrites.test.ts: unexpected table ${table}`);
    },
  };
}

beforeEach(() => {
  stateRef.current = {
    rates: [
      {
        id: 'seed',
        crew_member_id: 'crew-1',
        rate_cents_per_hour: 1600,
        effective_from: '2000-01-01',
        created_at: '2000-01-01T00:00:00.000Z',
        created_by: 'backfill',
      },
    ],
    crew: [{ id: 'crew-1', base_rate_cents: 1600 }],
    seq: 0,
  };
  dbRef.current = makeDb();
});

import { RateRefusedError, deleteRate, setRateFrom } from './crewMemberRates';

const NOW = '2026-09-04T15:00:00.000Z'; // 11:00 ET on 4 Sep 2026

describe('setRateFrom keeps the column derived', () => {
  it('moves base_rate_cents when the new rate starts today or earlier', async () => {
    await setRateFrom({
      crewMemberId: 'crew-1',
      rateCentsPerHour: 1800,
      effectiveFrom: '2026-09-01',
      nowIso: NOW,
    });
    expect(stateRef.current.crew[0]!.base_rate_cents).toBe(1800);
  });

  it('leaves it ALONE for a raise that has not started yet', async () => {
    // A rate scheduled ahead of time must not change what the person is paid
    // today, on any screen.
    await setRateFrom({
      crewMemberId: 'crew-1',
      rateCentsPerHour: 2000,
      effectiveFrom: '2099-01-01',
      nowIso: NOW,
    });
    expect(stateRef.current.crew[0]!.base_rate_cents).toBe(1600);
  });

  it('corrects a day rather than adding a second row for it', async () => {
    await setRateFrom({
      crewMemberId: 'crew-1',
      rateCentsPerHour: 1000,
      effectiveFrom: '2000-01-01',
      nowIso: NOW,
    });
    expect(stateRef.current.rates).toHaveLength(1);
    expect(stateRef.current.rates[0]!.rate_cents_per_hour).toBe(1000);
    // ...and the column follows it down, because it is derived.
    expect(stateRef.current.crew[0]!.base_rate_cents).toBe(1000);
  });

  it('refuses a rate of zero or a day that does not exist', async () => {
    await expect(
      setRateFrom({ crewMemberId: 'crew-1', rateCentsPerHour: 0, effectiveFrom: '2026-09-01' }),
    ).rejects.toBeInstanceOf(RateRefusedError);
    await expect(
      setRateFrom({ crewMemberId: 'crew-1', rateCentsPerHour: 1600, effectiveFrom: '2026-02-31' }),
    ).rejects.toBeInstanceOf(RateRefusedError);
    // Nothing was written on either refusal.
    expect(stateRef.current.rates).toHaveLength(1);
  });

  it('refuses a person who does not exist rather than orphaning a rate row', async () => {
    await expect(
      setRateFrom({ crewMemberId: 'nobody', rateCentsPerHour: 1600, effectiveFrom: '2026-09-01' }),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(stateRef.current.rates).toHaveLength(1);
  });
});

describe('deleteRate will not leave a day uncovered', () => {
  it('refuses to remove the only rate on record', async () => {
    await expect(
      deleteRate({ crewMemberId: 'crew-1', rateId: 'seed', nowIso: NOW }),
    ).rejects.toMatchObject({ reason: 'last-rate' });
    expect(stateRef.current.rates).toHaveLength(1);
  });

  it('refuses to remove the row that covers TODAY, even when another row exists', async () => {
    // THE case the count test cannot see: a future-dated raise is on file, so
    // there are two rows and removing the current one passes "more than one"
    // while leaving the present with no rate at all. base_rate_cents would
    // then keep its old value with nothing in the history supporting it, and
    // every screen reading it would go on showing a figure that had silently
    // stopped being true (admin lens on PR #1214).
    await setRateFrom({
      crewMemberId: 'crew-1',
      rateCentsPerHour: 2000,
      effectiveFrom: '2099-01-01',
      nowIso: NOW,
    });
    await expect(
      deleteRate({ crewMemberId: 'crew-1', rateId: 'seed', nowIso: NOW }),
    ).rejects.toMatchObject({ reason: 'uncovers-today' });
    expect(stateRef.current.rates).toHaveLength(2);
    expect(stateRef.current.crew[0]!.base_rate_cents).toBe(1600);
  });

  it('allows removing a row that is not the one covering today', async () => {
    await setRateFrom({
      crewMemberId: 'crew-1',
      rateCentsPerHour: 1300,
      effectiveFrom: '2026-08-12',
      nowIso: NOW,
    });
    const added = stateRef.current.rates.find((r) => r.effective_from === '2026-08-12')!;
    // 12 Aug is the newest row that has started, so it IS today's — remove
    // the older one instead, which changes nothing about today.
    await deleteRate({ crewMemberId: 'crew-1', rateId: 'seed', nowIso: NOW });
    expect(stateRef.current.rates.map((r) => r.id)).toEqual([added.id]);
    expect(stateRef.current.crew[0]!.base_rate_cents).toBe(1300);
  });

  it('refuses a rate that belongs to somebody else', async () => {
    await expect(
      deleteRate({ crewMemberId: 'crew-1', rateId: 'not-theirs', nowIso: NOW }),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(stateRef.current.rates).toHaveLength(1);
  });
});
