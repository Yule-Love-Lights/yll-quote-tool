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
    sendSms: vi.fn(async (_input: { contactId: string; message: string; fromNumber?: string }) => ({
      messageId: 'sms-1',
    })),
    sendEmail: vi.fn(async (_input: { contactId: string; subject: string; html: string; emailFrom?: string }) => ({
      messageId: 'email-1',
    })),
    configured: { value: false },
  },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  isSupabaseServiceConfigured: () => !!sbRef.current,
}));

vi.mock('./integrations/highlevel', () => ({
  upsertContactCustomField: hl.upsertContactCustomField,
  sendSms: hl.sendSms,
  sendEmail: hl.sendEmail,
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
  isReferralSpendable,
  isReferralExpired,
  notifyReferrerEarned,
  REFERRAL_CREDIT_USD,
  REFERRAL_CREDIT_EXPIRY_YEARS,
  REFERRAL_FRIEND_SPRITZERS,
} from './referrals';

// ─── In-memory Supabase fake ────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeSupabase(initial: { customers?: Row[]; referrals?: Row[]; quotes?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    customers: initial.customers ? initial.customers.map((r) => ({ ...r })) : [],
    referrals: initial.referrals ? initial.referrals.map((r) => ({ ...r })) : [],
    quotes: initial.quotes ? initial.quotes.map((r) => ({ ...r })) : [],
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
      // Minimal PostgREST .or() DSL parser (mirrors src/lib/customers.test.ts):
      // supports the two forms creditBalanceFor's expiry guard needs —
      // `col.is.null` and `col.gt.<iso-string>` — joined by a plain comma (no
      // nested parens in our usage, so no need for the paren-aware split).
      or: (condsStr: string) => {
        const predicates = condsStr.split(',').map((cond) => {
          const isNullMatch = cond.match(/^([a-z_]+)\.is\.null$/);
          if (isNullMatch) {
            const [, col] = isNullMatch;
            return (r: Row) => r[col] == null;
          }
          const gtMatch = cond.match(/^([a-z_]+)\.gt\.(.+)$/);
          if (gtMatch) {
            const [, col, val] = gtMatch;
            return (r: Row) => r[col] != null && String(r[col]) > val;
          }
          throw new Error(`unsupported .or() condition in fake: ${cond}`);
        });
        state.filters.push((r) => predicates.some((p) => p(r)));
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
      // The fake doesn't implement real column projection (select() is a
      // no-op above), so an update's .select(...) here returns the FULL
      // updated row — accrueOnBooking's `.select('id, referrer_customer_id')`
      // needs referrer_customer_id back to wire notifyReferrerEarned (#41).
      then: (resolve: (v: unknown) => void) => {
        if (state.isUpdate) {
          const targets = match();
          for (const t of targets) Object.assign(t, state.updateRow);
          resolve({ data: targets.map((t) => ({ ...t })), error: null });
          return;
        }
        resolve({ data: match(), error: null });
      },
    };
    return builder;
  }

  return { from };
}

beforeEach(() => {
  sbRef.current = null;
  hl.upsertContactCustomField.mockClear();
  hl.sendSms.mockClear();
  hl.sendSms.mockResolvedValue({ messageId: 'sms-1' });
  hl.sendEmail.mockClear();
  hl.sendEmail.mockResolvedValue({ messageId: 'email-1' });
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

  it('stamps expires_at = booked_at + 2 years in the SAME update (#41 expiry)', async () => {
    const sb = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'pending', amount_usd: 125 }],
    });
    sbRef.current = sb;
    const before = Date.now();
    await accrueOnBooking('q1');
    const readBack = sb.from('referrals') as unknown as { select: (c: string) => Promise<{ data: Row[] }> };
    const { data } = await readBack.select('*');
    const booked = data[0];
    expect(booked.status).toBe('booked');
    expect(booked.booked_at).toEqual(expect.any(String));
    expect(booked.expires_at).toEqual(expect.any(String));
    const bookedAtMs = new Date(booked.booked_at as string).getTime();
    const expiresAtMs = new Date(booked.expires_at as string).getTime();
    expect(bookedAtMs).toBeGreaterThanOrEqual(before);
    expect(REFERRAL_CREDIT_EXPIRY_YEARS).toBe(2);
    // 2 years later, allowing for leap-year day-count slop (730-731 days).
    const twoYearsMs = expiresAtMs - bookedAtMs;
    const days = twoYearsMs / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThanOrEqual(730);
    expect(days).toBeLessThanOrEqual(731);
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

  it('EXCLUDES a booked-but-EXPIRED row from the spendable balance (#41 expiry)', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // yesterday
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, expires_at: past },
        { id: 'r2', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, expires_at: null },
      ],
    });
    // Only r2 (grandfathered NULL expiry) counts — r1 already expired.
    expect(await creditBalanceFor('c1')).toBe(125);
  });

  it('INCLUDES a booked row whose expiry is still in the future (#41 expiry)', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // tomorrow
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, expires_at: future }],
    });
    expect(await creditBalanceFor('c1')).toBe(125);
  });

  it('treats a NULL expires_at as non-expiring — grandfathered pre-column rows (#41 expiry)', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, expires_at: null }],
    });
    expect(await creditBalanceFor('c1')).toBe(125);
  });
});

describe('isReferralSpendable / isReferralExpired (#41 expiry rule, pure)', () => {
  const NOW = new Date('2026-07-11T00:00:00.000Z');
  const past = '2026-01-01T00:00:00.000Z';
  const future = '2027-01-01T00:00:00.000Z';

  it('a booked row with NO expires_at is spendable (grandfathered) and not expired', () => {
    expect(isReferralSpendable({ status: 'booked', expires_at: null }, NOW)).toBe(true);
    expect(isReferralExpired({ status: 'booked', expires_at: null }, NOW)).toBe(false);
  });

  it('a booked row expiring in the FUTURE is spendable and not expired', () => {
    expect(isReferralSpendable({ status: 'booked', expires_at: future }, NOW)).toBe(true);
    expect(isReferralExpired({ status: 'booked', expires_at: future }, NOW)).toBe(false);
  });

  it('a booked row whose expires_at is in the PAST is not spendable and shows as expired', () => {
    expect(isReferralSpendable({ status: 'booked', expires_at: past }, NOW)).toBe(false);
    expect(isReferralExpired({ status: 'booked', expires_at: past }, NOW)).toBe(true);
  });

  it('a pending row is never spendable and never "expired" (that display status only applies to booked rows)', () => {
    expect(isReferralSpendable({ status: 'pending', expires_at: past }, NOW)).toBe(false);
    expect(isReferralExpired({ status: 'pending', expires_at: past }, NOW)).toBe(false);
  });

  it('a credited row is never spendable (already consumed) and never shows as "expired"', () => {
    expect(isReferralSpendable({ status: 'credited', expires_at: past }, NOW)).toBe(false);
    expect(isReferralExpired({ status: 'credited', expires_at: past }, NOW)).toBe(false);
  });
});

describe('notifyReferrerEarned (Feature 2, #41 follow-up)', () => {
  it('sends an SMS to the referrer when they have a phone + linked GHL contact', async () => {
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', name: 'Jordan Smith', email: 'jordan@example.com', phone: '5165550100', hl_contact_id: 'contact_1', referral_code: 'ABCD1234' }],
      quotes: [{ id: 'q1', customer_name: 'Sam Rivera' }],
    });
    await notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 });
    expect(hl.sendSms).toHaveBeenCalledTimes(1);
    expect(hl.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'contact_1',
        message: expect.stringContaining('Sam'),
      }),
    );
    expect(hl.sendSms.mock.calls[0][0].message).toContain('$125');
    expect(hl.sendSms.mock.calls[0][0].message).toContain('/refer/ABCD1234');
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('falls back to email when the referrer has no phone on file', async () => {
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', name: 'Jordan Smith', email: 'jordan@example.com', phone: null, hl_contact_id: 'contact_1', referral_code: 'ABCD1234' }],
      quotes: [{ id: 'q1', customer_name: 'Sam Rivera' }],
    });
    await notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 });
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
    expect(hl.sendEmail.mock.calls[0][0]).toMatchObject({ contactId: 'contact_1' });
  });

  it('falls back to email when the SMS send itself fails', async () => {
    hl.configured.value = true;
    hl.sendSms.mockRejectedValueOnce(new Error('GHL 500'));
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', name: 'Jordan Smith', email: 'jordan@example.com', phone: '5165550100', hl_contact_id: 'contact_1', referral_code: 'ABCD1234' }],
      quotes: [{ id: 'q1', customer_name: 'Sam Rivera' }],
    });
    await expect(
      notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 }),
    ).resolves.toBeUndefined();
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('falls back to generic "A friend" copy when the referee quote lookup misses', async () => {
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', name: 'Jordan Smith', email: null, phone: '5165550100', hl_contact_id: 'contact_1', referral_code: 'ABCD1234' }],
      quotes: [],
    });
    await notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q-missing', amountUsd: 125 });
    expect(hl.sendSms.mock.calls[0][0].message).toContain('A friend');
  });

  it('is a clean no-op when referrerCustomerId is null (nothing accrued)', async () => {
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase();
    await notifyReferrerEarned({ referrerCustomerId: null, refereeQuoteId: 'q1', amountUsd: 125 });
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('is a clean no-op when GHL is not configured', async () => {
    hl.configured.value = false;
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', phone: '5165550100', email: 'jordan@example.com', hl_contact_id: 'contact_1' }],
    });
    await notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 });
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('is a clean no-op when the referrer customer has no linked GHL contact', async () => {
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', phone: '5165550100', email: 'jordan@example.com', hl_contact_id: null }],
    });
    await notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 });
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('never throws even when BOTH sends fail (fail-open, no channel left)', async () => {
    hl.configured.value = true;
    hl.sendSms.mockRejectedValueOnce(new Error('GHL 500'));
    hl.sendEmail.mockRejectedValueOnce(new Error('GHL 500'));
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', phone: '5165550100', email: 'jordan@example.com', hl_contact_id: 'contact_1' }],
    });
    await expect(
      notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 }),
    ).resolves.toBeUndefined();
  });

  it('never throws when Supabase is not configured', async () => {
    hl.configured.value = true;
    sbRef.current = null;
    await expect(
      notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 }),
    ).resolves.toBeUndefined();
  });
});

describe('accrueOnBooking → notifyReferrerEarned wiring (Feature 2 integration)', () => {
  it('fires the notify exactly ONCE when a row actually flips pending -> booked', async () => {
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'pending', amount_usd: 125, referrer_customer_id: 'c1' }],
      customers: [{ id: 'c1', phone: '5165550100', email: null, hl_contact_id: 'contact_1', referral_code: 'ABCD1234' }],
      quotes: [{ id: 'q1', customer_name: 'Sam Rivera' }],
    });
    await accrueOnBooking('q1');
    expect(hl.sendSms).toHaveBeenCalledTimes(1);
  });

  it('does NOT notify when nothing accrued (already booked / no referral for that quote)', async () => {
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'booked', amount_usd: 125, referrer_customer_id: 'c1' }],
      customers: [{ id: 'c1', phone: '5165550100', hl_contact_id: 'contact_1' }],
    });
    const res = await accrueOnBooking('q1');
    expect(res).toEqual({ accrued: false });
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('a notify failure never flips the accrual result to false (accrued stays true)', async () => {
    hl.configured.value = true;
    hl.sendSms.mockRejectedValueOnce(new Error('GHL down'));
    hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'pending', amount_usd: 125, referrer_customer_id: 'c1' }],
      customers: [{ id: 'c1', phone: '5165550100', email: 'j@example.com', hl_contact_id: 'contact_1' }],
      quotes: [{ id: 'q1', customer_name: 'Sam Rivera' }],
    });
    const res = await accrueOnBooking('q1');
    expect(res).toEqual({ accrued: true });
  });
});

describe('constants', () => {
  it('locks the product terms (Naldo, S30)', () => {
    expect(REFERRAL_CREDIT_USD).toBe(125);
    expect(REFERRAL_FRIEND_SPRITZERS).toEqual({ count: 2, sizeInches: 16 });
  });

  it('locks the credit expiry window at 2 years (Naldo, #41 follow-up)', () => {
    expect(REFERRAL_CREDIT_EXPIRY_YEARS).toBe(2);
  });
});
