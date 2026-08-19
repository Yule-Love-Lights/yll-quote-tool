import { describe, it, expect, beforeEach, vi } from 'vitest';

// Phase 5 customer/property identity. The pure dedup rules (match key, phone +
// address normalization) are tested directly; the DB helpers run against a small
// in-memory Supabase fake that models the query shapes customers.ts uses
// (select/insert/update + eq/is/order/limit + maybeSingle/single + bare await).

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

import {
  customerMatchKey,
  normalizePhone,
  normalizeAddress,
  findOrCreateCustomer,
  findOrCreateProperty,
  attachQuoteToCustomer,
  backfillCustomersFromQuotes,
  getCustomer,
  getPropertiesForCustomer,
  getCustomerByHlContactId,
  listCustomerTagsByIds,
  propagateQuoteTagsToCustomer,
  setCustomerTags,
  quoteRowToIdentity,
  updateProperty,
  archiveProperty,
  unarchiveProperty,
  createPropertyForCustomer,
} from './customers';

// ─── #214: quoteRowToIdentity — stored-row → attach identity ────────────────
// saveQuote persists a blank name as 'Anonymous' and a blank address as
// '(no address)'; those display sentinels must never become identity evidence
// (a name:anonymous match_key would fold every contactless quote onto ONE
// customer row, and a literal-sentinel name forces false field disagreements).
describe('quoteRowToIdentity (#214)', () => {
  it("translates the 'Anonymous' name sentinel to null", () => {
    const id = quoteRowToIdentity({ id: 'q1', customer_name: 'Anonymous' });
    expect(id.customer_name).toBeNull();
  });

  it("translates the '(no address)' sentinel to null", () => {
    const id = quoteRowToIdentity({ id: 'q1', customer_address: '(no address)' });
    expect(id.customer_address).toBeNull();
  });

  it('keeps real values, trimming whitespace', () => {
    const id = quoteRowToIdentity({
      id: 'q1',
      highlevel_contact_id: ' hl-1 ',
      customer_name: ' Jane Doe ',
      customer_email: 'jane@x.com',
      customer_phone: '(631) 555-0100',
      customer_address: '1 A St',
    });
    expect(id).toEqual({
      id: 'q1',
      highlevel_contact_id: 'hl-1',
      customer_name: 'Jane Doe',
      customer_email: 'jane@x.com',
      customer_phone: '(631) 555-0100',
      customer_address: '1 A St',
    });
  });

  it('nulls blank/whitespace/missing fields', () => {
    const id = quoteRowToIdentity({ id: 'q1', customer_name: '   ', customer_email: '' });
    expect(id).toEqual({
      id: 'q1',
      highlevel_contact_id: null,
      customer_name: null,
      customer_email: null,
      customer_phone: null,
      customer_address: null,
    });
  });

  it('derives NO match key for a sentinel-only row (the fold-onto-one-customer failure)', () => {
    const id = quoteRowToIdentity({
      id: 'q1',
      customer_name: 'Anonymous',
      customer_address: '(no address)',
    });
    // Mapped exactly the way attachQuoteToCustomer feeds findOrCreateCustomer.
    expect(
      customerMatchKey({
        hl_contact_id: id.highlevel_contact_id,
        name: id.customer_name,
        email: id.customer_email,
        phone: id.customer_phone,
      }),
    ).toBeNull();
  });
});

// ─── In-memory Supabase fake ────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeSupabase(initial: { quotes?: Row[]; customers?: Row[]; properties?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    customers: initial.customers ? initial.customers.map((r) => ({ ...r })) : [],
    properties: initial.properties ? initial.properties.map((r) => ({ ...r })) : [],
    quotes: initial.quotes ? initial.quotes.map((r) => ({ ...r })) : [],
  };
  let counter = 0;
  // W2-010: lets a test force the NEXT insert on a given table to fail with a
  // unique-violation (23505), simulating a concurrent-create race — the retry
  // re-select is the code path this recovers via.
  const forceInsertErrorOnce: Partial<Record<string, { code: string; message: string }>> = {};
  // #205 (F4 test infra): lets a test force the NEXT plain SELECT on a given
  // table to fail — models a pre-migration "column does not exist" error on
  // findOrCreateProperty's existing-row lookup (archived_at added by a
  // migration this PR ships but doesn't apply). Scoped to the plain-select
  // fallback only (never insert/update), same one-shot-consume shape as
  // forceInsertErrorOnce above.
  const forceSelectErrorOnce: Partial<Record<string, { message: string }>> = {};

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const state = {
      op: null as null | 'select' | 'insert' | 'update',
      insertRow: null as Row | null,
      updateRow: null as Row | null,
      filters: [] as Array<(r: Row) => boolean>,
      orderBy: null as null | { col: string; asc: boolean },
      limitN: null as number | null,
    };

    const match = () => {
      let out = rows.filter((r) => state.filters.every((f) => f(r)));
      if (state.orderBy) {
        const { col, asc } = state.orderBy;
        out = [...out].sort((a, b) => {
          const av = a[col] as never;
          const bv = b[col] as never;
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return asc ? cmp : -cmp;
        });
      }
      if (state.limitN != null) out = out.slice(0, state.limitN);
      return out;
    };
    // Mirrors the REAL unique indexes (2026-06-27-customers-properties.sql):
    // UNIQUE(match_key) on customers, UNIQUE(customer_id, address_key) on
    // properties. A concurrent insert that collides on these gets a genuine
    // 23505 from Postgres — model that here so a same-key race in a
    // Promise.all chunk (W2-011) exercises the SAME recovery path a real DB
    // would force, instead of silently duplicating rows in-memory.
    const violatesUnique = (row: Row): boolean => {
      if (table === 'customers') return rows.some((r) => r.match_key === row.match_key);
      if (table === 'properties') {
        return rows.some((r) => r.customer_id === row.customer_id && r.address_key === row.address_key);
      }
      return false;
    };
    const doInsert = () => {
      const row = { id: `${table}-${++counter}`, ...state.insertRow };
      rows.push(row);
      return row;
    };
    // #213 (round-2 test infra): mirrors the real UNIQUE(match_key)
    // constraint on customers UPDATEs too (previously only modeled for
    // INSERT) — needed to exercise adopt()'s key-upgrade-hits-UNIQUE retry
    // path (findOrCreateCustomer round-2 fix 3): the plain key can already
    // be legitimately owned by a DIFFERENT row (an earlier-rejected
    // candidate), which a real UPDATE would reject with a 23505 exactly like
    // an INSERT would.
    const doUpdate = (): { matched: Row[]; violated: boolean } => {
      const matched = rows.filter((r) => state.filters.every((f) => f(r)));
      if (table === 'customers' && state.updateRow && 'match_key' in state.updateRow) {
        const newKey = (state.updateRow as Row).match_key;
        const matchedIds = new Set(matched.map((r) => r.id));
        if (rows.some((r) => r.match_key === newKey && !matchedIds.has(r.id))) {
          return { matched: [], violated: true };
        }
      }
      for (const r of matched) Object.assign(r, state.updateRow);
      return { matched, violated: false };
    };
    // Consumes the forced error (once) so only the NEXT insert on this table fails.
    const takeForcedInsertError = () => {
      const err = forceInsertErrorOnce[table];
      if (err) delete forceInsertErrorOnce[table];
      return err ?? null;
    };
    // #205 (F4 test infra): same one-shot consume, for the plain-select fallback.
    const takeForcedSelectError = () => {
      const err = forceSelectErrorOnce[table];
      if (err) delete forceSelectErrorOnce[table];
      return err ?? null;
    };

    const builder = {
      select() {
        if (state.op === null) state.op = 'select';
        return builder;
      },
      insert(row: Row) {
        state.op = 'insert';
        state.insertRow = row;
        return builder;
      },
      update(row: Row) {
        state.op = 'update';
        state.updateRow = row;
        return builder;
      },
      eq(col: string, val: unknown) {
        state.filters.push((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        state.filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      // Minimal PostgREST .or() DSL parser: `col.eq.val` and
      // `col.in.(v1,v2,...)` conditions joined by commas, ORed together.
      or(condsStr: string) {
        const conds = condsStr.split(/,(?![^(]*\))/); // split on commas NOT inside (...)
        const predicates = conds.map((cond) => {
          const eqMatch = cond.match(/^([a-z_]+)\.eq\.(.+)$/);
          if (eqMatch) {
            const [, col, val] = eqMatch;
            return (r: Row) => r[col] === val;
          }
          const inMatch = cond.match(/^([a-z_]+)\.in\.\((.*)\)$/);
          if (inMatch) {
            const [, col, valsStr] = inMatch;
            const vals = valsStr.split(',');
            return (r: Row) => vals.includes(r[col] as string);
          }
          throw new Error(`unsupported .or() condition in fake: ${cond}`);
        });
        state.filters.push((r) => predicates.some((p) => p(r)));
        return builder;
      },
      is(col: string, val: unknown) {
        state.filters.push((r) =>
          val === null ? r[col] === null || r[col] === undefined : r[col] === val,
        );
        return builder;
      },
      not(col: string, _op: string, val: unknown) {
        state.filters.push((r) =>
          !(val === null ? r[col] === null || r[col] === undefined : r[col] === val),
        );
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        state.orderBy = { col, asc: opts?.ascending !== false };
        return builder;
      },
      limit(n: number) {
        state.limitN = n;
        return builder;
      },
      async maybeSingle() {
        if (state.op === 'insert') return { data: doInsert(), error: null };
        // #198: an update chained straight into .maybeSingle() (no bare await)
        // must apply the mutation before reading back — mirrors then()'s
        // existing 'update' handling below (doUpdate), previously only
        // reachable via a bare await in this fake.
        if (state.op === 'update') {
          const { matched, violated } = doUpdate();
          if (violated) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          return { data: matched[0] ?? null, error: null };
        }
        const forcedSelect = takeForcedSelectError();
        if (forcedSelect) return { data: null, error: forcedSelect };
        return { data: match()[0] ?? null, error: null };
      },
      async single() {
        if (state.op === 'insert') {
          const forced = takeForcedInsertError();
          if (forced) return { data: null, error: forced };
          if (state.insertRow && violatesUnique(state.insertRow)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          return { data: doInsert(), error: null };
        }
        const out = match();
        return { data: out[0] ?? null, error: out[0] ? null : { message: 'no rows' } };
      },
      then(resolve: (v: unknown) => void) {
        if (state.op === 'insert') return resolve({ data: doInsert(), error: null });
        if (state.op === 'update') {
          const { matched, violated } = doUpdate();
          if (violated) {
            return resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
          }
          return resolve({ data: matched, error: null });
        }
        return resolve({ data: match(), error: null });
      },
    };
    return builder;
  }

  return {
    client: { from },
    tables,
    forceInsertErrorOnce: (table: string, err: { code: string; message: string }) => {
      forceInsertErrorOnce[table] = err;
    },
    forceSelectErrorOnce: (table: string, err: { message: string }) => {
      forceSelectErrorOnce[table] = err;
    },
  };
}

beforeEach(() => {
  sbRef.current = null;
});

// ─── Pure: match key ────────────────────────────────────────────────────────

describe('customerMatchKey', () => {
  it('prefers HL contact id over everything', () => {
    expect(
      customerMatchKey({ hl_contact_id: 'abc', email: 'a@b.com', phone: '555', name: 'Jo' }),
    ).toBe('hl:abc');
  });
  it('falls back email → phone → name', () => {
    expect(customerMatchKey({ email: 'A@B.com' })).toBe('email:a@b.com');
    expect(customerMatchKey({ phone: '(555) 123-4567' })).toBe('phone:5551234567');
    expect(customerMatchKey({ name: 'Jane Doe' })).toBe('name:jane doe');
  });
  it('returns null when there is no identity at all', () => {
    expect(customerMatchKey({})).toBeNull();
    expect(customerMatchKey({ email: '  ', phone: '', name: null })).toBeNull();
  });
  it('collapses case / whitespace so the same customer dedups', () => {
    expect(customerMatchKey({ email: 'jane@x.com' })).toBe(
      customerMatchKey({ email: ' JANE@X.com ' }),
    );
  });
});

describe('normalizePhone', () => {
  it('strips formatting AND the US country code, so E.164 and 10-digit collapse to one key', () => {
    // The bug this fixes (S42): GHL stores E.164 ('+16315550100') while every
    // form stores 10 digits. The old digit-only strip kept the leading 1, so the
    // same person hashed to phone:16315550100 vs phone:6315550100 -> TWO customer
    // rows, losing rebook history. Both must now produce the same national number.
    expect(normalizePhone('+1 (555) 123-4567')).toBe('5551234567');
    expect(normalizePhone('555.123.4567')).toBe('5551234567');
    expect(normalizePhone('+16315550100')).toBe(normalizePhone('6315550100'));
    expect(normalizePhone('(631) 555-0100')).toBe(normalizePhone('+16315550100'));
  });
  it('strips ONLY the NANP country code — never collapses a longer international number', () => {
    // A blind last-10 slice would merge unrelated people; strip only 11-digit
    // leading-1. '+52 631 555 0100' (Mexico) must NOT equal Long Island 631-555-0100.
    expect(normalizePhone('+526315550100')).not.toBe(normalizePhone('6315550100'));
    expect(normalizePhone('+442079460958')).not.toBe(normalizePhone('2079460958'));
  });
  it('is null without digits', () => {
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('  ')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('normalizeAddress', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeAddress('123 Main St.')).toBe('123 main st');
    expect(normalizeAddress('123  MAIN   st')).toBe('123 main st');
    expect(normalizeAddress('45 Oak Ave, #2')).toBe('45 oak ave 2');
  });
  it('is empty string for a blank address', () => {
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress('   ')).toBe('');
  });
  it('maps trivial formatting differences to one key', () => {
    expect(normalizeAddress('10 Elm St.')).toBe(normalizeAddress('10 elm st'));
  });
});

// ─── DB: find-or-create ─────────────────────────────────────────────────────

describe('findOrCreateCustomer', () => {
  it('creates once then returns the SAME id for a matching identity', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;

    const a = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane' });
    // #213: name repeated so this still clears the >=2-field adopt gate (email
    // alone is a single-field match — see the dedicated describe block below).
    const b = await findOrCreateCustomer({ email: ' JANE@x.com ', name: 'Jane' }); // same key
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBe(a?.id);
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].match_key).toBe('email:jane@x.com');
  });

  // W2-026 (Jason 2026-07-06: newest-win) — a repeat quote for the SAME customer
  // refreshes the stored contact fields to the newer values, instead of the old
  // first-wins behavior that let name/email/phone go stale.
  it('W2-026: refreshes changed contact fields to the newest quote (newest-win)', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const a = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane', phone: '5550001111' });
    // #213: name repeated (email+name agree = 2 fields) so this still clears
    // the adopt gate — only phone actually changes between the two quotes.
    const b = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane', phone: '5559998888' });
    expect(b?.id).toBe(a?.id); // same customer row
    expect(fake.tables.customers).toHaveLength(1); // not a duplicate
    expect(fake.tables.customers[0].phone).toBe('5559998888'); // updated
  });

  it('W2-026: a missing field in the newer quote does NOT wipe the stored value', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const a = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane', phone: '5550001111' });
    // #213: name repeated (email+name agree = 2 fields), phone is simply
    // omitted this time, which is what this test is actually verifying.
    const b = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane' }); // no phone
    expect(b?.id).toBe(a?.id);
    // #213 fix 8: no name assertion here, both calls use the SAME name, so
    // asserting on it would prove nothing about preservation either way.
    expect(fake.tables.customers[0].phone).toBe('5550001111'); // absent, preserved, not wiped
  });

  describe('skipIdentityRefresh (review fix 5)', () => {
    it('leaves an existing row unchanged on the exact match_key path, even when identity fields differ', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;
      const a = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane', phone: '5550001111' });
      // Same person resolves again, but the caller's own source (e.g. a
      // stale GHL record) now claims a different phone.
      const b = await findOrCreateCustomer(
        { email: 'jane@x.com', name: 'Jane', phone: '5559998888' },
        { skipIdentityRefresh: true },
      );
      expect(b?.id).toBe(a?.id); // still resolves to the same customer
      expect(fake.tables.customers).toHaveLength(1); // not a duplicate
      expect(fake.tables.customers[0].phone).toBe('5550001111'); // unchanged, not overwritten
      expect(fake.tables.customers[0].name).toBe('Jane');
    });

    it('leaves an existing row unchanged on the secondary-key merge (adopt) path too, but still upgrades match_key', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;
      // Quote A: email-only customer (not yet HL-linked).
      const a = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane', phone: '5550001111' });
      // This route's identity always carries hl_contact_id (see
      // route.ts's caller), which this row doesn't have yet, so this
      // resolves via the secondary/OR search (adopt()), not the exact
      // match_key path covered by the test above.
      const b = await findOrCreateCustomer(
        { hl_contact_id: 'hl9', email: 'jane@x.com', name: 'Jane', phone: '5559998888' },
        { skipIdentityRefresh: true },
      );
      expect(b?.id).toBe(a?.id);
      expect(fake.tables.customers).toHaveLength(1);
      const row = fake.tables.customers[0];
      // The match_key upgrade still applies (an internal linkage
      // improvement, never a customer-visible field, and the whole point of
      // the merge), but the display/contact columns stay exactly as they
      // were before this call.
      expect(row.match_key).toBe('hl:hl9');
      expect(row.phone).toBe('5550001111');
      expect(row.hl_contact_id).toBeNull();
    });

    it('still creates a brand-new row when none exists', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;
      const result = await findOrCreateCustomer(
        { email: 'brand-new@x.com', name: 'Brand New' },
        { skipIdentityRefresh: true },
      );
      expect(result?.id).toBeTruthy();
      expect(fake.tables.customers).toHaveLength(1);
      expect(fake.tables.customers[0].name).toBe('Brand New');
      expect(fake.tables.customers[0].email).toBe('brand-new@x.com');
    });
  });

  it('separates distinct identities into distinct customers', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    await findOrCreateCustomer({ email: 'a@x.com' });
    await findOrCreateCustomer({ email: 'b@x.com' });
    expect(fake.tables.customers).toHaveLength(2);
  });

  it('returns null (creates nothing) for an identity-less quote', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const r = await findOrCreateCustomer({ name: '   ' });
    expect(r).toBeNull();
    expect(fake.tables.customers).toHaveLength(0);
  });

  // W2-010: the 23505 unique-violation race-recovery branch was never
  // exercised by any test. Simulate a concurrent create — the insert loses the
  // race (another writer already created the same match_key), and the
  // re-select must recover the WINNER's existing row (not null, no dup row).
  // #213 fix 7 (tech LOW): the old version of this test seeded a row with
  // match_key EXACTLY equal to the identity's own key, which the exact-match
  // phase always finds and returns from directly — the forced 23505 was
  // dead, never actually exercised (true pre-#213 too, not something this
  // ticket introduced). Superseded by the '#213 >=2-field...' describe
  // block's 'unique-violation race on the disambiguated (rejected-
  // candidate) create path' test below, which genuinely forces and recovers
  // from a real insert failure.
  it('returns null on a genuine hard insert error (not a recoverable race)', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    fake.forceInsertErrorOnce('customers', { code: '500', message: 'connection reset' });

    const res = await findOrCreateCustomer({ email: 'new@x.com' });

    expect(res).toBeNull(); // retry re-select finds nothing → null, not a throw
    expect(fake.tables.customers).toHaveLength(0);
  });

  // W2-009: match_key precedence (hl > email > phone > name) used to split ONE
  // real customer into TWO rows when their history mixes an HL-linked quote
  // with an email/phone-only quote (the #306 backfill's exact input). The fix:
  // before creating a NEW row on a not-yet-seen PRIMARY key (e.g. hl:hl9),
  // also check the identity's SECONDARY keys (email/phone/name) for an
  // existing customer — merge into it instead of creating a second row.
  describe('W2-009 — cross-key merge (same person, mixed identity)', () => {
    it('merges an HL-linked quote into an existing email-keyed customer (no second row)', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;

      // Quote A: email only (no HL id yet).
      const a = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane' });
      // Quote B: same person, now HL-linked — same email + name, PLUS an
      // hl_contact_id. #213: name repeated so email+name (2 fields) still
      // clears the adopt gate (the candidate row has no hl to agree with yet).
      const b = await findOrCreateCustomer({ hl_contact_id: 'hl9', email: 'jane@x.com', name: 'Jane' });

      expect(b?.id).toBe(a?.id); // same customer, not a second row
      expect(fake.tables.customers).toHaveLength(1);
      // The existing row is upgraded to the higher-precedence key + backfilled
      // so a FUTURE hl-only lookup also resolves here.
      const row = fake.tables.customers[0];
      expect(row.match_key).toBe('hl:hl9');
      expect(row.hl_contact_id).toBe('hl9');
      expect(row.email).toBe('jane@x.com');
    });

    it('a subsequent hl-only lookup resolves to the merged customer', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;

      // #213: name carried on every call so each cross-key step has 2 agreeing
      // fields (email+name) to clear the adopt gate.
      const a = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane' });
      await findOrCreateCustomer({ hl_contact_id: 'hl9', email: 'jane@x.com', name: 'Jane' });
      // A THIRD quote arrives with the HL id but no email (e.g. a later GHL
      // webhook-only payload) — must resolve to the SAME customer, not create
      // a third row.
      const c = await findOrCreateCustomer({ hl_contact_id: 'hl9' });

      expect(c?.id).toBe(a?.id);
      expect(fake.tables.customers).toHaveLength(1);
    });

    it('merges via phone when email differs but phone matches', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;

      const a = await findOrCreateCustomer({ phone: '(555) 123-4567', name: 'Jane' });
      // #213: name repeated so phone+name (2 fields) clears the adopt gate —
      // phone alone is a single-field match (covered in the dedicated #213
      // describe block below).
      const b = await findOrCreateCustomer({ hl_contact_id: 'hl9', phone: '555-123-4567', name: 'Jane' });

      expect(b?.id).toBe(a?.id);
      expect(fake.tables.customers).toHaveLength(1);
      expect(fake.tables.customers[0].match_key).toBe('hl:hl9');
    });

    it('does NOT merge distinct people (no shared secondary identity)', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;

      const a = await findOrCreateCustomer({ email: 'jane@x.com' });
      const b = await findOrCreateCustomer({ hl_contact_id: 'hl9', email: 'someone-else@x.com' });

      expect(fake.tables.customers).toHaveLength(2);
      expect(b?.id).not.toBe(a?.id);
    });

    it('never downgrades an existing higher-precedence match_key', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;

      // Quote A already HL-linked.
      const a = await findOrCreateCustomer({ hl_contact_id: 'hl9', email: 'jane@x.com', name: 'Jane' });
      // Quote B arrives email-only for the same person — #213 requires >=2
      // corroborating fields for a non-hl match (a's hl id doesn't help here:
      // b never claims one), so b also carries the matching name. Must
      // resolve to the SAME hl-keyed row, and must NOT downgrade its
      // match_key to email:….
      const b = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane' });

      expect(b?.id).toBe(a?.id);
      expect(fake.tables.customers).toHaveLength(1);
      expect(fake.tables.customers[0].match_key).toBe('hl:hl9'); // unchanged
    });

    // #213 (S34 #198 review): the flip side of the test above — an incoming
    // identity that shares only ONE field with an hl-linked row, but also
    // ACTIVELY CONFLICTS on a second field, must NOT adopt it (classifyCandidate
    // rule 5 — the money case). a's hl_contact_id is irrelevant here: b never
    // names an hl id of its own, so there is nothing for hlAgrees/hlConflicts
    // to compare against.
    it('a SINGLE agreeing field PLUS a conflicting field against an hl-linked row does NOT merge — creates a new row + logs a candidate-merge pair', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const a = await findOrCreateCustomer({ hl_contact_id: 'hl9', email: 'jane@x.com', name: 'Jane' });
      // Email agrees, but name is populated on BOTH sides and DIFFERS — an
      // active disagreement, not mere absence, so the #213 fix-3
      // zero-disagreement rule does NOT save this one (unlike the test
      // below, where b simply never provides a name at all).
      const b = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Bob' });

      expect(b?.id).not.toBe(a?.id);
      expect(fake.tables.customers).toHaveLength(2);
      expect(fake.tables.customers.find((c) => c.id === a!.id)!.name).toBe('Jane'); // untouched
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(a!.id);
      expect(warnSpy.mock.calls[0][0]).toContain(b!.id);
      expect(warnSpy.mock.calls[0][0]).toContain('email');
      expect(warnSpy.mock.calls[0][0]).toContain('name');
      warnSpy.mockRestore();
    });
  });

  // customers-or-sanitize: secondaryMatchKeys are free text (a name can carry
  // a comma/paren) and used to get string-interpolated straight into a
  // PostgREST `match_key.in.(...)` filter with no sanitizing. A crafted/plain
  // comma in the name corrupts the in-list, the merge lookup silently misses,
  // and a duplicate customer row gets created instead of deduping.
  it('a secondary match key containing a comma does not corrupt the query — still merges into the existing row', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;

    // Quote A: name only (no email/phone/hl) — match_key is the free-text
    // name key itself, comma and all.
    const a = await findOrCreateCustomer({ name: 'Smith, John' });
    // Quote B: same person, now HL-linked. The ONLY way to find quote A's row
    // is the secondary match_key.in() search on `name:smith, john` — there's
    // no hl/email/phone raw column value shared to fall back on. #213 fix 3:
    // name agrees and NOTHING populated on both sides disagrees (b provides
    // no email/phone to conflict with), so the zero-disagreement rule adopts
    // — this also proves the comma didn't corrupt the .in() lookup (a
    // corrupted lookup would have found nothing and created a second row).
    const b = await findOrCreateCustomer({ hl_contact_id: 'hl9', name: 'Smith, John' });

    expect(b?.id).toBe(a?.id); // merged into the same row, not a duplicate
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].match_key).toBe('hl:hl9'); // upgraded
  });
});

// #213 (S34 #198 review, customer lens): findOrCreateCustomer's secondary-key
// adoption now requires >=2 agreeing identity fields (or an hl_contact_id
// agreement, which stays authoritative on its own) before adopting an
// existing row — a single shared field (the realistic case: a household
// sharing one email/phone) creates a NEW row instead of silently overwriting
// a stranger's identity. The scenarios below are the ledger row's own
// acceptance list.
describe('findOrCreateCustomer — #213 >=2-field identity-agreement gate', () => {
  it('same phone, different name: does NOT adopt — creates a new row + logs a candidate-merge pair naming both ids', async () => {
    const fake = makeFakeSupabase({
      customers: [
        { id: 'alice', match_key: 'phone:5551234567', phone: '5551234567', name: 'Alice', email: null, hl_contact_id: null },
      ],
    });
    sbRef.current = fake.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await findOrCreateCustomer({ phone: '555-123-4567', name: 'Bob' });

    expect(res?.id).not.toBe('alice'); // no adopt
    expect(fake.tables.customers).toHaveLength(2); // new row created
    expect(fake.tables.customers.find((c) => c.id === 'alice')!.name).toBe('Alice'); // NOT overwritten
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('alice');
    expect(msg).toContain(res!.id);
    expect(msg).toContain('phone');
    warnSpy.mockRestore();
  });

  it('same email + same name (2 fields): adopts + newest-win overwrite, unchanged from before #213', async () => {
    const fake = makeFakeSupabase({
      customers: [
        { id: 'c1', match_key: 'email:jane@x.com', email: 'jane@x.com', name: 'Jane', phone: '5550000000', hl_contact_id: null },
      ],
    });
    sbRef.current = fake.client;

    const res = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane', phone: '5559999999' });

    expect(res?.id).toBe('c1');
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].phone).toBe('5559999999'); // newest-win still applies
  });

  it('same email + same phone, different name: adopts (2 fields agree)', async () => {
    const fake = makeFakeSupabase({
      customers: [
        {
          id: 'c1',
          match_key: 'email:jane@x.com',
          email: 'jane@x.com',
          name: 'Jane Original',
          phone: '5551234567',
          hl_contact_id: null,
        },
      ],
    });
    sbRef.current = fake.client;

    const res = await findOrCreateCustomer({ email: 'jane@x.com', phone: '555-123-4567', name: 'Jane Updated' });

    expect(res?.id).toBe('c1');
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].name).toBe('Jane Updated'); // newest-win overwrite, even though name differed
  });

  it('hl-key match: adopts unconditionally, unchanged — even with ZERO corroborating email/phone/name on file', async () => {
    const fake = makeFakeSupabase({
      customers: [{ id: 'c1', match_key: 'hl:hl9', hl_contact_id: 'hl9', email: null, name: null, phone: null }],
    });
    sbRef.current = fake.client;

    const res = await findOrCreateCustomer({ hl_contact_id: 'hl9', email: 'new@x.com' });

    expect(res?.id).toBe('c1'); // adopted despite email not matching anything on file
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].email).toBe('new@x.com'); // newest-win still fills it in
  });

  it('unique-violation race on the disambiguated (rejected-candidate) create path recovers via re-select', async () => {
    const fake = makeFakeSupabase({
      customers: [
        { id: 'alice', match_key: 'phone:5551234567', phone: '5551234567', name: 'Alice', email: null, hl_contact_id: null },
      ],
    });
    sbRef.current = fake.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First call: single-field (phone-only) reject against Alice's row
    // creates Bob's own new row under a disambiguated key.
    const bob1 = await findOrCreateCustomer({ phone: '555-123-4567', name: 'Bob' });
    expect(bob1?.id).not.toBe('alice');
    expect(fake.tables.customers).toHaveLength(2);

    // Second call: the IDENTICAL identity again, but this time the
    // disambiguated insert loses a concurrent-create race (23505) — must
    // recover Bob's own row (from the first call) via re-select, not error
    // out or create a third row.
    fake.forceInsertErrorOnce('customers', { code: '23505', message: 'duplicate key value violates unique constraint' });
    const bob2 = await findOrCreateCustomer({ phone: '555-123-4567', name: 'Bob' });

    expect(bob2?.id).toBe(bob1?.id); // recovered Bob's row, not a third row
    expect(fake.tables.customers).toHaveLength(2); // still just Alice + Bob
    warnSpy.mockRestore();
  });

  // #213 fix 4 (customer HIGH-leverage): saveQuote now threads
  // highlevel_contact_id into the identity (src/lib/quotes.ts), so hl
  // becomes authoritative on every properly-picked save, not just the send-
  // time re-attach. These exercise the MECHANISM end-to-end via
  // attachQuoteToCustomer (the exact function saveQuote calls), proving hl
  // agreement/conflict wins regardless of what the other fields say.
  it('an hl-agreeing identity adopts the hl row via attachQuoteToCustomer, regardless of other fields', async () => {
    const fake = makeFakeSupabase({
      customers: [
        { id: 'c1', match_key: 'hl:hl9', hl_contact_id: 'hl9', email: 'old@x.com', name: 'Old Name', phone: null },
      ],
    });
    sbRef.current = fake.client;

    const res = await attachQuoteToCustomer({
      id: 'q1',
      highlevel_contact_id: 'hl9',
      customer_name: 'Totally Different Name',
      customer_email: 'different@x.com',
      customer_address: '1 A St',
    });

    expect(res?.customerId).toBe('c1'); // adopted via hl agreement alone
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].name).toBe('Totally Different Name'); // newest-win still applies
  });

  it('an hl-CONFLICTING identity refuses to adopt via attachQuoteToCustomer, even with matching email+phone+name', async () => {
    const fake = makeFakeSupabase({
      customers: [
        { id: 'c1', match_key: 'hl:hl-old', hl_contact_id: 'hl-old', email: 'shared@x.com', phone: '5551234567', name: 'Jane' },
      ],
    });
    sbRef.current = fake.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await attachQuoteToCustomer({
      id: 'q1',
      highlevel_contact_id: 'hl-new',
      customer_name: 'Jane',
      customer_email: 'shared@x.com',
      customer_phone: '555-123-4567',
      customer_address: '1 A St',
    });

    // Vetoed despite email+phone+name ALL agreeing — a different hl id means
    // a different real CRM contact, full stop (fix 2's veto beats fix 3's
    // >=2-field rule).
    expect(res?.customerId).not.toBe('c1');
    expect(fake.tables.customers).toHaveLength(2);
    expect(fake.tables.customers.find((c) => c.id === 'c1')!.hl_contact_id).toBe('hl-old'); // untouched
    warnSpy.mockRestore();
  });
});

// #213 round 2 (adversarial delta-verify of the review-fix round above)
// found fix 3's original zero-disagreement predicate still had a gap: it
// checked only agreement/disagreement, not whether the identity was
// CONTRIBUTING an uncorroborated new field. Rule 4 is now subset-scoped —
// see classifyCandidate.
describe('findOrCreateCustomer — #213 round 2: subset-scoped rule 4', () => {
  it('a RICH identity hitting a SPARSE row on one shared field does NOT adopt — rejects + logs, row untouched', async () => {
    const fake = makeFakeSupabase({
      customers: [
        // Mom's row: email only, nothing else ever recorded.
        { id: 'mom', match_key: 'email:family@x.com', email: 'family@x.com', phone: null, name: null, hl_contact_id: null },
      ],
    });
    sbRef.current = fake.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Bob's own quote: same shared household email, PLUS his own phone and
    // name — fields the row has never seen and can't corroborate.
    const res = await findOrCreateCustomer({ email: 'family@x.com', phone: '555-999-9999', name: 'Bob Smith' });

    expect(res?.id).not.toBe('mom'); // NOT adopted — email agreement alone isn't enough once identity contributes new fields
    expect(fake.tables.customers).toHaveLength(2);
    const momRow = fake.tables.customers.find((c) => c.id === 'mom')!;
    expect(momRow.phone).toBeNull(); // untouched — Bob's phone never stamped onto Mom's row
    expect(momRow.name).toBeNull(); // untouched
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('mom');
    expect(warnSpy.mock.calls[0][0]).toContain('email');
    warnSpy.mockRestore();
  });

  it('an IDENTICAL single-field identity repeat converges at PHASE 1 — no disambiguated row ever created', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;

    const a = await findOrCreateCustomer({ email: 'jane@x.com' });
    const b = await findOrCreateCustomer({ email: 'jane@x.com' }); // identical, nothing else on either side

    expect(b?.id).toBe(a?.id);
    expect(fake.tables.customers).toHaveLength(1); // never split into a dup: row
    expect(fake.tables.customers[0].match_key).toBe('email:jane@x.com'); // plain key, never disambiguated
  });

  it('a SPARSE identity (e.g. an email-only lead) adopts a RICHER existing row — contributes nothing new', async () => {
    const fake = makeFakeSupabase({
      customers: [
        { id: 'c1', match_key: 'email:jane@x.com', email: 'jane@x.com', phone: '5551234567', name: 'Jane Doe', hl_contact_id: null },
      ],
    });
    sbRef.current = fake.client;

    const res = await findOrCreateCustomer({ email: 'jane@x.com' }); // no phone/name at all

    expect(res?.id).toBe('c1'); // adopts — identity's {email} is a subset of the row's {email,phone,name}
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].phone).toBe('5551234567'); // untouched (identity had nothing to overwrite it with anyway)
    expect(fake.tables.customers[0].name).toBe('Jane Doe');
  });
});

describe('findOrCreateCustomer — #213 round 2: a rejected .in() hit must not suppress the OR-search', () => {
  it('visit 2 (hl-linked) converges on the earlier disambiguated row from visit 1, not a third row — RX untouched', async () => {
    const fake = makeFakeSupabase({
      customers: [
        // RX: an unrelated existing customer who happens to share Alice's
        // email (the classic household/coincidence case), with a DIFFERENT
        // phone + name.
        { id: 'RX', match_key: 'email:alice@x.com', email: 'alice@x.com', phone: '5550000000', name: 'Not Alice', hl_contact_id: null },
      ],
    });
    sbRef.current = fake.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Visit 1: Alice's real identity, no hl yet. The exact-match phase finds
    // RX (same match_key), rejects it (phone + name both conflict), and
    // creates R1 under a no-hl disambiguated key.
    const visit1 = await findOrCreateCustomer({
      email: 'alice@x.com',
      phone: '555-123-4567',
      name: 'Alice Real',
    });
    expect(visit1?.id).not.toBe('RX');
    expect(fake.tables.customers).toHaveLength(2); // RX + R1

    // Visit 2: same Alice, now hl-linked. The .in() secondary search finds
    // RX again (rejects it again) — this must NOT stop the search; the
    // OR-fallback must still find R1 (raw email/phone columns match) and
    // adopt it, upgrading it to the hl key.
    const visit2 = await findOrCreateCustomer({
      hl_contact_id: 'hl-alice',
      email: 'alice@x.com',
      phone: '555-123-4567',
      name: 'Alice Real',
    });

    expect(visit2?.id).toBe(visit1?.id); // converged on R1, not a third row
    expect(fake.tables.customers).toHaveLength(2); // still just RX + R1
    expect(fake.tables.customers.find((c) => c.id === visit1!.id)!.match_key).toBe('hl:hl-alice'); // R1 upgraded
    const rx = fake.tables.customers.find((c) => c.id === 'RX')!;
    expect(rx.phone).toBe('5550000000'); // untouched
    expect(rx.name).toBe('Not Alice'); // untouched
    expect(rx.hl_contact_id).toBeNull(); // untouched
    warnSpy.mockRestore();
  });
});

describe('findOrCreateCustomer — #213 round 2: adopt() key-upgrade UNIQUE handling', () => {
  it('adopting a row whose key-upgrade collides with an earlier-rejected candidate keeps its existing key — info, never error', async () => {
    const fake = makeFakeSupabase({
      customers: [
        { id: 'alice', match_key: 'phone:5551234567', phone: '5551234567', name: 'Alice', email: null, hl_contact_id: null },
      ],
    });
    sbRef.current = fake.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    // Creates Bob's own row (R2) under a disambiguated key — rejected
    // against Alice's phone-only row (phone agrees, name conflicts).
    const bob1 = await findOrCreateCustomer({ phone: '555-123-4567', name: 'Bob' });
    expect(fake.tables.customers).toHaveLength(2);
    const bob1Key = fake.tables.customers.find((c) => c.id === bob1!.id)!.match_key;
    expect(bob1Key).not.toBe('phone:5551234567');

    // Repeat: phase 1 rejects Alice again; the OR-fallback then finds BOTH
    // Alice and Bob's own row — Bob's own row qualifies to ADOPT (phone +
    // name, 2 fields agree), and its key-upgrade attempt (dup: ->
    // phone:...) collides with Alice's row, which already legitimately
    // owns that plain key.
    const bob2 = await findOrCreateCustomer({ phone: '555-123-4567', name: 'Bob' });

    expect(bob2?.id).toBe(bob1?.id); // adopted Bob's own row, not a third row
    expect(fake.tables.customers).toHaveLength(2);
    expect(fake.tables.customers.find((c) => c.id === bob1!.id)!.match_key).toBe(bob1Key); // stayed on its dup key
    expect(fake.tables.customers.find((c) => c.id === 'alice')!.match_key).toBe('phone:5551234567'); // untouched
    expect(errorSpy).not.toHaveBeenCalled(); // never error-level for this expected, permanent case
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toContain(bob1!.id);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });
});

describe('findOrCreateCustomer — #213 round 2: dedup the rejected list before warning', () => {
  it('the same candidate rejected via both the exact-match phase and the secondary search is named ONCE, not twice', async () => {
    const fake = makeFakeSupabase({
      customers: [
        // Mom's sparse row: found by phase 1 (exact key) AND, since her
        // email also matches the raw column, by phase 2's OR-fallback too.
        { id: 'mom', match_key: 'email:family@x.com', email: 'family@x.com', phone: null, name: null, hl_contact_id: null },
      ],
    });
    sbRef.current = fake.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await findOrCreateCustomer({ email: 'family@x.com', phone: '555-999-9999', name: 'Bob Smith' });

    expect(res?.id).not.toBe('mom');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    // 'mom' appears exactly once in the rejected list, not twice.
    expect(msg.split('mom').length - 1).toBe(1);
    warnSpy.mockRestore();
  });
});

describe('findOrCreateProperty', () => {
  it('dedups by normalized address within a customer', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const p1 = await findOrCreateProperty('cust-1', '123 Main St.');
    const p2 = await findOrCreateProperty('cust-1', '123  main st');
    expect(p2?.id).toBe(p1?.id);
    expect(fake.tables.properties).toHaveLength(1);
    expect(fake.tables.properties[0].address_key).toBe('123 main st');
  });

  // W2-026 (newest-win) — same normalized address_key → refresh the display
  // address + geo to the newer quote's values.
  it('W2-026: refreshes display address + geo for the same normalized address', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const p1 = await findOrCreateProperty('cust-1', '123 Main St', { lat: 1, lng: 2 });
    const p2 = await findOrCreateProperty('cust-1', '123 MAIN ST.', { lat: 3, lng: 4 }); // same key '123 main st'
    expect(p2?.id).toBe(p1?.id);
    expect(fake.tables.properties).toHaveLength(1); // not a duplicate
    expect(fake.tables.properties[0].address).toBe('123 MAIN ST.'); // display refreshed
    expect(fake.tables.properties[0].lat).toBe(3); // geo refreshed
    expect(fake.tables.properties[0].lng).toBe(4);
  });

  it('a second property (rental) for the same customer is a new row', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    await findOrCreateProperty('cust-1', '123 Main St');
    await findOrCreateProperty('cust-1', '9 Rental Rd');
    expect(fake.tables.properties).toHaveLength(2);
  });

  // W2-010: same race-recovery coverage as findOrCreateCustomer, for the
  // identical branch in findOrCreateProperty (UNIQUE(customer_id, address_key)).
  //
  // #205 review fix (F6 — pre-existing test repair, reviewer-verified):
  // this test used to pre-seed the WINNER row directly, so
  // findOrCreateProperty's own up-front existing-row SELECT found it
  // immediately and returned WITHOUT ever attempting an insert — the
  // forced 23505 sat unconsumed, and the retry-recovery branch this test
  // claims to cover never actually ran (it "passed" only because the
  // direct-hit path produces the identical observable result). Repaired
  // using the SAME genuine-concurrency technique this file already uses
  // for findOrCreateCustomer (see "two concurrent findOrCreateCustomer
  // calls..." below): Promise.all with NO pre-seed and NO forced error.
  // Traced precisely via the fake's microtask interleaving — both calls
  // SUSPEND at their own first await (the existing-row SELECT, finding
  // nothing, since the table starts empty), so both proceed to INSERT;
  // the winner's insert lands first and genuinely occupies the
  // address_key; the loser's insert then hits a REAL (unforced) 23505 —
  // by the time its own single() resolves, the winner's row already
  // exists — and ITS retry-select genuinely recovers the winner. This is
  // what actually exercises the retry-recovery branch.
  it('recovers the existing row on a 23505 unique-violation race (concurrent create)', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;

    const [a, b] = await Promise.all([
      findOrCreateProperty('cust-1', '123 Main St.'),
      findOrCreateProperty('cust-1', '123 Main St.'),
    ]);

    expect(a?.id).toBeTruthy();
    expect(b?.id).toBe(a?.id); // both converge on the SAME row
    expect(fake.tables.properties).toHaveLength(1); // never duplicated
  });

  it('returns null on a genuine hard insert error (not a recoverable race)', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    fake.forceInsertErrorOnce('properties', { code: '500', message: 'connection reset' });

    const res = await findOrCreateProperty('cust-1', '9 New Rd');

    expect(res).toBeNull();
    expect(fake.tables.properties).toHaveLength(0);
  });
});

// ─── DB: attach + backfill ──────────────────────────────────────────────────

describe('attachQuoteToCustomer', () => {
  it('links a quote to a fresh customer + property', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'q1', customer_email: 'jane@x.com', customer_address: '1 A St' }],
    });
    sbRef.current = fake.client;

    const res = await attachQuoteToCustomer({
      id: 'q1',
      customer_email: 'jane@x.com',
      customer_address: '1 A St',
    });
    expect(res).toBeTruthy();
    const q = fake.tables.quotes.find((r) => r.id === 'q1')!;
    expect(q.customer_id).toBe(res!.customerId);
    expect(q.property_id).toBe(res!.propertyId);
  });

  it('returns null for an identity-less quote (left unlinked)', async () => {
    const fake = makeFakeSupabase({ quotes: [{ id: 'q1' }] });
    sbRef.current = fake.client;
    const res = await attachQuoteToCustomer({ id: 'q1' });
    expect(res).toBeNull();
    expect(fake.tables.customers).toHaveLength(0);
  });

  // Forward-heal (S34, #198 follow-up — live finding: 166/168 customers rows
  // had hl_contact_id NULL, because a quote can gain highlevel_contact_id
  // LATER (the builder's HL-contact-pick autocomplete) via a route that never
  // touches the customers table — findOrCreateCustomer is never re-run for
  // that quote's link. Every attachQuoteToCustomer call is a fresh chance to
  // close that gap.
  describe('hl_contact_id forward-heal', () => {
    it('stamps a null hl_contact_id when the quote it resolves to carries one', async () => {
      const fake = makeFakeSupabase({
        customers: [{ id: 'c1', match_key: 'email:jane@x.com', hl_contact_id: null, email: 'jane@x.com', name: 'Jane', phone: null }],
      });
      sbRef.current = fake.client;

      const res = await attachQuoteToCustomer({
        id: 'q1',
        highlevel_contact_id: 'ghl-1',
        customer_name: 'Jane',
        customer_email: 'jane@x.com',
        customer_address: '1 A St',
      });

      expect(res?.customerId).toBe('c1');
      expect(fake.tables.customers.find((c) => c.id === 'c1')!.hl_contact_id).toBe('ghl-1');
    });

    it('never touches an unrelated customer row already linked to a DIFFERENT hl_contact_id', async () => {
      // Bob shares no identity field with the incoming quote (different
      // name/email/phone AND a different hl id), so findOrCreateCustomer
      // resolves to a BRAND-NEW customer for this quote — Bob's row is never
      // even read, let alone written. Guards against this heal (or anything
      // in the resolution path) reaching across and clobbering an unrelated
      // customer's existing, deliberately-different link.
      const fake = makeFakeSupabase({
        customers: [{ id: 'bob', match_key: 'hl:ghl-bob', hl_contact_id: 'ghl-bob', email: 'bob@x.com', name: 'Bob', phone: null }],
      });
      sbRef.current = fake.client;

      const res = await attachQuoteToCustomer({
        id: 'q1',
        highlevel_contact_id: 'ghl-alice',
        customer_name: 'Alice',
        customer_email: 'alice@x.com',
        customer_address: '1 A St',
      });

      expect(res?.customerId).not.toBe('bob');
      expect(fake.tables.customers.find((c) => c.id === 'bob')!.hl_contact_id).toBe('ghl-bob');
    });

    it('does nothing when the quote carries no highlevel_contact_id', async () => {
      const fake = makeFakeSupabase({
        customers: [{ id: 'c1', match_key: 'email:jane@x.com', hl_contact_id: null, email: 'jane@x.com', name: 'Jane', phone: null }],
      });
      sbRef.current = fake.client;

      const res = await attachQuoteToCustomer({
        id: 'q1',
        customer_name: 'Jane',
        customer_email: 'jane@x.com',
        customer_address: '1 A St',
      });

      expect(res?.customerId).toBe('c1');
      expect(fake.tables.customers.find((c) => c.id === 'c1')!.hl_contact_id).toBeNull();
    });
  });
});

describe('backfillCustomersFromQuotes', () => {
  it('dedups a history into stable customers + properties and links each quote', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        // Same customer (email ONLY — #213 fix 3's zero-disagreement rule
        // means a single agreeing field with nothing to conflict on is
        // enough to deterministically dedupe 3 concurrently-processed
        // quotes for the same person onto ONE row), two addresses (home +
        // rental).
        { id: 'q1', created_at: '2025-01-01', customer_email: 'jane@x.com', customer_address: '1 Home St', customer_id: null },
        { id: 'q2', created_at: '2025-02-01', customer_email: 'jane@x.com', customer_address: '9 Rental Rd', customer_id: null },
        { id: 'q3', created_at: '2025-03-01', customer_email: 'jane@x.com', customer_address: '1 Home St', customer_id: null },
        // A different customer
        { id: 'q4', created_at: '2025-04-01', customer_phone: '555-111-2222', customer_address: '2 B Ave', customer_id: null },
        // Identity-less → skipped
        { id: 'q5', created_at: '2025-05-01', customer_id: null },
      ],
    });
    sbRef.current = fake.client;

    const summary = await backfillCustomersFromQuotes();
    expect(summary.scanned).toBe(5);
    expect(summary.linked).toBe(4);
    expect(summary.skipped).toBe(1);
    expect(fake.tables.customers).toHaveLength(2); // Jane + the phone customer
    expect(fake.tables.properties).toHaveLength(3); // Home, Rental, B Ave

    const jane = fake.tables.customers.find((c) => c.match_key === 'email:jane@x.com')!;
    const janeQuotes = fake.tables.quotes.filter((q) => q.customer_id === jane.id);
    expect(janeQuotes.map((q) => q.id).sort()).toEqual(['q1', 'q2', 'q3']);
    // q1 and q3 (same address) share ONE property; q2 is the rental.
    const q1 = fake.tables.quotes.find((q) => q.id === 'q1')!;
    const q3 = fake.tables.quotes.find((q) => q.id === 'q3')!;
    expect(q1.property_id).toBe(q3.property_id);
    expect(fake.tables.quotes.find((q) => q.id === 'q5')!.customer_id).toBeNull();
  });

  // W2-011: backfill now processes quotes in bounded-concurrency chunks
  // instead of strictly one-at-a-time. Cross a chunk boundary (>8 rows) with
  // repeated identities to prove dedup still holds across chunks, not just
  // within one. #213 fix 3: email-only (single field, nothing to conflict
  // with) — 20 concurrently-processed IDENTICAL identities must still
  // deterministically converge on ONE row (the zero-disagreement rule), not
  // split on race timing. Run it several times: this is exactly the
  // scenario that used to be timing-sensitive.
  it('dedups correctly across a chunk boundary (bounded concurrency, W2-011) — deterministic, not timing-luck', async () => {
    for (let run = 0; run < 5; run++) {
      const quotes = Array.from({ length: 20 }, (_, i) => ({
        id: `q${i}`,
        created_at: `2025-01-${String(i + 1).padStart(2, '0')}`,
        customer_email: 'jane@x.com', // same customer for all 20, no other field
        customer_address: '1 Home St',
        customer_id: null,
      }));
      const fake = makeFakeSupabase({ quotes });
      sbRef.current = fake.client;

      const summary = await backfillCustomersFromQuotes();

      expect(summary.scanned).toBe(20);
      expect(summary.linked).toBe(20);
      expect(fake.tables.customers).toHaveLength(1); // still ONE customer, no dup races
      expect(fake.tables.properties).toHaveLength(1);
      expect(fake.tables.quotes.every((q) => q.customer_id === fake.tables.customers[0].id)).toBe(true);
    }
  });

  // #213 fix 3 (staff HIGH — explicit concurrency coverage, not routed
  // through the chunking helper): TWO calls for the EXACT SAME single-field
  // identity, fired via Promise.all so they genuinely race each other's
  // DB reads/writes (not just processed back-to-back), must still converge
  // on ONE customer row. This is the literal scenario fix 1's retry-recovery
  // classification + fix 3's zero-disagreement rule together are meant to
  // guarantee: nothing here can "disagree" (there's only one field, and it's
  // identical on both sides), so classifyCandidate adopts on whichever side
  // loses the race, rather than the pre-fix-3 strict >=2 rule splitting them.
  it('two concurrent findOrCreateCustomer calls for the IDENTICAL single-field identity converge on one row', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;

    const [a, b] = await Promise.all([
      findOrCreateCustomer({ phone: '555-123-4567' }),
      findOrCreateCustomer({ phone: '555-123-4567' }),
    ]);

    expect(a?.id).toBeTruthy();
    expect(b?.id).toBe(a?.id);
    expect(fake.tables.customers).toHaveLength(1);
  });

  it('is idempotent — a re-run only scans the still-unlinked quotes', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'q1', created_at: '2025-01-01', customer_email: 'a@x.com', customer_address: 'X', customer_id: null }],
    });
    sbRef.current = fake.client;
    await backfillCustomersFromQuotes();
    const second = await backfillCustomersFromQuotes();
    expect(second.scanned).toBe(0); // q1 now has customer_id → not re-scanned
    expect(fake.tables.customers).toHaveLength(1);
  });

  // #214 review fix (3-lens MED): the backfill reads STORED rows, whose
  // blank name/address were persisted as the 'Anonymous'/'(no address)'
  // display sentinels — without quoteRowToIdentity those derived match_key
  // `name:anonymous` and PERMANENTLY folded every blank-identity quote onto
  // ONE shared "Anonymous" customer row.
  it('sentinel-only stored rows are SKIPPED, never folded onto a shared "Anonymous" customer', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        // Two unrelated contactless quotes, both persisted with the sentinels.
        { id: 'q1', created_at: '2025-01-01', customer_name: 'Anonymous', customer_address: '(no address)', customer_id: null },
        { id: 'q2', created_at: '2025-02-01', customer_name: 'Anonymous', customer_address: '(no address)', customer_id: null },
        // A real one, to prove the run still links normal rows.
        { id: 'q3', created_at: '2025-03-01', customer_email: 'real@x.com', customer_address: '1 Real St', customer_id: null },
      ],
    });
    sbRef.current = fake.client;

    const summary = await backfillCustomersFromQuotes();
    expect(summary.scanned).toBe(3);
    expect(summary.linked).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].match_key).toBe('email:real@x.com');
    expect(fake.tables.customers.map((c) => c.match_key)).not.toContain('name:anonymous');
    expect(fake.tables.quotes.find((q) => q.id === 'q1')!.customer_id).toBeNull();
    expect(fake.tables.quotes.find((q) => q.id === 'q2')!.customer_id).toBeNull();
  });

  it('EXCLUDES test quotes from promotion (ledger #93) — real + legacy NULL only', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'real', created_at: '2025-01-01', customer_email: 'real@x.com', customer_address: '1 Real St', customer_id: null, is_test: false },
        // Legacy row written before the is_test column existed (NULL/undefined) → real.
        { id: 'legacy', created_at: '2025-02-01', customer_email: 'legacy@x.com', customer_address: '2 Legacy Rd', customer_id: null },
        { id: 'test', created_at: '2025-03-01', customer_email: 'test@x.com', customer_address: '3 Test Ave', customer_id: null, is_test: true },
      ],
    });
    sbRef.current = fake.client;

    const summary = await backfillCustomersFromQuotes();
    // The test quote is filtered out of the scan entirely.
    expect(summary.scanned).toBe(2);
    expect(summary.linked).toBe(2);
    // It never gets linked and never creates a persisted customer (so "Delete
    // test data" can't leave an orphaned customer/property behind).
    expect(fake.tables.quotes.find((q) => q.id === 'test')!.customer_id ?? null).toBeNull();
    expect(fake.tables.customers.map((c) => c.match_key)).not.toContain('email:test@x.com');
  });
});

// ─── DB: reads ──────────────────────────────────────────────────────────────

describe('reads', () => {
  it('getCustomer + getPropertiesForCustomer round-trip after a backfill', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        // Email only — #213 fix 3's zero-disagreement rule (nothing else to
        // conflict on) deterministically converges both onto one row.
        { id: 'q1', created_at: '2025-01-01', customer_email: 'jane@x.com', customer_address: 'Home', customer_id: null },
        { id: 'q2', created_at: '2025-02-01', customer_email: 'jane@x.com', customer_address: 'Rental', customer_id: null },
      ],
    });
    sbRef.current = fake.client;
    await backfillCustomersFromQuotes();
    const id = fake.tables.customers[0].id as string;

    const c = await getCustomer(id);
    expect(c?.email).toBe('jane@x.com');
    const props = await getPropertiesForCustomer(id);
    expect(props).toHaveLength(2);
  });

  it('returns safe empties when Supabase is unconfigured', async () => {
    sbRef.current = null;
    expect(await getCustomer('x')).toBeNull();
    expect(await getPropertiesForCustomer('x')).toEqual([]);
    expect(await findOrCreateCustomer({ email: 'a@x.com' })).toBeNull();
  });
});

// ─── #198: NCE + YLL Neighbor tags ──────────────────────────────────────────

describe('getCustomerByHlContactId', () => {
  it('finds the customer by hl_contact_id — never creates one', async () => {
    const fake = makeFakeSupabase({
      customers: [{ id: 'cust-1', match_key: 'hl:contact-1', hl_contact_id: 'contact-1', name: 'Jane', is_nce: true, is_yll_neighbor: false }],
    });
    sbRef.current = fake.client;

    const c = await getCustomerByHlContactId('contact-1');
    expect(c?.id).toBe('cust-1');
    expect(c?.is_nce).toBe(true);
    expect(fake.tables.customers).toHaveLength(1); // unchanged — no row created
  });

  it('returns null when no customer matches', async () => {
    const fake = makeFakeSupabase({ customers: [] });
    sbRef.current = fake.client;
    expect(await getCustomerByHlContactId('unknown-contact')).toBeNull();
  });

  it('returns null for a blank/whitespace id without querying', async () => {
    sbRef.current = null; // would throw if the function tried to reach Supabase
    expect(await getCustomerByHlContactId('   ')).toBeNull();
  });

  it('returns null when Supabase is unconfigured', async () => {
    sbRef.current = null;
    expect(await getCustomerByHlContactId('contact-1')).toBeNull();
  });
});

describe('listCustomerTagsByIds', () => {
  it('returns a map keyed by id with each row\'s tags', async () => {
    const fake = makeFakeSupabase({
      customers: [
        { id: 'cust-1', match_key: 'a', is_nce: true, is_yll_neighbor: false },
        { id: 'cust-2', match_key: 'b', is_nce: false, is_yll_neighbor: true },
      ],
    });
    sbRef.current = fake.client;

    const map = await listCustomerTagsByIds(['cust-1', 'cust-2', 'cust-missing']);
    expect(map.get('cust-1')).toEqual({ isNce: true, isYllNeighbor: false });
    expect(map.get('cust-2')).toEqual({ isNce: false, isYllNeighbor: true });
    expect(map.has('cust-missing')).toBe(false);
  });

  it('returns an empty map for an empty id list without querying', async () => {
    sbRef.current = null; // would throw if the function tried to reach Supabase
    const map = await listCustomerTagsByIds([]);
    expect(map.size).toBe(0);
  });

  it('dedupes repeated ids before querying', async () => {
    const fake = makeFakeSupabase({
      customers: [{ id: 'cust-1', match_key: 'a', is_nce: true, is_yll_neighbor: true }],
    });
    sbRef.current = fake.client;
    const map = await listCustomerTagsByIds(['cust-1', 'cust-1']);
    expect(map.size).toBe(1);
  });

  it('returns an empty map when Supabase is unconfigured', async () => {
    sbRef.current = null;
    expect((await listCustomerTagsByIds(['cust-1'])).size).toBe(0);
  });
});

describe('propagateQuoteTagsToCustomer', () => {
  it('sets is_nce true on the customer row', async () => {
    const fake = makeFakeSupabase({ customers: [{ id: 'cust-1', match_key: 'a', is_nce: false, is_yll_neighbor: false }] });
    sbRef.current = fake.client;

    await propagateQuoteTagsToCustomer('cust-1', { isNce: true });
    expect(fake.tables.customers[0].is_nce).toBe(true);
    expect(fake.tables.customers[0].is_yll_neighbor).toBe(false); // untouched
  });

  it('sets is_yll_neighbor true on the customer row', async () => {
    const fake = makeFakeSupabase({ customers: [{ id: 'cust-1', match_key: 'a', is_nce: false, is_yll_neighbor: false }] });
    sbRef.current = fake.client;

    await propagateQuoteTagsToCustomer('cust-1', { isYllNeighbor: true });
    expect(fake.tables.customers[0].is_yll_neighbor).toBe(true);
    expect(fake.tables.customers[0].is_nce).toBe(false); // untouched
  });

  it('sets both tags true in one call when both are true', async () => {
    const fake = makeFakeSupabase({ customers: [{ id: 'cust-1', match_key: 'a', is_nce: false, is_yll_neighbor: false }] });
    sbRef.current = fake.client;

    await propagateQuoteTagsToCustomer('cust-1', { isNce: true, isYllNeighbor: true });
    expect(fake.tables.customers[0]).toMatchObject({ is_nce: true, is_yll_neighbor: true });
  });

  it('forward-only: never writes false, even when explicitly passed false', async () => {
    const fake = makeFakeSupabase({ customers: [{ id: 'cust-1', match_key: 'a', is_nce: true, is_yll_neighbor: true }] });
    sbRef.current = fake.client;

    await propagateQuoteTagsToCustomer('cust-1', { isNce: false, isYllNeighbor: false });
    // Still true — a false input is simply omitted from the write, never clears.
    expect(fake.tables.customers[0]).toMatchObject({ is_nce: true, is_yll_neighbor: true });
  });

  it('does nothing when both tags are omitted', async () => {
    const fake = makeFakeSupabase({ customers: [{ id: 'cust-1', match_key: 'a', is_nce: false, is_yll_neighbor: false }] });
    sbRef.current = fake.client;

    await propagateQuoteTagsToCustomer('cust-1', {});
    expect(fake.tables.customers[0]).toMatchObject({ is_nce: false, is_yll_neighbor: false });
  });

  it('does not throw when Supabase is unconfigured', async () => {
    sbRef.current = null;
    await expect(propagateQuoteTagsToCustomer('cust-1', { isNce: true })).resolves.toBeUndefined();
  });
});

describe('setCustomerTags', () => {
  it('writes only the provided key(s) — partial update', async () => {
    const fake = makeFakeSupabase({ customers: [{ id: 'cust-1', match_key: 'a', is_nce: false, is_yll_neighbor: true }] });
    sbRef.current = fake.client;

    const { data, error } = await setCustomerTags('cust-1', { isNce: true });
    expect(error).toBeNull();
    // toMatchObject (not toEqual): the real route only SELECTs id/is_nce/
    // is_yll_neighbor, but this fake returns the whole row (incl. match_key)
    // regardless of the select string — same pre-existing fidelity gap noted
    // elsewhere in this file's siblings, not a new one.
    expect(data).toMatchObject({ id: 'cust-1', is_nce: true, is_yll_neighbor: true });
    expect(fake.tables.customers[0]).toMatchObject({ is_nce: true, is_yll_neighbor: true });
  });

  it('CAN explicitly clear a tag (unlike propagateQuoteTagsToCustomer, this is a real staff remove)', async () => {
    const fake = makeFakeSupabase({ customers: [{ id: 'cust-1', match_key: 'a', is_nce: true, is_yll_neighbor: true }] });
    sbRef.current = fake.client;

    const { data } = await setCustomerTags('cust-1', { isNce: false });
    expect(data).toMatchObject({ id: 'cust-1', is_nce: false, is_yll_neighbor: true });
  });

  it('writes both tags in one call', async () => {
    const fake = makeFakeSupabase({ customers: [{ id: 'cust-1', match_key: 'a', is_nce: false, is_yll_neighbor: false }] });
    sbRef.current = fake.client;

    const { data } = await setCustomerTags('cust-1', { isNce: true, isYllNeighbor: true });
    expect(data).toMatchObject({ id: 'cust-1', is_nce: true, is_yll_neighbor: true });
  });

  it('returns null data (no error) for an unknown customer id', async () => {
    const fake = makeFakeSupabase({ customers: [] });
    sbRef.current = fake.client;

    const { data, error } = await setCustomerTags('unknown-cust', { isNce: true });
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it('returns an error (not a throw) when Supabase is unconfigured', async () => {
    sbRef.current = null;
    const { data, error } = await setCustomerTags('cust-1', { isNce: true });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});

// ─── #205: property management (nickname, archive, manual add) ─────────────

describe('getPropertiesForCustomer — includeArchived (#205)', () => {
  it('excludes archived properties by default', async () => {
    const fake = makeFakeSupabase({
      properties: [
        { id: 'p1', customer_id: 'cust-1', address_key: 'a', archived_at: null },
        { id: 'p2', customer_id: 'cust-1', address_key: 'b', archived_at: '2026-01-01T00:00:00Z' },
      ],
    });
    sbRef.current = fake.client;

    const list = await getPropertiesForCustomer('cust-1');
    expect(list.map((p) => p.id)).toEqual(['p1']);
  });

  it('includes archived properties when includeArchived is true', async () => {
    const fake = makeFakeSupabase({
      properties: [
        { id: 'p1', customer_id: 'cust-1', address_key: 'a', archived_at: null },
        { id: 'p2', customer_id: 'cust-1', address_key: 'b', archived_at: '2026-01-01T00:00:00Z' },
      ],
    });
    sbRef.current = fake.client;

    const list = await getPropertiesForCustomer('cust-1', { includeArchived: true });
    expect(list.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });
});

describe('updateProperty', () => {
  it('trims whitespace from the nickname', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-1', address_key: '1 a st', nickname: null }],
    });
    sbRef.current = fake.client;

    const { data, error } = await updateProperty('cust-1', 'p1', { nickname: "  Talonda's House  " });
    expect(error).toBeNull();
    expect(data?.nickname).toBe("Talonda's House");
  });

  it('caps the nickname at 80 characters', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-1', address_key: '1 a st', nickname: null }],
    });
    sbRef.current = fake.client;

    const long = 'x'.repeat(100);
    const { data } = await updateProperty('cust-1', 'p1', { nickname: long });
    expect(data?.nickname).toBe('x'.repeat(80));
  });

  it('treats an empty/whitespace-only nickname as a clear (-> null)', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-1', address_key: '1 a st', nickname: 'Old Label' }],
    });
    sbRef.current = fake.client;

    const { data } = await updateProperty('cust-1', 'p1', { nickname: '   ' });
    expect(data?.nickname).toBeNull();
  });

  it('returns no data (not found) for a property that belongs to a DIFFERENT customer — never edited', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-OTHER', address_key: '1 a st', nickname: null }],
    });
    sbRef.current = fake.client;

    const { data, error } = await updateProperty('cust-1', 'p1', { nickname: 'Hijack' });
    expect(data).toBeNull();
    expect(error).toBeNull();
    expect(fake.tables.properties[0].nickname).toBeNull(); // untouched
  });

  it('returns no data (not found) for an unknown property id', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const { data, error } = await updateProperty('cust-1', 'missing', { nickname: 'x' });
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it('returns an error (not a throw) when Supabase is unconfigured', async () => {
    sbRef.current = null;
    const { data, error } = await updateProperty('cust-1', 'p1', { nickname: 'x' });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe('archiveProperty / unarchiveProperty', () => {
  it('archiving stamps archived_at and hides the property from the default list', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-1', address: '1 A St', address_key: '1 a st', archived_at: null }],
    });
    sbRef.current = fake.client;

    const { data, error } = await archiveProperty('cust-1', 'p1');
    expect(error).toBeNull();
    expect(data?.archived_at).toBeTruthy();

    expect(await getPropertiesForCustomer('cust-1')).toHaveLength(0);
    expect(await getPropertiesForCustomer('cust-1', { includeArchived: true })).toHaveLength(1);
  });

  it('unarchiving clears archived_at and the property reappears in the default list', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-1', address_key: '1 a st', archived_at: '2026-01-01T00:00:00Z' }],
    });
    sbRef.current = fake.client;

    const { data, error } = await unarchiveProperty('cust-1', 'p1');
    expect(error).toBeNull();
    expect(data?.archived_at).toBeNull();
    expect(await getPropertiesForCustomer('cust-1')).toHaveLength(1);
  });

  it('never archives a property belonging to a DIFFERENT customer', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-OTHER', address_key: '1 a st', archived_at: null }],
    });
    sbRef.current = fake.client;

    const { data } = await archiveProperty('cust-1', 'p1');
    expect(data).toBeNull();
    expect(fake.tables.properties[0].archived_at).toBeNull(); // untouched
  });

  it('never unarchives a property belonging to a DIFFERENT customer', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-OTHER', address_key: '1 a st', archived_at: '2026-01-01T00:00:00Z' }],
    });
    sbRef.current = fake.client;

    const { data } = await unarchiveProperty('cust-1', 'p1');
    expect(data).toBeNull();
    expect(fake.tables.properties[0].archived_at).toBe('2026-01-01T00:00:00Z'); // untouched
  });
});

describe('createPropertyForCustomer', () => {
  it('creates a brand-new property with the given nickname, created:true', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;

    const { data, error, created } = await createPropertyForCustomer('cust-1', { address: '1 Main St', nickname: 'Home' });
    expect(error).toBeNull();
    expect(created).toBe(true);
    expect(data?.address).toBe('1 Main St');
    expect(data?.nickname).toBe('Home');
    expect(fake.tables.properties).toHaveLength(1);
  });

  // #205 review fix (staff/customer MED, F2): a live collision used to
  // silently DROP an explicitly-typed nickname (staff types "Warehouse",
  // sees the form close, believes it saved — it didn't). An explicit
  // nickname now applies on ANY collision, live or archived, symmetric with
  // the archived-collision behavior below.
  it('a collision with an existing LIVE property resolves to that row AND applies an explicitly-typed nickname, created:false', async () => {
    const fake = makeFakeSupabase({
      properties: [
        {
          id: 'p1',
          customer_id: 'cust-1',
          address: '1 Main St',
          address_key: '1 main st',
          nickname: 'Original Label',
          archived_at: null,
        },
      ],
    });
    sbRef.current = fake.client;

    const { data, error, created } = await createPropertyForCustomer('cust-1', { address: '1  MAIN st.', nickname: 'New Label' });
    expect(error).toBeNull();
    expect(created).toBe(false);
    expect(data?.id).toBe('p1');
    expect(data?.nickname).toBe('New Label'); // now APPLIED — the whole point of F2
    expect(fake.tables.properties).toHaveLength(1); // no duplicate
  });

  it('a collision with an existing LIVE property and NO nickname provided leaves its existing nickname untouched', async () => {
    const fake = makeFakeSupabase({
      properties: [
        {
          id: 'p1',
          customer_id: 'cust-1',
          address: '1 Main St',
          address_key: '1 main st',
          nickname: 'Original Label',
          archived_at: null,
        },
      ],
    });
    sbRef.current = fake.client;

    const { data, error, created } = await createPropertyForCustomer('cust-1', { address: '1  MAIN st.' });
    expect(error).toBeNull();
    expect(created).toBe(false);
    expect(data?.id).toBe('p1');
    expect(data?.nickname).toBe('Original Label'); // nothing to apply — untouched
    expect(fake.tables.properties).toHaveLength(1);
  });

  it('a collision with an ARCHIVED property unarchives it and applies the nickname, created:false', async () => {
    const fake = makeFakeSupabase({
      properties: [
        {
          id: 'p1',
          customer_id: 'cust-1',
          address: '1 Main St',
          address_key: '1 main st',
          nickname: null,
          archived_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    sbRef.current = fake.client;

    const { data, error, created } = await createPropertyForCustomer('cust-1', { address: '1 Main St', nickname: 'Resurrected' });
    expect(error).toBeNull();
    expect(created).toBe(false);
    expect(data?.id).toBe('p1');
    expect(data?.archived_at).toBeNull();
    expect(data?.nickname).toBe('Resurrected');
    expect(fake.tables.properties).toHaveLength(1); // no duplicate
  });

  it('a collision with an ARCHIVED property and no nickname provided keeps its existing nickname', async () => {
    const fake = makeFakeSupabase({
      properties: [
        {
          id: 'p1',
          customer_id: 'cust-1',
          address: '1 Main St',
          address_key: '1 main st',
          nickname: 'Keep Me',
          archived_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    sbRef.current = fake.client;

    const { data, created } = await createPropertyForCustomer('cust-1', { address: '1 Main St' });
    expect(created).toBe(false);
    expect(data?.archived_at).toBeNull();
    expect(data?.nickname).toBe('Keep Me');
  });

  // Mirrors findOrCreateProperty's own "genuine hard insert error" test —
  // nothing pre-exists, so the retry re-select genuinely (not just
  // theoretically) finds nothing and the function fails safely rather than
  // throwing or fabricating a row.
  it('returns an error on a genuine hard insert error (not a recoverable race)', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    fake.forceInsertErrorOnce('properties', { code: '500', message: 'connection reset' });

    const { data, error, created } = await createPropertyForCustomer('cust-1', { address: '9 New Rd' });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(created).toBe(false);
    expect(fake.tables.properties).toHaveLength(0);
  });

  it('returns an error (not a throw) when Supabase is unconfigured', async () => {
    sbRef.current = null;
    const { data, error, created } = await createPropertyForCustomer('cust-1', { address: '1 Main St' });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(created).toBe(false);
  });

  // #205 review fix (F6): a genuine concurrent race — no pre-seed, no
  // forced error. Traced precisely via the fake's microtask interleaving
  // (Promise.all queues both calls; each SUSPENDS at its own first await,
  // so both existing-row SELECTs run against the still-empty table before
  // either INSERT lands): the winner's insert succeeds normally: the
  // loser's insert then hits a REAL (unforced) 23505 — by the time its
  // .single() resolves, the winner's row is already in the table — and its
  // retry-select genuinely recovers the winner. This is the SAME technique
  // customers.test.ts already uses for findOrCreateCustomer (see "two
  // concurrent findOrCreateCustomer calls..." above) and is what actually
  // exercises the retry-recovery branch — unlike a pre-seed +
  // forceInsertErrorOnce, which the direct existing-row hit short-circuits
  // before insert is ever attempted (see the sibling fix to
  // findOrCreateProperty's own race test below).
  describe('concurrent calls (#205 F6 — genuine race, retry-recovery path)', () => {
    it('two concurrent calls for the SAME new address converge on ONE row (no duplicate)', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;

      const [a, b] = await Promise.all([
        createPropertyForCustomer('cust-1', { address: '9 New Rd' }),
        createPropertyForCustomer('cust-1', { address: '9 New Rd' }),
      ]);

      expect(a.data?.id).toBeTruthy();
      expect(b.data?.id).toBe(a.data?.id); // same row, not a duplicate
      expect(fake.tables.properties).toHaveLength(1);
      // Exactly one of the two calls actually performed the insert; the
      // other resolved via the retry-recovery path (created:false).
      expect([a.created, b.created].sort()).toEqual([false, true]);
    });

    // The "asserting the archived-winner un-archive + nickname behavior"
    // ask, traced precisely: pre-seeding an ARCHIVED row means BOTH
    // concurrent calls' up-front existing-row SELECT finds it directly —
    // neither one's insert is ever attempted, so this exercises the
    // DIRECT-HIT path on both sides (created:false for both), not the
    // retry-select branch specifically. A retry-select can only ever
    // recover a row that did NOT exist when this invocation's OWN
    // existing-row SELECT ran — and a row created by that same race is, by
    // construction, brand new and never archived. There is no way to make
    // a losing call's retry-select find a PRE-EXISTING archived row in this
    // synchronous fake (nothing removes/hides it between the two calls'
    // identical up-front reads) — reported per the review's own "if a
    // shape is wrong, do the correct thing and say so loudly" instruction.
    // What this test DOES prove, and is genuinely valuable: real
    // concurrent staff double-clicks (or a client retry) on "add property"
    // for an address that resolves to an archived row still converge on
    // ONE row, correctly un-archived, with a typed nickname applied — not
    // two racing writes fighting over the result.
    it('two concurrent calls resolving onto a PRE-EXISTING ARCHIVED row converge on it, un-archived (direct-hit path, both sides)', async () => {
      const fake = makeFakeSupabase({
        properties: [
          {
            id: 'p1',
            customer_id: 'cust-1',
            address: '9 New Rd',
            address_key: '9 new rd',
            nickname: null,
            archived_at: '2026-01-01T00:00:00Z',
          },
        ],
      });
      sbRef.current = fake.client;

      const [a, b] = await Promise.all([
        createPropertyForCustomer('cust-1', { address: '9 New Rd', nickname: 'Warehouse' }),
        createPropertyForCustomer('cust-1', { address: '9 New Rd' }),
      ]);

      expect(a.data?.id).toBe('p1');
      expect(b.data?.id).toBe('p1');
      expect(a.created).toBe(false);
      expect(b.created).toBe(false);
      expect(fake.tables.properties).toHaveLength(1); // never duplicated
      expect(fake.tables.properties[0].archived_at).toBeNull(); // resurrected
      // Deterministic, not a coin-flip: A (first in the Promise.all array)
      // reads the row, computes its OWN patch {archived_at:null,
      // nickname:'Warehouse'}, and its update lands FIRST (same await-depth
      // as B, FIFO microtask order). B reads the row BEFORE A's write
      // lands, so B's own patch is {archived_at:null} only (no nickname to
      // apply) — B's later update never touches the nickname field at all,
      // so A's value survives untouched.
      expect(fake.tables.properties[0].nickname).toBe('Warehouse');
    });
  });
});

describe('findOrCreateProperty — archive resurrection (#205)', () => {
  it('clears archived_at when new quote activity lands on an archived property', async () => {
    const fake = makeFakeSupabase({
      properties: [
        {
          id: 'p1',
          customer_id: 'cust-1',
          address: '1 Main St',
          address_key: '1 main st',
          nickname: 'Keep Me',
          archived_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    sbRef.current = fake.client;

    const res = await findOrCreateProperty('cust-1', '1 Main St');
    expect(res?.id).toBe('p1');
    expect(fake.tables.properties[0].archived_at).toBeNull();
    // nickname is untouched — findOrCreateProperty's scope stops at
    // address/geo/archived_at; nickname is createPropertyForCustomer's job.
    expect(fake.tables.properties[0].nickname).toBe('Keep Me');
  });

  it('does not write archived_at for a property that was already live (no needless write)', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-1', address: '1 Main St', address_key: '1 main st', archived_at: null }],
    });
    sbRef.current = fake.client;

    const res = await findOrCreateProperty('cust-1', '1 Main St');
    expect(res?.id).toBe('p1');
    expect(fake.tables.properties[0].archived_at).toBeNull();
  });

  // #205 review fix (admin MED, F5): the resurrection is otherwise
  // invisible — attachQuoteToCustomer's trigger surface (save/send/mark-
  // sent/nce/legacy-rebook re-attach/backfill) is wide and largely
  // automatic, so a one-line log naming customer + property is the only
  // trace an operator gets.
  it('logs the resurrection (customer + property named) when it actually happens', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-1', address: '1 Main St', address_key: '1 main st', archived_at: '2026-01-01T00:00:00Z' }],
    });
    sbRef.current = fake.client;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await findOrCreateProperty('cust-1', '1 Main St');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toContain('p1');
    expect(infoSpy.mock.calls[0][0]).toContain('cust-1');
    infoSpy.mockRestore();
  });

  it('does NOT log a resurrection for the routine address/geo-only refresh path (already live)', async () => {
    const fake = makeFakeSupabase({
      properties: [{ id: 'p1', customer_id: 'cust-1', address: '1 Main St', address_key: '1 main st', archived_at: null }],
    });
    sbRef.current = fake.client;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await findOrCreateProperty('cust-1', '1 MAIN ST.', { lat: 5, lng: 6 }); // triggers the address/geo update, not a resurrection

    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});

// #205 review fix (admin/technical MED, F4): pre-migration, the existing-row
// SELECT errors (archived_at column not yet added); that error was
// previously swallowed with zero trace, on a hot path reached from every
// quote save/send/re-attach. Uses forceSelectErrorOnce (harness extension
// below) to drive a genuine { data: null, error } from the up-front SELECT.
describe('findOrCreateProperty — existing-row lookup error is logged (#205 F4)', () => {
  it('logs existing.error and still falls through to create/retry-recover safely', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.forceSelectErrorOnce('properties', { message: 'column "archived_at" does not exist' });

    const res = await findOrCreateProperty('cust-1', '1 Main St.');

    // Falls through to a normal create — never crashes, resolves correctly.
    expect(res?.id).toBeTruthy();
    expect(fake.tables.properties).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/existing-row lookup error/i);
    expect(errorSpy.mock.calls[0][1]).toMatchObject({ message: 'column "archived_at" does not exist' });
    errorSpy.mockRestore();
  });
});
