import { beforeEach, describe, expect, it, vi } from 'vitest';

// Campaign rate config is MONEY: rate_cents is the per-accepted-yard-sign
// rate that gets stamped onto placements at acceptance. These tests pin the
// $2.50 default and the integer-cents guard.

type AnyRow = Record<string, unknown>;

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      rows: [] as AnyRow[],
      inserted: [] as AnyRow[],
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));

function makeDb() {
  return {
    from(_table: string) {
      return {
        select(_cols?: string) {
          const filters: Array<(r: AnyRow) => boolean> = [];
          const b = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val);
              return b;
            },
            maybeSingle() {
              const found = stateRef.current.rows.filter((r) => filters.every((f) => f(r)));
              return Promise.resolve({ data: found[0] ?? null, error: null });
            },
            order(_col: string, _opts?: unknown) {
              return Promise.resolve({
                data: stateRef.current.rows.filter((r) => filters.every((f) => f(r))),
                error: null,
              });
            },
          };
          return b;
        },
        insert(payload: AnyRow) {
          const row = {
            id: `campaign-${stateRef.current.rows.length + 1}`,
            notes: null,
            active: true,
            is_test: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...payload,
          };
          stateRef.current.rows.push(row);
          stateRef.current.inserted.push(payload);
          return {
            select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
          };
        },
        update(payload: AnyRow) {
          const filters: Array<(r: AnyRow) => boolean> = [];
          const ub = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val);
              return ub;
            },
            select(_cols?: string) {
              return {
                maybeSingle: () => {
                  const idx = stateRef.current.rows.findIndex((r) => filters.every((f) => f(r)));
                  if (idx === -1) return Promise.resolve({ data: null, error: null });
                  stateRef.current.rows[idx] = { ...stateRef.current.rows[idx], ...payload };
                  return Promise.resolve({ data: stateRef.current.rows[idx], error: null });
                },
              };
            },
          };
          return ub;
        },
      };
    },
  };
}

beforeEach(() => {
  stateRef.current.rows = [];
  stateRef.current.inserted = [];
  dbRef.current = makeDb();
});

describe('createAdvertisingCampaign', () => {
  it('defaults the rate to 250 cents ($2.50 per accepted yard sign, Naldo 2026-08-27)', async () => {
    const { createAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    expect(campaign.rateCents).toBe(250);
    expect(stateRef.current.inserted[0].rate_cents).toBe(250);
  });

  it('refuses a negative or fractional-cent rate', async () => {
    const { createAdvertisingCampaign } = await import('./campaigns');
    await expect(createAdvertisingCampaign({ name: 'Bad', rateCents: -1 })).rejects.toThrow(/rate/i);
    await expect(createAdvertisingCampaign({ name: 'Bad', rateCents: 250.5 })).rejects.toThrow(/rate/i);
  });
});

describe('updateAdvertisingCampaign', () => {
  it('patches the rate in integer cents and refuses bad rates', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });

    const updated = await updateAdvertisingCampaign(campaign.id, { rateCents: 300 });
    expect(updated?.rateCents).toBe(300);

    await expect(updateAdvertisingCampaign(campaign.id, { rateCents: 1.5 })).rejects.toThrow(/rate/i);
  });
});
