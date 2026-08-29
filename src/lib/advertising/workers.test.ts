import { beforeEach, describe, expect, it, vi } from 'vitest';

// Workers are their OWN population (Naldo 2026-08-27): identity rows here,
// never crew_members. These tests pin the identity guards: normalized-unique
// display names (recover the winner on a create race, the insertCrewMember
// pattern) and the one-login-one-payee auth link.

type AnyRow = Record<string, unknown>;
type DbError = { code?: string; message: string };

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      rows: [] as AnyRow[],
      insertError: null as DbError | null,
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
            ilike(col: string, val: string) {
              filters.push((r) => String(r[col]).toLowerCase() === val.toLowerCase());
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
          const err = stateRef.current.insertError;
          let row: AnyRow | null = null;
          if (!err) {
            row = {
              id: `worker-${stateRef.current.rows.length + 1}`,
              auth_user_id: null,
              active: true,
              is_test: false,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload,
            };
            stateRef.current.rows.push(row);
            stateRef.current.inserted.push(payload);
          }
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: err ? null : row, error: err }),
            }),
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
  stateRef.current.insertError = null;
  stateRef.current.inserted = [];
  dbRef.current = makeDb();
});

describe('createAdvertisingWorker', () => {
  it('trims the display name and returns the created worker', async () => {
    const { createAdvertisingWorker } = await import('./workers');
    const worker = await createAdvertisingWorker({ displayName: '  Joe Signs  ' });
    expect(worker.displayName).toBe('Joe Signs');
    expect(worker.active).toBe(true);
    expect(worker.authUserId).toBeNull();
    expect(stateRef.current.inserted[0].display_name).toBe('Joe Signs');
  });

  it('recovers the winner when two concurrent creates race on the same name', async () => {
    const { createAdvertisingWorker } = await import('./workers');
    stateRef.current.rows.push({
      id: 'worker-existing',
      display_name: 'joe signs',
      auth_user_id: null,
      active: true,
      is_test: false,
      created_at: '2026-08-20T12:00:00.000Z',
      updated_at: '2026-08-20T12:00:00.000Z',
    });
    stateRef.current.insertError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "advertising_workers_display_name_key"',
    };

    const worker = await createAdvertisingWorker({ displayName: 'Joe Signs' });
    expect(worker.id).toBe('worker-existing');
  });

  it('surfaces a login-already-linked conflict as its own error', async () => {
    const { createAdvertisingWorker, WorkerLoginTakenError } = await import('./workers');
    stateRef.current.insertError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "advertising_workers_auth_user_id_key"',
    };
    await expect(
      createAdvertisingWorker({ displayName: 'New Guy', authUserId: 'auth-1' }),
    ).rejects.toThrow(WorkerLoginTakenError);
  });
});

describe('lookups', () => {
  it('finds a worker by auth user id', async () => {
    const { createAdvertisingWorker, getAdvertisingWorkerByAuthUserId } = await import('./workers');
    await createAdvertisingWorker({ displayName: 'Linked', authUserId: 'auth-9' });
    const found = await getAdvertisingWorkerByAuthUserId('auth-9');
    expect(found?.displayName).toBe('Linked');
    expect(await getAdvertisingWorkerByAuthUserId('auth-missing')).toBeNull();
  });

  it('setAdvertisingWorkerActive flips the flag', async () => {
    const { createAdvertisingWorker, setAdvertisingWorkerActive } = await import('./workers');
    const worker = await createAdvertisingWorker({ displayName: 'Flip' });
    const off = await setAdvertisingWorkerActive(worker.id, false);
    expect(off?.active).toBe(false);
  });
});
