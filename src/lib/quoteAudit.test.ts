import { describe, it, expect, vi, beforeEach } from 'vitest';
import { casSwapApprovalSnapshot, appendQuoteAuditEntry } from './quoteAudit';

// Row 411 — the one shared approval_snapshot CAS write. approval_snapshot is
// the frozen customer agreement, and the bug this module exists to prevent
// shipped once already (an unconfirmed read coerced to {} and written back,
// REPLACING the agreement). The fake below therefore models the two things a
// real PostgREST round-trip actually does that a naive mock would not:
//   - the CAS filter compares against the SERIALIZED value it is given, so a
//     caller that forgets JSON.stringify (or a regression that removes it)
//     matches zero rows instead of accidentally passing;
//   - a concurrent write between read and CAS makes the CAS claim zero rows.

type Row = { id: string; approval_snapshot: unknown };

function makeFake(initial: Row) {
  const row = { ...initial };
  const calls = { updates: [] as Array<Record<string, unknown>>, selects: 0 };
  function from(table: string) {
    expect(table).toBe('quotes');
    const state = {
      op: 'select' as 'select' | 'update',
      payload: null as Record<string, unknown> | null,
      idMatch: true,
      casMatch: true,
    };
    const builder = {
      select() {
        if (state.op === 'select') calls.selects++;
        return builder;
      },
      update(payload: Record<string, unknown>) {
        state.op = 'update';
        state.payload = payload;
        return builder;
      },
      eq(col: string, val: unknown) {
        if (col === 'id') state.idMatch = row.id === val;
        if (col === 'approval_snapshot') {
          // PostgREST semantics: the filter value is compared as the string
          // the client sent. An object degrades to "[object Object]" and can
          // never equal the row's serialized jsonb — exactly the trap the
          // shared module encodes.
          state.casMatch = typeof val === 'string' && JSON.stringify(row.approval_snapshot) === val;
        }
        return builder;
      },
      async maybeSingle() {
        return state.idMatch
          ? { data: { approval_snapshot: row.approval_snapshot }, error: null }
          : { data: null, error: null };
      },
      then(resolve: (v: unknown) => void) {
        if (state.op === 'update') {
          if (state.idMatch && state.casMatch) {
            calls.updates.push(state.payload!);
            Object.assign(row, state.payload);
            return resolve({ data: [{ id: row.id }], error: null });
          }
          return resolve({ data: [], error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return builder;
  }
  return { client: { from } as never, row, calls };
}

const QUOTE = '11111111-1111-4111-8111-111111111111';
const FROZEN = { currentTotalUsd: 7797.38, customerSelection: { depositRate: 0.4 }, signature: 'K.T.' };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('casSwapApprovalSnapshot (row 411)', () => {
  it('lands when the row still holds the observed value, and writes extra columns atomically', async () => {
    const { client, row, calls } = makeFake({ id: QUOTE, approval_snapshot: FROZEN });
    const next = { ...FROZEN, amendments: [{ reason: 'x' }] };
    const outcome = await casSwapApprovalSnapshot(client, QUOTE, FROZEN, next, '[t]', { total: 123 });
    expect(outcome).toBe('landed');
    expect(row.approval_snapshot).toEqual(next);
    expect(calls.updates[0]).toMatchObject({ total: 123 });
  });

  it('returns conflict — not success — when a concurrent write moved the snapshot', async () => {
    const { client, row } = makeFake({ id: QUOTE, approval_snapshot: { ...FROZEN, amendments: [1] } });
    const outcome = await casSwapApprovalSnapshot(client, QUOTE, FROZEN, { ...FROZEN, k: 1 }, '[t]');
    expect(outcome).toBe('conflict');
    // and the frozen agreement was not clobbered
    expect(row.approval_snapshot).toEqual({ ...FROZEN, amendments: [1] });
  });
});

describe('appendQuoteAuditEntry (row 411)', () => {
  it('appends to the named list and preserves every frozen field', async () => {
    const { client, row } = makeFake({ id: QUOTE, approval_snapshot: FROZEN });
    const ok = await appendQuoteAuditEntry(client, QUOTE, 'identityChangeRefusals', { a: 1 }, '[t]', FROZEN);
    expect(ok).toBe(true);
    expect(row.approval_snapshot).toEqual({ ...FROZEN, identityChangeRefusals: [{ a: 1 }] });
  });

  it('NEVER writes when the observed snapshot is unconfirmed (the reviewed data-loss bug)', async () => {
    // baseSnapshot null = "my read failed". The bug this pins: coercing that
    // to {} and writing it back REPLACES the frozen agreement.
    const { client, row, calls } = makeFake({ id: QUOTE, approval_snapshot: FROZEN });
    const ok = await appendQuoteAuditEntry(client, QUOTE, 'identityChangeRefusals', { a: 1 }, '[t]', null);
    expect(ok).toBe(false);
    expect(calls.updates).toHaveLength(0);
    expect(row.approval_snapshot).toEqual(FROZEN);
  });

  it('retries ONCE against a fresh read after losing a race, then lands on the moved value', async () => {
    // The harness models real concurrency: the caller observed FROZEN, but the
    // row has since gained an amendment — so the first CAS genuinely misses,
    // and the retry must merge onto the MOVED snapshot, not the stale one.
    const moved = { ...FROZEN, amendments: [{ reason: 'concurrent' }] };
    const { client, row, calls } = makeFake({ id: QUOTE, approval_snapshot: moved });
    const ok = await appendQuoteAuditEntry(client, QUOTE, 'identityChangeRefusals', { a: 1 }, '[t]', FROZEN);
    expect(ok).toBe(true);
    expect(calls.selects).toBeGreaterThan(0); // it re-read, not blind-retried
    expect(row.approval_snapshot).toEqual({ ...moved, identityChangeRefusals: [{ a: 1 }] });
  });

  it('gives up (false) when the fresh re-read also fails, without writing {}', async () => {
    const moved = { ...FROZEN, amendments: [{ reason: 'concurrent' }] };
    const fake = makeFake({ id: 'someone-else', approval_snapshot: moved }); // id mismatch: reads find nothing
    const ok = await appendQuoteAuditEntry(fake.client, QUOTE, 'identityChangeRefusals', { a: 1 }, '[t]', FROZEN);
    expect(ok).toBe(false);
    expect(fake.calls.updates).toHaveLength(0);
  });
});
