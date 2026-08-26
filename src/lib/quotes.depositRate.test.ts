import { describe, it, expect, vi } from 'vitest';
import { BUSINESS_RULES } from './pricing/pricingEngine';

// Row 409 — the admin quotes list shows the deposit rate a quote is actually
// on, so the resolution has to agree with the money paths and the plumbing that
// feeds it has to actually fetch the three inputs. Both are asserted here:
// PostgREST hands `->>` paths back as TEXT, so a regression that forgets to
// parse them shows a customer's 40% deposit as NaN%.

const selectRef = { current: '' };
const rowsRef = { current: [] as Record<string, unknown>[] };

vi.mock('./supabase', () => {
  const builder: Record<string, unknown> = {};
  builder.select = (s: string) => {
    selectRef.current = s;
    return builder;
  };
  builder.order = () => builder;
  builder.limit = () => builder;
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: rowsRef.current, error: null });
  const client = { from: () => builder };
  return { getSupabaseServiceClient: () => client, getSupabaseClient: () => client };
});

import { listQuotes, resolveQuoteDepositRate } from './quotes';

// A PostgREST row as it really arrives: every json path is a string or null.
const row = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  is_nce: false,
  deposit_percent_raw: null,
  result_deposit_rate_raw: null,
  snapshot_deposit_rate_raw: null,
  ...over,
});

describe('listQuotes deposit rate (row 409)', () => {
  it('asks the DB for the three deposit inputs as scalar json paths', async () => {
    rowsRef.current = [row()];
    await listQuotes();
    expect(selectRef.current).toContain('deposit_percent_raw:inputs->>depositPercent');
    expect(selectRef.current).toContain('result_deposit_rate_raw:result->>depositRate');
    expect(selectRef.current).toContain(
      'snapshot_deposit_rate_raw:approval_snapshot->customerSelection->>depositRate',
    );
    // The blobs themselves must stay out of a 500-row listing.
    expect(selectRef.current).not.toMatch(/(^|, )inputs(,|$)/);
    expect(selectRef.current).not.toMatch(/(^|, )result(,|$)/);
    expect(selectRef.current).not.toMatch(/(^|, )approval_snapshot(,|$)/);
  });

  it('parses the TEXT PostgREST returns into a real rate', async () => {
    rowsRef.current = [row({ deposit_percent_raw: '40', result_deposit_rate_raw: '0.4' })];
    const [q] = await listQuotes();
    expect(q.deposit_rate).toBe(0.4);
  });

  it('falls back to the rate frozen into result when no staff override is set', async () => {
    rowsRef.current = [row({ result_deposit_rate_raw: '0.5' })];
    const [q] = await listQuotes();
    expect(q.deposit_rate).toBe(0.5);
  });

  it('falls back to the business default on a never-calculated draft', async () => {
    rowsRef.current = [row()];
    const [q] = await listQuotes();
    expect(q.deposit_rate).toBe(BUSINESS_RULES.depositPercentage);
  });

  it('never emits NaN for a garbage stored value', async () => {
    rowsRef.current = [row({ deposit_percent_raw: 'forty', result_deposit_rate_raw: '' })];
    const [q] = await listQuotes();
    expect(Number.isFinite(q.deposit_rate)).toBe(true);
    expect(q.deposit_rate).toBe(BUSINESS_RULES.depositPercentage);
  });

  it('leaves every other listed field untouched', async () => {
    rowsRef.current = [row({ id: 'q9', is_nce: true, customer_name: 'Maria Alvarez', total: 348 })];
    const [q] = await listQuotes();
    expect(q.id).toBe('q9');
    expect(q.is_nce).toBe(true);
    expect(q.customer_name).toBe('Maria Alvarez');
    expect(q.total).toBe(348);
    // The raw json-path aliases are plumbing; they must not leak into the item.
    expect(q as unknown as Record<string, unknown>).not.toHaveProperty('deposit_percent_raw');
  });
});

describe('resolveQuoteDepositRate precedence (row 409)', () => {
  it('an approved quote shows the rate frozen at approval, not the live one', () => {
    // This is the case that decides whether the list agrees with what the
    // customer signed: the Valor webhook charges the snapshot rate.
    expect(resolveQuoteDepositRate({ snapshotRate: 0.4, depositPercent: 50, resultRate: 0.5 })).toBe(0.4);
  });

  it('a staff-set percent outranks the rate stored in result', () => {
    expect(resolveQuoteDepositRate({ depositPercent: 40, resultRate: 0.5 })).toBe(0.4);
  });

  it('an explicit 0 means "no override" and resolves to the default, matching chargesFromResult', () => {
    // #226: the nce route writes an explicit 0 rather than deleting the key, and
    // effectiveDepositRate treats out-of-range as unset. The list must read that
    // the same way the charge path does — 50%, not a stale 40% from result.
    expect(resolveQuoteDepositRate({ depositPercent: 0, resultRate: 0.4 })).toBe(
      BUSINESS_RULES.depositPercentage,
    );
  });

  it('falls through to result, then to the business default', () => {
    expect(resolveQuoteDepositRate({ resultRate: 0.35 })).toBe(0.35);
    expect(resolveQuoteDepositRate({})).toBe(BUSINESS_RULES.depositPercentage);
  });
});
