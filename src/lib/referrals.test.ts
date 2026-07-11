import { describe, it, expect, beforeEach, vi } from 'vitest';

// Referral program PR 1 (ledger #41). The pure code generator is tested
// directly; the DB helpers run against a small in-memory Supabase fake
// (mirrors the style in src/lib/customers.test.ts) that models the
// select/insert/update + eq/is/maybeSingle/single chains referrals.ts uses,
// including a UNIQUE(referee_quote_id) constraint so the accrual/idempotency
// paths exercise the SAME race-recovery a real Postgres unique-violation forces.

const { sbRef, hl } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    upsertContactCustomField: vi.fn(async () => undefined),
    configured: { value: false },
  },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  isSupabaseServiceConfigured: () => !!sbRef.current,
}));

vi.mock('./integrations/highlevel', () => ({
  upsertContactCustomField: hl.upsertContactCustomField,
  isHighLevelConfigured: () => hl.configured.value,
}));

vi.mock('./integrations/telegramNotify', () => ({
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));

import {
  generateReferralCode,
  ensureReferralCode,
  getReferralByCode,
  createPendingReferral,
  accrueOnBooking,
  creditBalanceFor,
  listReferralsFor,
  REFERRAL_CREDIT_USD,
  REFERRAL_FRIEND_SPRITZERS,
} from './referrals';

// ─── In-memory Supabase fake ────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeSupabase(initial: { customers?: Row[]; referrals?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    customers: initial.customers ? initial.customers.map((r) => ({ ...r })) : [],
    referrals: initial.referrals ? initial.referrals.map((r) => ({ ...r })) : [],
  };
  let counter = 0;

  function violatesUnique(table: string, row: Row): boolean {
    if (table === 'customers' && row.referral_code != null) {
      return tables.customers.some((r) => r.id !== row.id && r.referral_code === row.referral_code);
    }
    if (table === 'referrals' && row.referee_quote_id != null) {
      return tables.referrals.some((r) => r.referee_quote_id === row.referee_quote_id);
    }
    return false;
  }

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const state = {
      insertRow: null as Row | null,
      updateRow: null as Row | null,
      filters: [] as Array<(r: Row) => boolean>,
      isUpdate: false,
      isInsert: false,
      sort: null as null | { col: string; ascending: boolean },
    };
    const match = () => rows.filter((r) => state.filters.every((f) => f(r)));

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (row: Row) => {
        state.isInsert = true;
        state.insertRow = row;
        return builder;
      },
      update: (row: Row) => {
        state.isUpdate = true;
        state.updateRow = row;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        state.filters.push((r) => r[col] === val);
        return builder;
      },
      is: (col: string, val: null) => {
        state.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        state.sort = { col, ascending: !!opts?.ascending };
        return builder;
      },
      single: async () => {
        if (state.isInsert) {
          if (violatesUnique(table, state.insertRow!)) {
            return { data: null, error: { code: '23505', message: 'unique violation' } };
          }
          const row = { id: `${table}-${++counter}`, ...state.insertRow };
          rows.push(row);
          return { data: row, error: null };
        }
        const found = match();
        return { data: found[0] ?? null, error: found[0] ? null : { message: 'no row' } };
      },
      maybeSingle: async () => {
        if (state.isUpdate) {
          const targets = match();
          if (targets.length === 0) return { data: null, error: null };
          if (violatesUnique(table, { ...targets[0], ...state.updateRow })) {
            return { data: null, error: { code: '23505', message: 'unique violation' } };
          }
          Object.assign(targets[0], state.updateRow);
          return { data: { id: targets[0].id }, error: null };
        }
        const found = match();
        return { data: found[0] ?? null, error: null };
      },
      // Used by accrueOnBooking / creditBalanceFor: array-returning update/select
      // (no single row expected) — thenable so `await` resolves it directly.
      then: (resolve: (v: unknown) => void) => {
        if (state.isUpdate) {
          const targets = match();
          for (const t of targets) Object.assign(t, state.updateRow);
          resolve({ data: targets.map((t) => ({ id: t.id })), error: null });
          return;
        }
        let out = match();
        if (state.sort) {
          const { col, ascending } = state.sort;
          out = out.slice().sort((a, b) => {
            const av = String(a[col] ?? '');
            const bv = String(b[col] ?? '');
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return ascending ? cmp : -cmp;
          });
        }
        resolve({ data: out, error: null });
      },
    };
    return builder;
  }

  return { from };
}

beforeEach(() => {
  sbRef.current = null;
  hl.upsertContactCustomField.mockClear();
  hl.configured.value = false;
});

describe('generateReferralCode', () => {
  it('generates an 8-char code from the URL-safe alphabet only', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateReferralCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/);
    }
  });

  it('is not a constant (extremely unlikely to collide twice in a row)', () => {
    const a = generateReferralCode();
    const b = generateReferralCode();
    expect(a).not.toBe(b);
  });
});

describe('ensureReferralCode', () => {
  it('returns null when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await ensureReferralCode('c1')).toBeNull();
  });

  it('returns null for an unknown customer', async () => {
    sbRef.current = makeFakeSupabase({ customers: [] });
    expect(await ensureReferralCode('missing')).toBeNull();
  });

  it('creates a fresh code when the customer has none, and returns the SAME code on a second call (idempotent)', async () => {
    sbRef.current = makeFakeSupabase({ customers: [{ id: 'c1', referral_code: null, hl_contact_id: null }] });
    const first = await ensureReferralCode('c1');
    expect(first).toMatch(/^[A-Z0-9]{8}$/);
    const second = await ensureReferralCode('c1');
    expect(second).toBe(first);
  });

  it('returns the existing code without generating a new one', async () => {
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: 'EXISTING1', hl_contact_id: null }],
    });
    expect(await ensureReferralCode('c1')).toBe('EXISTING1');
  });

  it('stamps the GHL contact custom field ONLY when a code is newly created', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK = 'field_referral_link';
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: null, hl_contact_id: 'contact_1' }],
    });
    const code = await ensureReferralCode('c1');
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith(
      'contact_1',
      'field_referral_link',
      `https://quote.yulelovelights.com/refer/${code}`,
    );
    delete process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK;
  });

  it('does not stamp GHL when the field env var is unset (fail-open)', async () => {
    hl.configured.value = true;
    delete process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK;
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: null, hl_contact_id: 'contact_1' }],
    });
    await ensureReferralCode('c1');
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('does not stamp GHL when the customer has no linked contact', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK = 'field_referral_link';
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: null, hl_contact_id: null }],
    });
    await ensureReferralCode('c1');
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
    delete process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK;
  });
});

describe('getReferralByCode', () => {
  it('resolves an existing code to its referrer', async () => {
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: 'ABCD1234', name: 'Jordan Smith', referral_photo_optout: false }],
    });
    expect(await getReferralByCode('ABCD1234')).toEqual({
      customerId: 'c1',
      name: 'Jordan Smith',
      photoOptout: false,
    });
  });

  it('surfaces a true photo opt-out', async () => {
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: 'ABCD1234', name: 'Jordan Smith', referral_photo_optout: true }],
    });
    expect(await getReferralByCode('ABCD1234')).toMatchObject({ photoOptout: true });
  });

  it('returns null for an unknown code', async () => {
    sbRef.current = makeFakeSupabase({ customers: [] });
    expect(await getReferralByCode('NOPE0000')).toBeNull();
  });

  it('returns null for an empty code without querying', async () => {
    sbRef.current = makeFakeSupabase({ customers: [] });
    expect(await getReferralByCode('')).toBeNull();
  });
});

describe('createPendingReferral', () => {
  it('creates a "mention" row with the quote id known immediately', async () => {
    sbRef.current = makeFakeSupabase();
    const res = await createPendingReferral({
      source: 'mention',
      referrerCustomerId: 'c1',
      refereeQuoteId: 'q1',
    });
    expect(res).not.toBeNull();
  });

  it('creates a "link" row with a NULL quote id (lead capture, no quote yet)', async () => {
    sbRef.current = makeFakeSupabase();
    const res = await createPendingReferral({
      source: 'link',
      referrerCustomerId: 'c1',
      refereeContactName: 'Sam Rivera',
      refereeContactPhone: '5165550123',
    });
    expect(res).not.toBeNull();
  });

  it('is idempotent for the SAME referee quote id — returns the existing row instead of duplicating', async () => {
    sbRef.current = makeFakeSupabase();
    const first = await createPendingReferral({ source: 'mention', referrerCustomerId: 'c1', refereeQuoteId: 'q1' });
    const second = await createPendingReferral({ source: 'mention', referrerCustomerId: 'c2', refereeQuoteId: 'q1' });
    expect(second).toEqual(first);
  });

  it('allows MULTIPLE pending "link" rows with null referee_quote_id (no false unique collision)', async () => {
    sbRef.current = makeFakeSupabase();
    const a = await createPendingReferral({ source: 'link', referrerCustomerId: 'c1' });
    const b = await createPendingReferral({ source: 'link', referrerCustomerId: 'c1' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });
});

describe('accrueOnBooking (idempotency)', () => {
  it('flips a pending referral for the referee quote to booked + stamps booked_at', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'pending', amount_usd: 125 }],
    });
    const res = await accrueOnBooking('q1');
    expect(res).toEqual({ accrued: true });
  });

  it('is a no-op the SECOND time — a concurrent/retried booking call cannot double-accrue', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'pending', amount_usd: 125 }],
    });
    const first = await accrueOnBooking('q1');
    const second = await accrueOnBooking('q1');
    expect(first).toEqual({ accrued: true });
    expect(second).toEqual({ accrued: false });
  });

  it('is a no-op when no referral exists for that quote (most bookings have none)', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    expect(await accrueOnBooking('q-no-referral')).toEqual({ accrued: false });
  });

  it('never throws when Supabase is not configured — fail-open for the payment path', async () => {
    sbRef.current = null;
    await expect(accrueOnBooking('q1')).resolves.toEqual({ accrued: false });
  });
});

describe('creditBalanceFor', () => {
  it('sums only BOOKED (not yet credited) referrals at their stored amount', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125 },
        { id: 'r2', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125 },
        { id: 'r3', referrer_customer_id: 'c1', status: 'pending', amount_usd: 125 }, // not yet booked
        { id: 'r4', referrer_customer_id: 'c1', status: 'credited', amount_usd: 125 }, // already spent (PR 2)
        { id: 'r5', referrer_customer_id: 'c2', status: 'booked', amount_usd: 125 }, // different referrer
      ],
    });
    expect(await creditBalanceFor('c1')).toBe(250);
  });

  it('is stackable — three booked friends sum to 3x credit', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125 },
        { id: 'r2', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125 },
        { id: 'r3', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125 },
      ],
    });
    expect(await creditBalanceFor('c1')).toBe(3 * REFERRAL_CREDIT_USD);
  });

  it('returns 0 for a customer with no referrals', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    expect(await creditBalanceFor('nobody')).toBe(0);
  });
});

describe('listReferralsFor', () => {
  it('returns only this referrer\'s referrals, newest first', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', status: 'pending', amount_usd: 125, created_at: '2026-01-01' },
        { id: 'r2', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, created_at: '2026-03-01' },
        { id: 'r3', referrer_customer_id: 'c2', status: 'booked', amount_usd: 125, created_at: '2026-02-01' },
      ],
    });
    const rows = await listReferralsFor('c1');
    expect(rows.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('returns [] when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await listReferralsFor('c1')).toEqual([]);
  });

  it('returns [] for a customer with no referrals', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    expect(await listReferralsFor('nobody')).toEqual([]);
  });

  it('returns [] for an empty customer id without querying', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [{ id: 'r1', referrer_customer_id: 'c1' }] });
    expect(await listReferralsFor('')).toEqual([]);
  });
});

describe('constants', () => {
  it('locks the product terms (Naldo, S30)', () => {
    expect(REFERRAL_CREDIT_USD).toBe(125);
    expect(REFERRAL_FRIEND_SPRITZERS).toEqual({ count: 2, sizeInches: 16 });
  });
});
