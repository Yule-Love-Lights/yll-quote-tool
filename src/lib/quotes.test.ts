import { describe, it, expect, beforeEach, vi } from 'vitest';

// #90 RLS hardening: saveQuote / updateQuote must write through the RLS-bypassing
// SERVICE-ROLE client (preferring it over anon), so they keep working once RLS is
// enabled on the quotes table. The other quotes.ts fns already do this; these two
// were the outliers still on the pure-anon client. These tests pin the behavior:
// when both clients are configured, the write goes through the service client.

const { serviceRef, anonRef } = vi.hoisted(() => ({
  serviceRef: { current: null as unknown },
  anonRef: { current: null as unknown },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => serviceRef.current,
  getSupabaseClient: () => anonRef.current,
}));

import { saveQuote, updateQuote } from './quotes';
import type { QuoteInputs, QuoteResult } from './pricing/pricingEngine';

// A chainable Supabase fake that records which tables `.from()` is called on, so a
// test can assert WHICH client (service vs anon) a write went through.
function makeFake() {
  const fromCalls: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  const builder: Record<string, unknown> = {};
  const ret = () => builder;
  for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) {
    builder[m] = ret;
  }
  builder.insert = (row: Record<string, unknown>) => {
    inserts.push(row);
    return builder;
  };
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
  return { client, fromCalls, inserts };
}

const INPUTS = {} as QuoteInputs;
const RESULT = { total: 100 } as QuoteResult;

beforeEach(() => {
  serviceRef.current = null;
  anonRef.current = null;
});

describe('saveQuote', () => {
  it('writes through the service-role client when configured (RLS-safe)', async () => {
    const service = makeFake();
    const anon = makeFake();
    serviceRef.current = service.client;
    anonRef.current = anon.client;

    const res = await saveQuote({ name: 'Jane' }, INPUTS, RESULT);

    expect(res).toEqual({ id: 'new-id' });
    expect(service.fromCalls).toContain('quotes');
    expect(anon.fromCalls).not.toContain('quotes');
  });

  it('falls back to the anon client when no service client (dev)', async () => {
    const anon = makeFake();
    anonRef.current = anon.client;

    const res = await saveQuote({ name: 'Jane' }, INPUTS, RESULT);

    expect(res).toEqual({ id: 'new-id' });
    expect(anon.fromCalls).toContain('quotes');
  });

  it('returns null when Supabase is unconfigured', async () => {
    expect(await saveQuote({ name: 'Jane' }, INPUTS, RESULT)).toBeNull();
  });
});

describe('updateQuote', () => {
  it('writes through the service-role client when configured (RLS-safe)', async () => {
    const service = makeFake();
    const anon = makeFake();
    serviceRef.current = service.client;
    anonRef.current = anon.client;

    const res = await updateQuote('q1', INPUTS, RESULT);

    expect(res).toEqual({ id: 'new-id' });
    expect(service.fromCalls).toContain('quotes');
    expect(anon.fromCalls).not.toContain('quotes');
  });

  it('returns null when Supabase is unconfigured', async () => {
    expect(await updateQuote('q1', INPUTS, RESULT)).toBeNull();
  });
});

// #90 actor audit trail: saveQuote stamps created_by (the operator's user id).
describe('saveQuote created_by', () => {
  it('writes the caller id into created_by on insert', async () => {
    const service = makeFake();
    serviceRef.current = service.client;

    await saveQuote({ name: 'Jane' }, INPUTS, RESULT, undefined, 'op-1');

    expect(service.inserts[0]).toMatchObject({ created_by: 'op-1' });
  });

  it('writes created_by null when no caller id (dormant auth)', async () => {
    const service = makeFake();
    serviceRef.current = service.client;

    await saveQuote({ name: 'Jane' }, INPUTS, RESULT);

    expect(service.inserts[0]).toMatchObject({ created_by: null });
  });
});
