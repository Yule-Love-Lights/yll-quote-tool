import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Referral program PR 1 (ledger #41). The pure code generator is tested
// directly; the DB helpers run against a small in-memory Supabase fake
// (mirrors the style in src/lib/customers.test.ts) that models the
// select/insert/update + eq/is/maybeSingle/single chains referrals.ts uses,
// including a UNIQUE(referee_quote_id) constraint so the accrual/idempotency
// paths exercise the SAME race-recovery a real Postgres unique-violation forces.

const { sbRef, hl, afterCalls } = vi.hoisted(() => ({
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
  // Review fix 8: counts real calls to next/server's after(), so a test can
  // prove the referral-link stamp is scheduled THROUGH after(), not a
  // detached void call.
  afterCalls: { count: 0 },
}));

// Review fix 8: referrals.ts now nests after() (see ensureReferralCode's
// stampReferralLinkOnContact call) instead of a detached void call. The real
// after() throws outside a request scope (Next.js docs), which this plain
// vitest environment never establishes, so it must be mocked. Fires the task
// immediately without awaiting it, the same non-blocking timing the old void
// call had, so the existing "stamps the GHL contact custom field ONLY when a
// code is newly created" test below keeps passing unmodified.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: () => Promise<void> | void) => {
      afterCalls.count++;
      void task();
    },
  };
});

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
  hasReferralCode,
  getReferralByCode,
  createPendingReferral,
  accrueOnBooking,
  releaseAccrualOnCancel,
  creditBalanceFor,
  refereeReferralFor,
  consumeCredits,
  releaseCredits,
  listReferralsFor,
  getReferralPhotoOptout,
  setReferralPhotoOptout,
  hasRecentPendingLinkReferral,
  findPendingLinkReferralForContact,
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
  // Query-count proxy for "no N+1" assertions: one `.from(table)` call = one
  // round-trip query, since every real Supabase query chain starts with it.
  const fromCalls: Record<string, number> = {};

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
    fromCalls[table] = (fromCalls[table] ?? 0) + 1;
    const rows = tables[table] ?? (tables[table] = []);
    const state = {
      insertRow: null as Row | null,
      updateRow: null as Row | null,
      filters: [] as Array<(r: Row) => boolean>,
      isUpdate: false,
      isInsert: false,
      // PR 2: consumeCredits orders its update-return oldest-first. Only the
      // `then()` array-returning path honors it (see below) — real Postgres
      // ordering of a single-row maybeSingle()/single() result is moot.
      orderCol: null as string | null,
      orderAsc: true,
    };
    const match = () => rows.filter((r) => state.filters.every((f) => f(r)));
    const sorted = (arr: Row[]) => {
      if (!state.orderCol) return arr;
      const col = state.orderCol;
      const dir = state.orderAsc ? 1 : -1;
      return [...arr].sort((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        return av > bv ? dir : av < bv ? -dir : 0;
      });
    };

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
      in: (col: string, vals: unknown[]) => {
        state.filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      gte: (col: string, val: string) => {
        state.filters.push((r) => (r[col] as string) >= val);
        return builder;
      },
      // Minimal PostgREST .or() DSL parser (mirrors src/lib/customers.test.ts):
      // supports the two forms the expiry guard needs — `col.is.null` and
      // `col.gt.<iso-string>` — joined by a plain comma (no nested parens in
      // our usage, so no need for the paren-aware split).
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
      order: (col: string, opts?: { ascending?: boolean }) => {
        state.orderCol = col;
        state.orderAsc = opts?.ascending !== false;
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
      // Used by accrueOnBooking / creditBalanceFor / consumeCredits: array-
      // returning update/select (no single row expected) — thenable so `await`
      // resolves it directly. Full row spread (not just {id}) so a caller that
      // selected extra columns (e.g. consumeCredits' amount_usd) sees them.
      then: (resolve: (v: unknown) => void) => {
        if (state.isUpdate) {
          const targets = sorted(match());
          for (const t of targets) Object.assign(t, state.updateRow);
          resolve({ data: targets.map((t) => ({ ...t })), error: null });
          return;
        }
        resolve({ data: sorted(match()), error: null });
      },
    };
    return builder;
  }

  return { from, fromCalls };
}

beforeEach(() => {
  sbRef.current = null;
  hl.upsertContactCustomField.mockClear();
  hl.sendSms.mockClear();
  hl.sendSms.mockResolvedValue({ messageId: 'sms-1' });
  hl.sendEmail.mockClear();
  hl.sendEmail.mockResolvedValue({ messageId: 'email-1' });
  hl.configured.value = false;
  afterCalls.count = 0;
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

  it('review fix 8: schedules the GHL stamp THROUGH after(), not a detached call', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK = 'field_referral_link';
    hl.configured.value = true;
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: null, hl_contact_id: 'contact_1' }],
    });
    await ensureReferralCode('c1');
    expect(afterCalls.count).toBe(1);
  });

  it('review fix 8: after() is still scheduled on a first mint with nothing to stamp (no linked contact), but the stamp itself no-ops', async () => {
    // after() is called unconditionally whenever a code is newly claimed;
    // stampReferralLinkOnContact's OWN fail-open guard (no hl_contact_id) is
    // what actually skips the GHL call, not a check before scheduling it.
    hl.configured.value = true;
    process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK = 'field_referral_link';
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: null, hl_contact_id: null }],
    });
    await ensureReferralCode('c1');
    expect(afterCalls.count).toBe(1);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
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

describe('hasReferralCode (review fix 4)', () => {
  it('returns false when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await hasReferralCode('c1')).toBe(false);
  });

  it('returns false for an unknown customer', async () => {
    sbRef.current = makeFakeSupabase({ customers: [] });
    expect(await hasReferralCode('missing')).toBe(false);
  });

  it('returns false when the customer has no code yet', async () => {
    sbRef.current = makeFakeSupabase({ customers: [{ id: 'c1', referral_code: null, hl_contact_id: null }] });
    expect(await hasReferralCode('c1')).toBe(false);
  });

  it('returns true when the customer already has a code, matching the same column ensureReferralCode checks', async () => {
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: 'EXISTING1', hl_contact_id: null }],
    });
    expect(await hasReferralCode('c1')).toBe(true);
  });

  it('flips to true after ensureReferralCode mints a code for the SAME customer', async () => {
    sbRef.current = makeFakeSupabase({ customers: [{ id: 'c1', referral_code: null, hl_contact_id: null }] });
    expect(await hasReferralCode('c1')).toBe(false);
    await ensureReferralCode('c1');
    expect(await hasReferralCode('c1')).toBe(true);
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

  // Self-referral guard (PR 2): a customer referring themselves would mint a
  // free $125 credit with no new business behind it.
  it('refuses (logs + returns null) when refereeCustomerId equals the referrer — no row created', async () => {
    sbRef.current = makeFakeSupabase();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await createPendingReferral({
      source: 'mention',
      referrerCustomerId: 'c1',
      refereeQuoteId: 'q1',
      refereeCustomerId: 'c1',
    });
    expect(res).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('self-referral'));
    errSpy.mockRestore();
  });

  it('still creates the referral when refereeCustomerId is a DIFFERENT customer', async () => {
    sbRef.current = makeFakeSupabase();
    const res = await createPendingReferral({
      source: 'mention',
      referrerCustomerId: 'c1',
      refereeQuoteId: 'q1',
      refereeCustomerId: 'c2',
    });
    expect(res).not.toBeNull();
  });

  it('does not run the guard when refereeCustomerId is omitted (unknown, e.g. a "link" row)', async () => {
    sbRef.current = makeFakeSupabase();
    const res = await createPendingReferral({ source: 'link', referrerCustomerId: 'c1' });
    expect(res).not.toBeNull();
  });
});

// #41 adversarial-review LOW fix: the submit route's duplicate-submit guard.
// A resubmitted/refreshed landing-page form (same phone, same referrer)
// shouldn't mint a second GHL contact + pending referral row.
describe('hasRecentPendingLinkReferral (submit dedupe)', () => {
  const NOW = '2026-03-10T12:00:00Z';
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is true when an identical (normalized) phone already has a pending link row for the SAME referrer, recently', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        {
          id: 'r1', referrer_customer_id: 'c1', source: 'link', status: 'pending',
          referee_contact_phone: '(516) 555-0123', created_at: '2026-03-10T10:00:00Z',
        },
      ],
    });
    // A different formatting of the SAME number — normalizePhone collapses both.
    expect(await hasRecentPendingLinkReferral('c1', '5165550123')).toBe(true);
  });

  it('is false when the phone differs', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', source: 'link', status: 'pending', referee_contact_phone: '5165550999', created_at: '2026-03-10T10:00:00Z' },
      ],
    });
    expect(await hasRecentPendingLinkReferral('c1', '5165550123')).toBe(false);
  });

  it('is false for a DIFFERENT referrer with the same phone', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c-other', source: 'link', status: 'pending', referee_contact_phone: '5165550123', created_at: '2026-03-10T10:00:00Z' },
      ],
    });
    expect(await hasRecentPendingLinkReferral('c1', '5165550123')).toBe(false);
  });

  it('is false when the matching row is OUTSIDE the recent window', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', source: 'link', status: 'pending', referee_contact_phone: '5165550123', created_at: '2026-03-01T00:00:00Z' },
      ],
    });
    expect(await hasRecentPendingLinkReferral('c1', '5165550123')).toBe(false);
  });

  it('is false when there is no pending link row at all', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    expect(await hasRecentPendingLinkReferral('c1', '5165550123')).toBe(false);
  });

  it('never throws when Supabase is not configured — fail-open (a lookup hiccup must never block a genuine new lead)', async () => {
    sbRef.current = null;
    await expect(hasRecentPendingLinkReferral('c1', '5165550123')).resolves.toBe(false);
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

// #41 adversarial-review fix: a cancelled order never happened, so a
// referrer must not keep 'booked' credit it earned for it. Mirrors
// accrueOnBooking's exact fail-open + conditional-claim idiom, just the
// reverse direction (booked -> pending instead of pending -> booked).
describe('releaseAccrualOnCancel (cancellation reversal)', () => {
  it('flips a BOOKED referral for the cancelled quote back to pending + clears booked_at', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'booked', booked_at: '2026-02-01T00:00:00Z', amount_usd: 125 }],
    });
    const res = await releaseAccrualOnCancel('q1');
    expect(res).toEqual({ released: true });
    const row = await refereeReferralFor('q1');
    expect(row?.status).toBe('pending');
  });

  it('clears expires_at along with booked_at — a pending row never carries a stale expiry (#41 expiry)', async () => {
    const sb = makeFakeSupabase({
      referrals: [
        {
          id: 'r1',
          referee_quote_id: 'q1',
          status: 'booked',
          booked_at: '2026-02-01T00:00:00Z',
          expires_at: '2028-02-01T00:00:00Z',
          amount_usd: 125,
        },
      ],
    });
    sbRef.current = sb;
    await releaseAccrualOnCancel('q1');
    const readBack = sb.from('referrals') as unknown as { select: (c: string) => Promise<{ data: Row[] }> };
    const { data } = await readBack.select('*');
    expect(data[0].status).toBe('pending');
    expect(data[0].booked_at).toBeNull();
    expect(data[0].expires_at).toBeNull();
  });

  it('leaves a CREDITED row alone — a spent credit is a manual/accounting matter, not auto-reversed', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referee_quote_id: 'q1', status: 'credited', credited_at: '2026-03-01T00:00:00Z', credited_quote_id: 'q-spend', amount_usd: 125 },
      ],
    });
    const res = await releaseAccrualOnCancel('q1');
    expect(res).toEqual({ released: false });
    const row = await refereeReferralFor('q1');
    expect(row?.status).toBe('credited'); // untouched
  });

  it('is a no-op when no booked referral exists for that quote (most cancellations have none)', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    expect(await releaseAccrualOnCancel('q-no-referral')).toEqual({ released: false });
  });

  it('never throws when Supabase is not configured — fail-open (must never break cancel)', async () => {
    sbRef.current = null;
    await expect(releaseAccrualOnCancel('q1')).resolves.toEqual({ released: false });
  });

  it('fails open when the update call itself throws — must never break the cancel it is called from', async () => {
    sbRef.current = { from: () => { throw new Error('boom'); } };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(releaseAccrualOnCancel('q1')).resolves.toEqual({ released: false });
    errSpy.mockRestore();
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
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', name: 'Jordan Smith', email: 'jordan@example.com', phone: '5165550100', hl_contact_id: 'contact_1', referral_code: 'ABCD1234' }],
      quotes: [{ id: 'q1', customer_name: 'Sam Rivera' }],
    });
    await expect(
      notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 }),
    ).resolves.toBeUndefined();
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
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
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', phone: '5165550100', email: 'jordan@example.com', hl_contact_id: 'contact_1' }],
    });
    await expect(
      notifyReferrerEarned({ referrerCustomerId: 'c1', refereeQuoteId: 'q1', amountUsd: 125 }),
    ).resolves.toBeUndefined();
    errSpy.mockRestore();
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
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'pending', amount_usd: 125, referrer_customer_id: 'c1' }],
      customers: [{ id: 'c1', phone: '5165550100', email: 'j@example.com', hl_contact_id: 'contact_1' }],
      quotes: [{ id: 'q1', customer_name: 'Sam Rivera' }],
    });
    const res = await accrueOnBooking('q1');
    expect(res).toEqual({ accrued: true });
    errSpy.mockRestore();
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

// ─── Redemption (PR 2) ──────────────────────────────────────────────────────

describe('refereeReferralFor', () => {
  it('returns the referral row where this quote is the referee, regardless of status', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referee_quote_id: 'q1', status: 'booked', amount_usd: 125 }],
    });
    // toMatchObject, not toEqual: the fake doesn't model real Postgres column
    // projection (a real .select('id, status') would return ONLY those two).
    expect(await refereeReferralFor('q1')).toMatchObject({ id: 'r1', status: 'booked' });
  });

  it('returns null when this quote is not a referee on any row', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    expect(await refereeReferralFor('q-no-referral')).toBeNull();
  });

  it('returns null when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await refereeReferralFor('q1')).toBeNull();
  });
});

describe('consumeCredits (redemption, PR 2)', () => {
  it('consumes ALL booked rows for the referrer, oldest first, and drains the balance to 0', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r2', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, created_at: '2026-02-01T00:00:00Z' },
        { id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, created_at: '2026-01-01T00:00:00Z' },
      ],
    });
    const res = await consumeCredits('c1', 'q1', 250);
    expect(res.consumed).toBe(true);
    expect(res.consumedRowIds).toEqual(['r1', 'r2']); // oldest (r1) first, regardless of insertion order
    expect(res.consumedUsd).toBe(250);
    expect(res.newBalanceUsd).toBe(0);
  });

  it('clamp math: applying a smaller amountUsd than the balance still consumes the WHOLE balance (locked simplification)', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, created_at: '2026-01-01T00:00:00Z' },
        { id: 'r2', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, created_at: '2026-02-01T00:00:00Z' },
      ],
    });
    // e.g. an $80 quote subtotal clamps the discount below the $250 balance —
    // the excess is lost, not banked (see consumeCredits' doc comment).
    const res = await consumeCredits('c1', 'q1', 80);
    expect(res.consumed).toBe(true);
    expect(res.consumedRowIds).toEqual(['r1', 'r2']); // still ALL rows, not "enough for $80"
    expect(res.newBalanceUsd).toBe(0);
  });

  it('is idempotent-ish under a double click — the second call finds zero booked rows', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, created_at: '2026-01-01T00:00:00Z' }],
    });
    const first = await consumeCredits('c1', 'q1', 125);
    const second = await consumeCredits('c1', 'q1', 125);
    expect(first).toEqual({ consumed: true, consumedRowIds: ['r1'], consumedUsd: 125, newBalanceUsd: 0 });
    expect(second).toEqual({ consumed: false, consumedRowIds: [], consumedUsd: 0, newBalanceUsd: 0 });
  });

  it('refuses when amountUsd exceeds the live balance (a stale client figure) — no rows touched', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, created_at: '2026-01-01T00:00:00Z' }],
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await consumeCredits('c1', 'q1', 250); // balance is only 125
    expect(res.consumed).toBe(false);
    expect(res.newBalanceUsd).toBe(125); // untouched
    expect(await creditBalanceFor('c1')).toBe(125); // still spendable — nothing flipped
    errSpy.mockRestore();
  });

  it('is a no-op when the referrer has no booked credit', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await consumeCredits('c1', 'q1', 125);
    expect(res).toEqual({ consumed: false, consumedRowIds: [], consumedUsd: 0, newBalanceUsd: 0 });
    errSpy.mockRestore();
  });

  it('never throws when Supabase is not configured — fail-open', async () => {
    sbRef.current = null;
    await expect(consumeCredits('c1', 'q1', 125)).resolves.toEqual({
      consumed: false,
      consumedRowIds: [],
      consumedUsd: 0,
      newBalanceUsd: 0,
    });
  });

  it('never claims an EXPIRED booked row — consumedUsd matches the balance the caller was shown (#41 expiry)', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sb = makeFakeSupabase({
      referrals: [
        { id: 'r-expired', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, expires_at: past, created_at: '2024-01-01T00:00:00Z' },
        { id: 'r-live', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, expires_at: null, created_at: '2026-01-01T00:00:00Z' },
      ],
    });
    sbRef.current = sb;
    // Balance (expiry-aware) is 125; the claim must flip ONLY the live row.
    const res = await consumeCredits('c1', 'q1', 125);
    expect(res.consumed).toBe(true);
    expect(res.consumedRowIds).toEqual(['r-live']);
    expect(res.consumedUsd).toBe(125);
    const readBack = sb.from('referrals') as unknown as { select: (c: string) => Promise<{ data: Row[] }> };
    const { data } = await readBack.select('*');
    const expiredRow = data.find((r) => r.id === 'r-expired');
    expect(expiredRow?.status).toBe('booked'); // stays booked-but-expired forever, never spent
    expect(expiredRow?.credited_quote_id).toBeUndefined();
  });

  it('refuses when the ONLY booked rows are expired — balance is 0, nothing to spend (#41 expiry)', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r-expired', referrer_customer_id: 'c1', status: 'booked', amount_usd: 125, expires_at: past, created_at: '2024-01-01T00:00:00Z' },
      ],
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await consumeCredits('c1', 'q1', 125);
    expect(res.consumed).toBe(false);
    expect(res.consumedRowIds).toEqual([]);
    errSpy.mockRestore();
  });
});

// #41 adversarial-review MED fix: the "Remove referral credit" undo — the
// exact atomic-claim idiom as consumeCredits, reversed (credited -> booked
// instead of booked -> credited), scoped to THIS quote's own credited rows.
describe('releaseCredits (undo redemption)', () => {
  it('flips ALL rows this quote credited back to booked, clearing credited_at/credited_quote_id', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', status: 'credited', credited_at: '2026-03-01T00:00:00Z', credited_quote_id: 'q-spend', amount_usd: 125 },
        { id: 'r2', referrer_customer_id: 'c1', status: 'credited', credited_at: '2026-03-01T00:00:00Z', credited_quote_id: 'q-spend', amount_usd: 125 },
      ],
    });
    const res = await releaseCredits('c1', 'q-spend');
    expect(res.released).toBe(true);
    expect(res.releasedRowIds.sort()).toEqual(['r1', 'r2']);
    expect(res.releasedUsd).toBe(250);
    expect(await creditBalanceFor('c1')).toBe(250); // spendable again
  });

  it('only touches rows credited to THIS quote — a different quote\'s credited row is untouched', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', status: 'credited', credited_quote_id: 'q-spend-A', amount_usd: 125 },
        { id: 'r2', referrer_customer_id: 'c1', status: 'credited', credited_quote_id: 'q-spend-B', amount_usd: 125 },
      ],
    });
    const res = await releaseCredits('c1', 'q-spend-A');
    expect(res.released).toBe(true);
    expect(res.releasedRowIds).toEqual(['r1']);
    // q-spend-B's row is untouched — still credited, still spent.
    expect(await creditBalanceFor('c1')).toBe(125); // only r1 became spendable again
  });

  it('only touches rows for THIS referrer — a different customer\'s row credited to the same quote id is untouched (defense in depth)', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', status: 'credited', credited_quote_id: 'q-spend', amount_usd: 125 },
        { id: 'r2', referrer_customer_id: 'c-other', status: 'credited', credited_quote_id: 'q-spend', amount_usd: 125 },
      ],
    });
    const res = await releaseCredits('c1', 'q-spend');
    expect(res.releasedRowIds).toEqual(['r1']);
    expect(await creditBalanceFor('c-other')).toBe(0); // c-other's row untouched
  });

  it('is idempotent — calling it again after a successful release finds zero credited rows', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ id: 'r1', referrer_customer_id: 'c1', status: 'credited', credited_quote_id: 'q-spend', amount_usd: 125 }],
    });
    const first = await releaseCredits('c1', 'q-spend');
    const second = await releaseCredits('c1', 'q-spend');
    expect(first).toEqual({ released: true, releasedRowIds: ['r1'], releasedUsd: 125 });
    expect(second).toEqual({ released: false, releasedRowIds: [], releasedUsd: 0 });
  });

  it('is a no-op when this quote never credited anything for this customer', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    expect(await releaseCredits('c1', 'q-spend')).toEqual({ released: false, releasedRowIds: [], releasedUsd: 0 });
  });

  it('never throws when Supabase is not configured — fail-open', async () => {
    sbRef.current = null;
    await expect(releaseCredits('c1', 'q-spend')).resolves.toEqual({
      released: false,
      releasedRowIds: [],
      releasedUsd: 0,
    });
  });
});

// ─── Customer profile panel (PR 2) ─────────────────────────────────────────

describe('listReferralsFor', () => {
  it('returns rows newest-first with a summary rolled up by status', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        {
          id: 'r1',
          referrer_customer_id: 'c1',
          referee_quote_id: null,
          referee_contact_name: 'Sam Rivera',
          source: 'link',
          status: 'pending',
          amount_usd: 125,
          booked_at: null,
          credited_at: null,
          credited_quote_id: null,
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'r2',
          referrer_customer_id: 'c1',
          referee_quote_id: 'q2',
          referee_contact_name: 'Jordan Lee',
          source: 'mention',
          status: 'booked',
          amount_usd: 125,
          booked_at: '2026-02-15T00:00:00Z',
          credited_at: null,
          credited_quote_id: null,
          created_at: '2026-02-01T00:00:00Z',
        },
        {
          id: 'r3',
          referrer_customer_id: 'c1',
          referee_quote_id: 'q3',
          referee_contact_name: 'Alex Chen',
          source: 'mention',
          status: 'credited',
          amount_usd: 125,
          booked_at: '2026-01-15T00:00:00Z',
          credited_at: '2026-03-01T00:00:00Z',
          credited_quote_id: 'q-spend',
          created_at: '2026-01-05T00:00:00Z',
        },
        {
          id: 'r-other',
          referrer_customer_id: 'c-someone-else',
          referee_quote_id: null,
          referee_contact_name: 'Not This Customer',
          source: 'link',
          status: 'pending',
          amount_usd: 125,
          booked_at: null,
          credited_at: null,
          credited_quote_id: null,
          created_at: '2026-02-10T00:00:00Z',
        },
      ],
    });

    const { items, summary } = await listReferralsFor('c1');

    expect(items.map((i) => i.id)).toEqual(['r2', 'r3', 'r1']); // newest created_at first, other customer excluded
    expect(items[0]).toMatchObject({ id: 'r2', displayName: 'Jordan Lee', status: 'booked', amountUsd: 125 });
    expect(summary).toEqual({
      pendingCount: 1,
      bookedCount: 1,
      expiredCount: 0,
      creditedCount: 1,
      spendableUsd: 125, // only the 'booked' row (r2) is spendable
      lifetimeEarnedUsd: 250, // booked (r2) + credited (r3)
    });
  });

  it('surfaces a booked-but-expired row as expired: counted separately, excluded from bookedCount/spendableUsd, still in lifetime (#41 expiry)', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    sbRef.current = makeFakeSupabase({
      referrals: [
        {
          id: 'r-live',
          referrer_customer_id: 'c1',
          referee_quote_id: null,
          referee_contact_name: 'Still Good',
          source: 'link',
          status: 'booked',
          amount_usd: 125,
          booked_at: '2026-06-01T00:00:00Z',
          expires_at: future,
          credited_at: null,
          credited_quote_id: null,
          created_at: '2026-06-01T00:00:00Z',
        },
        {
          id: 'r-expired',
          referrer_customer_id: 'c1',
          referee_quote_id: null,
          referee_contact_name: 'Too Late',
          source: 'link',
          status: 'booked',
          amount_usd: 125,
          booked_at: '2024-01-01T00:00:00Z',
          expires_at: past,
          credited_at: null,
          credited_quote_id: null,
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
    });

    const { items, summary } = await listReferralsFor('c1');

    const live = items.find((i) => i.id === 'r-live');
    const expired = items.find((i) => i.id === 'r-expired');
    expect(live).toMatchObject({ status: 'booked', expired: false, expiresAt: future });
    expect(expired).toMatchObject({ status: 'booked', expired: true, expiresAt: past });
    expect(summary).toEqual({
      pendingCount: 0,
      bookedCount: 1, // only the still-spendable booked row
      expiredCount: 1,
      creditedCount: 0,
      spendableUsd: 125, // creditBalanceFor's own expiry filter agrees
      lifetimeEarnedUsd: 250, // the expired credit WAS earned — history is not rewritten
    });
  });

  it('falls back to the referee quote customer_name in ONE batched lookup when no contact name is on file', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        {
          id: 'r1',
          referrer_customer_id: 'c1',
          referee_quote_id: 'q1',
          referee_contact_name: null,
          source: 'mention',
          status: 'booked',
          amount_usd: 125,
          booked_at: '2026-01-02T00:00:00Z',
          credited_at: null,
          credited_quote_id: null,
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'r2',
          referrer_customer_id: 'c1',
          referee_quote_id: 'q2',
          referee_contact_name: null,
          source: 'mention',
          status: 'pending',
          amount_usd: 125,
          booked_at: null,
          credited_at: null,
          credited_quote_id: null,
          created_at: '2026-01-03T00:00:00Z',
        },
      ],
      quotes: [
        { id: 'q1', customer_name: 'Taylor from the quote' },
        { id: 'q2', customer_name: 'Morgan from the quote' },
      ],
    });

    const { items } = await listReferralsFor('c1');
    expect(items.find((i) => i.id === 'r1')?.displayName).toBe('Taylor from the quote');
    expect(items.find((i) => i.id === 'r2')?.displayName).toBe('Morgan from the quote');
    // The real no-N+1 assertion: exactly ONE `.from('quotes')` round-trip
    // covers BOTH rows' name fallback, not one query per row.
    expect((sbRef.current as { fromCalls: Record<string, number> }).fromCalls.quotes).toBe(1);
  });

  it('falls back to a plain label when neither a contact name nor a quote name is available', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        {
          id: 'r1',
          referrer_customer_id: 'c1',
          referee_quote_id: null,
          referee_contact_name: null,
          source: 'link',
          status: 'pending',
          amount_usd: 125,
          booked_at: null,
          credited_at: null,
          credited_quote_id: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const { items } = await listReferralsFor('c1');
    expect(items[0].displayName).toBe('Unnamed friend');
  });

  it('returns an empty result for a customer with no referrals', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [] });
    expect(await listReferralsFor('c1')).toEqual({
      items: [],
      summary: { pendingCount: 0, bookedCount: 0, expiredCount: 0, creditedCount: 0, spendableUsd: 0, lifetimeEarnedUsd: 0 },
    });
  });

  it('returns an empty result when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await listReferralsFor('c1')).toEqual({
      items: [],
      summary: { pendingCount: 0, bookedCount: 0, expiredCount: 0, creditedCount: 0, spendableUsd: 0, lifetimeEarnedUsd: 0 },
    });
  });
});

describe('getReferralPhotoOptout / setReferralPhotoOptout', () => {
  it('reads the current flag off the customer row (false = use their photo)', async () => {
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: 'ABCD1234', referral_photo_optout: false }],
    });
    expect(await getReferralPhotoOptout('c1')).toBe(false);
  });

  it('reads a true opt-out', async () => {
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: 'ABCD1234', referral_photo_optout: true }],
    });
    expect(await getReferralPhotoOptout('c1')).toBe(true);
  });

  it('defaults to false (use their photo) when the customer row has no flag set', async () => {
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: 'ABCD1234' }],
    });
    expect(await getReferralPhotoOptout('c1')).toBe(false);
  });

  it('defaults to false when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await getReferralPhotoOptout('c1')).toBe(false);
  });

  it('sets the flag and a subsequent read reflects it', async () => {
    sbRef.current = makeFakeSupabase({
      customers: [{ id: 'c1', referral_code: 'ABCD1234', referral_photo_optout: false }],
    });
    const ok = await setReferralPhotoOptout('c1', true);
    expect(ok).toBe(true);
    expect(await getReferralPhotoOptout('c1')).toBe(true);
  });

  it('returns false when the customer row does not exist', async () => {
    sbRef.current = makeFakeSupabase({ customers: [] });
    expect(await setReferralPhotoOptout('missing', true)).toBe(false);
  });

  it('returns false when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await setReferralPhotoOptout('c1', true)).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// findPendingLinkReferralForContact — the prefill lookup (ledger: the S72
// wrap's attribution gap, Naldo 2026-08-29).
//
// The referral program's whole failure mode is that a staffer must remember
// to pick "Referred by" while building the referred friend's quote, before
// the deposit is taken, or the referrer's $125 is unreachable without a
// developer. This lookup is what lets the quote builder SAY "this lead came
// from someone's link" instead of relying on memory.
//
// Written test-first because it decides who gets paid. The failure list
// below was enumerated before the implementation existed: wrong-source and
// wrong-status rows must never match, a self-referral must never be
// suggested, and phone/email formatting must not decide whether a real
// referral is found.
// ─────────────────────────────────────────────────────────────────────────
describe('findPendingLinkReferralForContact (quote-builder prefill)', () => {
  const REF = {
    id: 'r1',
    referrer_customer_id: 'c-referrer',
    source: 'link',
    status: 'pending',
    referee_contact_name: 'Sam Friend',
    referee_contact_email: 'Sam.Friend@Example.com',
    referee_contact_phone: '(516) 555-0123',
    created_at: '2026-03-10T10:00:00Z',
  };
  const REFERRER = { id: 'c-referrer', name: 'Dana Whitfield', referral_code: 'AB12CD34' };

  it('returns null when neither a phone nor an email is supplied', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [REF], customers: [REFERRER] });
    expect(await findPendingLinkReferralForContact({})).toBeNull();
    expect(await findPendingLinkReferralForContact({ phone: '  ', email: '' })).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [REF], customers: [REFERRER] });
    expect(await findPendingLinkReferralForContact({ phone: '5169999999' })).toBeNull();
  });

  it('matches on phone regardless of formatting, and names the referrer', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [REF], customers: [REFERRER] });
    const hit = await findPendingLinkReferralForContact({ phone: '+1 516-555-0123' });
    expect(hit).toMatchObject({
      referralId: 'r1',
      referrerCustomerId: 'c-referrer',
      referrerName: 'Dana Whitfield',
      matchedOn: 'phone',
    });
  });

  it('matches on email case-insensitively', async () => {
    sbRef.current = makeFakeSupabase({ referrals: [REF], customers: [REFERRER] });
    const hit = await findPendingLinkReferralForContact({ email: 'sam.friend@example.com' });
    expect(hit).toMatchObject({ referralId: 'r1', matchedOn: 'email' });
  });

  it('NEVER matches a mention row: only a link row means someone used a link', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [{ ...REF, source: 'mention' }],
      customers: [REFERRER],
    });
    expect(await findPendingLinkReferralForContact({ phone: '5165550123' })).toBeNull();
  });

  it('NEVER matches an already-settled referral (booked, credited, expired)', async () => {
    for (const status of ['booked', 'credited', 'expired']) {
      sbRef.current = makeFakeSupabase({
        referrals: [{ ...REF, status }],
        customers: [REFERRER],
      });
      expect(await findPendingLinkReferralForContact({ phone: '5165550123' })).toBeNull();
    }
  });

  it('refuses to suggest a SELF-referral, even when the phone matches', async () => {
    // The referrer and this quote's customer are the same person. Suggesting
    // it would invite a staffer to pay someone $125 for referring themselves.
    sbRef.current = makeFakeSupabase({ referrals: [REF], customers: [REFERRER] });
    const hit = await findPendingLinkReferralForContact({
      phone: '5165550123',
      excludeCustomerId: 'c-referrer',
    });
    expect(hit).toBeNull();
  });

  it('returns the most recent pending link row when a lead used two links', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [
        { ...REF, id: 'r-old', referrer_customer_id: 'c-old', created_at: '2026-03-01T10:00:00Z' },
        { ...REF, id: 'r-new', referrer_customer_id: 'c-referrer', created_at: '2026-03-09T10:00:00Z' },
      ],
      customers: [REFERRER, { id: 'c-old', name: 'Older Referrer' }],
    });
    const hit = await findPendingLinkReferralForContact({ phone: '5165550123' });
    expect(hit?.referralId).toBe('r-new');
  });

  it('still returns the match when the referrer row has no name on file', async () => {
    sbRef.current = makeFakeSupabase({
      referrals: [REF],
      customers: [{ id: 'c-referrer', name: null }],
    });
    const hit = await findPendingLinkReferralForContact({ phone: '5165550123' });
    expect(hit).toMatchObject({ referrerCustomerId: 'c-referrer', referrerName: null });
  });

  it('returns null (never throws) when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await findPendingLinkReferralForContact({ phone: '5165550123' })).toBeNull();
  });
});
