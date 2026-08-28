// Unit test for the HighLevel attach route (Audit fix #53). Locks in the
// "card created but not linked" contract: when the GHL opportunity is
// found/created but the local quotes-row write-back fails, the route must
// still return 200 BUT report `linked:false` (so the operator UI can offer a
// safe retry) and emit a console.error naming the quoteId + opportunityId so
// the orphaned GHL card is discoverable. On a clean write-back, `linked:true`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Mocks (hoisted so the vi.mock factories can see them) ───────────────────
const { sbRef, hl, attachQuoteToCustomerMock, requireOperatorMock, getOperatorMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    findOrCreate: vi.fn(async () => ({ opportunity: { id: 'opp-1' }, created: false })),
  },
  // #214 (d): the route re-resolves the customers link after a successful
  // link write — mocked so these unit tests never touch a customers table.
  attachQuoteToCustomerMock: vi.fn(async () => null as null | { customerId: string; propertyId: string }),
  // Row 326 residual (b): the refusal-audit write calls getOperator() directly
  // (not gated behind requireOperator's AUTH_GATE_ENABLED dormancy), so it must
  // be mocked explicitly — mirrors staff-decline/route.test.ts's pattern.
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async () => null as { email: string | null } | null),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));

// ledger #347: requireOperator is engaged by default (it used to be dormant
// unless AUTH_GATE_ENABLED==='true'), so requireOperatorMock above stubs it
// authorized like every other route.ts suite. It is mocked in the SAME
// vi.mock factory as getOperator on purpose: a second vi.mock() for the same
// module silently REPLACES the first, which is exactly how the row 326 audit
// tests broke when #347 and #326 were combined -- getOperator lost its mock.

// #214: importOriginal keeps quoteRowToIdentity (pure sentinel translation)
// REAL — only the DB-touching fn is mocked.
vi.mock('@/lib/customers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/customers')>()),
  attachQuoteToCustomer: attachQuoteToCustomerMock,
}));

vi.mock('@/lib/integrations/highlevel', () => ({
  findOrCreateOpportunityForContact: hl.findOrCreate,
  isHighLevelConfigured: () => true,
  HighLevelError: class HighLevelError extends Error {},
}));

// Rate limiter is a no-op in tests (never trips at this volume).
vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
}));

import { POST } from './route';

// ── Fake Supabase query builder ─────────────────────────────────────────────
// The route does three chains:
//   read:    from('quotes').select().eq().maybeSingle()          → the quote row
//            (service_type drives the per-type pipeline resolution)
//   detach write (#839 round-2 delta-verify MED, CAS-guarded):
//            from().update().eq()[.is().is()].select().maybeSingle() → { data, error }
//   identity write (#839 fix-round MED, CAS-guarded):
//            from().update().eq()[.is().is()].select().maybeSingle() → { data, error }
// Both writes share the exact same chain shape (one `makeUpdateChain()`
// serves both) — `.is()/.select()/.maybeSingle()`, exactly like a real
// Postgrest builder.
function makeSb(
  quote: Record<string, unknown> | null,
  updateErr: { message: string } | null = null,
  opts: {
    identityCasMatch?: boolean;
    // Fix-round HIGH (data-loss bug): makes any `.select('approval_snapshot')`
    // read (readApprovalSnapshot — used at all four refusal call sites AND
    // inside logIdentityRefusal's own internal retry) fail, so the bail-out
    // path is actually reachable in the test harness. Never affects the
    // wide-column quote/detach pre-read (a different `.select(...)` string),
    // so the freeze branches themselves are unaffected.
    approvalSnapshotReadFails?: boolean;
    // Row 326 fix-round MED: how many times logIdentityRefusal's own value
    // CAS (the approval_snapshot equality filter) reports "0 rows matched"
    // before it succeeds — 0 (default) matches immediately, 1 misses once
    // then succeeds on the internal retry, 2 exhausts both attempts (gives
    // up, no entry ever lands).
    auditCasMissCount?: number;
    // Row 326 final-round LOW (coverage gap, delta-verify-found): successive
    // `.select('approval_snapshot')` reads return successive entries from
    // this array (last entry repeats once exhausted) instead of the fixed
    // `quote.approval_snapshot` — lets a test prove the retry's re-read
    // returns a DIFFERENT (fresher) value than the site-level read that fed
    // attempt 0, so a regression that reused the stale snapshot on retry is
    // actually caught instead of silently passing.
    approvalSnapshotSequence?: unknown[];
  } = {},
) {
  // identityCasMatch controls whether a CAS write's `.is(...)` conditions
  // would match in a real DB — false simulates approval/booking having
  // landed by the time that specific statement runs (a TOCTOU race, or an
  // already-frozen row), regardless of what the earlier pre-read (`quote`)
  // says. Applies to BOTH the identity write and the detach write (round-2
  // delta-verify MED — sibling parity), since both now share the same
  // CAS-guarded chain. Only takes effect on a chain that actually called
  // `.is(...)` — the is_test-bypass branch of either write never does, so it
  // always "matches" regardless of this flag. Defaults to true (matches —
  // not frozen) so every pre-#839 test above, which never touches this
  // option, keeps behaving exactly as before.
  const casMatch = opts.identityCasMatch ?? true;
  let auditCasMissesRemaining = opts.auditCasMissCount ?? 0;
  let isUpdate = false;
  let pendingUpdatePayload: Record<string, unknown> | undefined;
  let lastSelectCols: string | undefined;
  let approvalSnapshotReadCount = 0;
  // Row 326 final-round LOW: records every value-CAS filter argument (in
  // call order) so a test can assert WHICH snapshot each write attempt
  // actually CASed on — the retry-freshness gap the delta-verify found would
  // otherwise pass silently (a stale-snapshot retry still "succeeds" in this
  // fake unless the test inspects the filter value itself).
  const auditCasFilters: string[] = [];
  // Row 326 residual (b): records every update() payload (in call order) so
  // tests can assert on the audit-marker write's shape without adding a
  // fourth chain kind — the marker write is a plain
  // from().update(payload).eq() with no .select()/.maybeSingle() follow-up,
  // so it resolves through makeUpdateChain()'s `then` below like the others.
  const updateCalls: Record<string, unknown>[] = [];
  const builder: Record<string, unknown> = { updateCalls, auditCasFilters };
  function makeUpdateChain() {
    let hasIsFilter = false;
    const chain: Record<string, unknown> = {
      is: () => {
        hasIsFilter = true;
        return chain;
      },
      select: () => chain,
      maybeSingle: async () => {
        if (updateErr) return { data: null, error: updateErr };
        if (hasIsFilter && !casMatch) return { data: null, error: null };
        return { data: { id: 'matched' }, error: null };
      },
      then: (resolve: (v: { error: unknown }) => void) => resolve({ error: updateErr }),
    };
    return chain;
  }
  // Fix-round MED: logIdentityRefusal's write is a DIFFERENT chain shape from
  // the route's other CAS writes above — a value CAS (`.eq('approval_snapshot',
  // JSON.stringify(prior))` instead of `.is(...)`), and it's awaited directly
  // after `.select('id')` with NO `.maybeSingle()` (array-returning, like the
  // real amend/free-items siblings). Dispatched below whenever the update
  // payload carries an `approval_snapshot` key — no other write in this route
  // ever does.
  function makeAuditWriteChain() {
    const chain: Record<string, unknown> = {
      eq: (_col: string, value: unknown) => {
        auditCasFilters.push(String(value));
        return chain;
      },
      select: () => chain,
      then: (resolve: (v: { data: unknown[] | null; error: unknown }) => void) => {
        if (updateErr) return resolve({ data: null, error: updateErr });
        if (auditCasMissesRemaining > 0) {
          auditCasMissesRemaining -= 1;
          return resolve({ data: [], error: null }); // 0 rows matched
        }
        return resolve({ data: [{ id: 'matched' }], error: null });
      },
    };
    return chain;
  }
  Object.assign(builder, {
    from: () => builder,
    select: (cols?: string) => {
      lastSelectCols = cols;
      return builder;
    },
    update: (payload: Record<string, unknown>) => {
      updateCalls.push(payload);
      isUpdate = true;
      pendingUpdatePayload = payload;
      return builder;
    },
    eq: () => {
      if (isUpdate) {
        isUpdate = false;
        const payload = pendingUpdatePayload;
        pendingUpdatePayload = undefined;
        return payload && 'approval_snapshot' in payload ? makeAuditWriteChain() : makeUpdateChain();
      }
      return builder;
    },
    maybeSingle: async () => {
      if (lastSelectCols === 'approval_snapshot') {
        if (opts.approvalSnapshotReadFails) {
          return { data: null, error: { message: 'db read failed (simulated)' } };
        }
        if (opts.approvalSnapshotSequence) {
          const idx = Math.min(approvalSnapshotReadCount, opts.approvalSnapshotSequence.length - 1);
          approvalSnapshotReadCount += 1;
          return { data: { approval_snapshot: opts.approvalSnapshotSequence[idx] }, error: null };
        }
      }
      return { data: quote, error: null };
    },
  });
  return builder;
}

const QUOTE_ID = '11111111-2222-4333-8444-555555555555';
const HOLIDAY_QUOTE = { id: QUOTE_ID, service_type: 'holiday' };

function makeReq(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  hl.findOrCreate.mockResolvedValue({ opportunity: { id: 'opp-1' }, created: false });
  process.env.HIGHLEVEL_PIPELINE_ID = 'pipe-1';
  process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = 'stage-created';
});

describe('HighLevel attach — write-back success', () => {
  it('returns 200 with linked:true when the quote row updates cleanly', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.opportunityId).toBe('opp-1');
    expect(json.linked).toBe(true);
  });
});

// #172: the builder's Clear button is a real undo — detach clears the local
// link (both GHL columns) without touching GHL, and never runs find-or-create.
describe('HighLevel attach — detach (#172)', () => {
  it('detach:true clears the link and returns detached:true without any GHL call', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.detached).toBe(true);
    expect(hl.findOrCreate).not.toHaveBeenCalled();
  });

  it('detach surfaces a DB failure as 500 (the link may still exist)', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, { message: 'db down' });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
    expect(res.status).toBe(500);
  });

  // #839 round-2 delta-verify MED (sibling-guard parity — the same TOCTOU
  // class the attach write was CAS-gated for, same file): the pre-read above
  // and the plain update that used to follow it are two separate round
  // trips. An approval landing in that gap used to null the HighLevel ids on
  // a now-approved/booked quote with no CAS at all — an HL-id split, since
  // customer_id/customer_* stay put. The detach write is now CAS-guarded the
  // same way; proven here by a pre-read that looks UNAPPROVED (so the
  // pre-read freeze check does NOT fire) whose CAS write then fails to match
  // (simulating approval landing mid-flight, between the read and the write).
  it('CAS-blocks the detach write when approval lands between the pre-read and the write (#839 round-2 delta-verify MED)', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null, { identityCasMatch: false });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ detached: false, identityFrozen: true });
  });

  // Row 338 (identity-freeze STICKY hatch): the pre-detach freeze check
  // reads customer_approved_at/deposit_paid_at directly off the pre-read row
  // — both null on a REVIVED quote (#116's revive write clears
  // customer_approved_at) — but approval_snapshot still carries the marker
  // from the ORIGINAL approval. `identityCasMatch` is left at its default
  // (true — CAS would MATCH) so this isolates the PRE-READ bail specifically:
  // if wasEverApproved were reverted, the pre-read check would pass this
  // quote through, the CAS write would then also match (nothing there is
  // frozen either), and the Clear would silently succeed.
  it('refuses a detach on a REVIVED quote whose approval_snapshot still carries approvedAt, even though the live columns read null (row 338)', async () => {
    sbRef.current = makeSb({
      ...HOLIDAY_QUOTE,
      is_test: false,
      customer_approved_at: null,
      deposit_paid_at: null,
      approval_snapshot: { approvedAt: '2026-06-01T00:00:00Z' },
    });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ detached: false, identityFrozen: true });
  });

  // is_test bypasses the detach CAS entirely (the #251 exemption — test
  // quotes stay fully editable regardless of lifecycle stamps), even on a
  // quote that otherwise looks approved.
  it('is_test bypasses the detach CAS even on an approved-looking quote', async () => {
    sbRef.current = makeSb(
      { ...HOLIDAY_QUOTE, is_test: true, customer_approved_at: '2026-08-10T00:00:00Z' },
      null,
      { identityCasMatch: false },
    );

    const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ detached: true });
  });
});

// #247: the create-fallback card name must be the customer's name (or the
// generic "Yule Love Lights quote"), never the old vertical-specific
// "Holiday Lights quote {id}" literal — this route serves every vertical.
describe('HighLevel attach — create-fallback card name (#247)', () => {
  it('uses opportunityName when the caller supplies one', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', opportunityName: 'Jane Smith' }));
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackName: 'Jane Smith' }),
    );
  });

  it('falls back to contactName when opportunityName is absent', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', contactName: 'John Q. Public' }));
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackName: 'John Q. Public' }),
    );
  });

  it('falls back to the generic "Yule Love Lights quote" when neither name is available — never the old vertical-specific literal', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackName: 'Yule Love Lights quote' }),
    );
  });
});

describe('HighLevel attach — per-service-type pipeline (#GHL pipeline sync)', () => {
  it('a holiday quote still honors the legacy env vars (pipeline + entry stage)', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'pipe-1', // HIGHLEVEL_PIPELINE_ID
        fallbackStageId: 'stage-created', // HIGHLEVEL_STAGE_QUOTE_CREATED
      }),
    );
  });

  it('a PERMANENT quote lands in the permanent pipeline at its "New Lead" entry stage, ignoring env vars', async () => {
    sbRef.current = makeSb({ id: QUOTE_ID, service_type: 'permanent' }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'OqpjVflTdgmjmUQmbcSF',
        fallbackStageId: 'c052d345-8e95-4716-a7e7-62e63937b5ea', // New Lead
      }),
    );
  });

  it('an EVENT quote lands in the event pipeline at its "Open" entry stage', async () => {
    sbRef.current = makeSb({ id: QUOTE_ID, service_type: 'event' }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'YfCi5jy8Alc3oD5AfXmV',
        fallbackStageId: 'c6e089f5-c458-47a0-a7ae-25385df6a53f', // Open
      }),
    );
  });

  it('legacy_rebook (#156): a legacy rebook quote (service_type holiday) routes to the Neighbors pipeline, never Christmas Lights', async () => {
    sbRef.current = makeSb({ id: QUOTE_ID, service_type: 'holiday', legacy_rebook: true }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'TIYqklVJ349F5heaSkCs', // Yule Love Lights Neighbors
        fallbackStageId: '9ada8238-1e95-4242-b567-7edf3bef6c2c', // Bid Sent
      }),
    );
  });

  it('a quote whose row cannot be read defaults to the holiday pipeline (fail-open)', async () => {
    sbRef.current = makeSb(null, null); // maybeSingle → no row

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: 'pipe-1', fallbackStageId: 'stage-created' }),
    );
  });
});

// #214 (d): the attach route is where a quote GAINS its hl id after insert —
// it re-runs the customers resolution so an hl-less linked customers row
// heals (the #700 heal lives inside attachQuoteToCustomer) and the #213
// rules finally see the pick. Review fix (3-lens HIGH): the identity comes
// from the request body's PICKED-CONTACT fields, NEVER the stored quote row
// — the stored fields describe whoever the quote referenced BEFORE the
// pick, and that self-inconsistent pairing could adopt + overwrite the
// wrong customer's row.
describe('HighLevel attach — post-link customers re-resolution (#214)', () => {
  const CONTACT_FIELDS = {
    contactName: 'Jane Doe',
    contactEmail: 'jane@x.com',
    contactPhone: '6315550100',
    contactAddress: '1 A St, Bellmore, NY',
  };

  it("re-resolves with the PICKED CONTACT's own fields + id after a clean link write", async () => {
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: QUOTE_ID,
        highlevel_contact_id: 'contact-1',
        customer_name: 'Jane Doe',
        customer_email: 'jane@x.com',
        customer_phone: '6315550100',
        customer_address: '1 A St, Bellmore, NY',
      }),
    );
  });

  it('NEVER derives the identity from the stored quote row (the stale-fields clobber class)', async () => {
    sbRef.current = makeSb(
      // Stored row describes a DIFFERENT person than the picked contact.
      { ...HOLIDAY_QUOTE, is_test: false, customer_name: 'John Smith', customer_email: 'john@x.com' },
      null,
    );

    await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    const identity = (attachQuoteToCustomerMock.mock.calls as unknown as unknown[][])[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(identity.customer_name).toBe('Jane Doe');
    expect(identity.customer_email).toBe('jane@x.com');
    expect(JSON.stringify(identity)).not.toContain('John Smith');
  });

  it('SKIPS re-resolution when the body carries no non-hl contact field (an hl-only identity would fork a bare row)', async () => {
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  it('a contactAddress alone does NOT count as an identity field (address is never a match key)', async () => {
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false }, null);

    await POST(
      makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', contactAddress: '1 A St' }),
    );
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  it('warns loudly when the re-resolution REPOINTS the quote off a previously-linked customer', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    attachQuoteToCustomerMock.mockResolvedValueOnce({ customerId: 'cust-new', propertyId: 'p1' });
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false, customer_id: 'cust-old' }, null);

    await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('repoint'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cust-old'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cust-new'));
    warnSpy.mockRestore();
  });

  it('never re-resolves for a TEST quote (attachQuoteToCustomer must not run with test data)', async () => {
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: true }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  // Round-3 delta-verify HIGH (sibling-guard parity with updateQuote's
  // booked-freeze): jobs/invoices/GHL tenure snapshot the customers link at
  // booking and never resync. SUPERSEDED by Jason's 2026-08-20 ruling —
  // identity is ATOMIC past approval, so the GHL card link no longer moves
  // either: the whole endpoint is a no-op and corrections go through amend.
  it('refuses the WHOLE re-link on a BOOKED quote (deposit paid) — GHL link and customers link both frozen', async () => {
    sbRef.current = makeSb(
      { ...HOLIDAY_QUOTE, is_test: false, deposit_paid_at: '2026-08-01T00:00:00Z', customer_id: 'cust-frozen' },
      null,
    );

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.linked).toBe(false); // #251 atomic identity — no GHL write either
    expect(json.identityFrozen).toBe(true);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  // #839 fix-round HIGH (staff+technical lenses): this is the live incident's
  // ACTUAL click path — pickHighLevelContact calls this route directly on a
  // confirmed pick (queueAttach), before any Calculate ever reaches
  // updateQuote's own #251 freeze. An approved-but-unpaid quote must be
  // frozen HERE too, exactly like the booked case above — parity with
  // quotes.ts's identical widening (~line 564).
  it('refuses the WHOLE re-link on an APPROVED-but-unpaid quote — GHL link and customers link both frozen', async () => {
    sbRef.current = makeSb(
      {
        ...HOLIDAY_QUOTE,
        is_test: false,
        customer_approved_at: '2026-08-10T00:00:00Z',
        customer_id: 'cust-frozen',
      },
      null,
    );

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.linked).toBe(false); // #251 atomic identity — no GHL write either
    expect(json.identityFrozen).toBe(true);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  // Row 338 (identity-freeze STICKY hatch): #116's revive write clears
  // customer_approved_at on a declined→sent revive, so a quote that was
  // approved-then-declined-then-revived would read as UNFROZEN by
  // deposit_paid_at/customer_approved_at alone — the queueAttach click path
  // (this route, fired directly on a confirmed contact pick, ahead of any
  // Calculate) would silently repoint it. approval_snapshot still carries
  // the marker from the ORIGINAL approval (staff-decline only ADDS a key via
  // spread, never removes one — see wasEverApproved's comment in
  // quoteStatus.ts), so the pre-read bail check must catch this even with
  // both live lifecycle columns null.
  it('refuses the WHOLE re-link on a REVIVED quote whose approval_snapshot still carries approvedAt, even though the live columns read null (row 338)', async () => {
    sbRef.current = makeSb(
      {
        ...HOLIDAY_QUOTE,
        is_test: false,
        customer_approved_at: null,
        deposit_paid_at: null,
        approval_snapshot: { approvedAt: '2026-06-01T00:00:00Z' },
        customer_id: 'cust-frozen',
      },
      null,
    );

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.linked).toBe(false);
    expect(json.identityFrozen).toBe(true);
    expect(hl.findOrCreate).not.toHaveBeenCalled(); // bails BEFORE any GHL work
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  // #839 fix-round MED (delta-verify — TOCTOU): the early freeze check above
  // (lines ~165-180) reads the quote row BEFORE findOrCreateOpportunityForContact's
  // GHL network round trip (hundreds of ms). If the quote becomes approved/
  // booked DURING that window, the early check alone can't catch it — it
  // already ran and passed. This simulates exactly that: the pre-read quote
  // looks UNAPPROVED (passes the early check, `hl.findOrCreate` gets called),
  // but the identity write's own CAS fails to match, as it would if the row
  // had become approved/booked in the meantime.
  it('refuses the link when the identity write CAS fails to match (approval landed during the GHL round trip)', async () => {
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false }, null, { identityCasMatch: false });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalled(); // the early check passed; the race is write-time
    expect(json.linked).toBe(false);
    expect(json.identityFrozen).toBe(true);
    // Same atomic freeze — the customers re-resolution must not run either.
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  it('the CAS is bypassed for a TEST quote — the identity write matches regardless', async () => {
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: true }, null, { identityCasMatch: false });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.linked).toBe(true);
    expect(json.identityFrozen).toBeUndefined();
  });

  // Round-3 delta-verify MED: the non-hl-field gate runs POST-translation —
  // a contact literally named 'Anonymous' (no email/phone) must not sneak
  // an hl-only identity past the guard.
  it("a contact named literally 'Anonymous' with no email/phone does NOT count as a non-hl field", async () => {
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false }, null);

    await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', contactName: 'Anonymous' }));
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  it('skips re-resolution when the link write-back failed (linked:false path)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false }, { message: 'db down' });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('skips re-resolution when the quote row could not be read (fail-open path — no is_test answer)', async () => {
    sbRef.current = makeSb(null, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  it('the response is unchanged when re-resolution throws (best-effort)', async () => {
    attachQuoteToCustomerMock.mockRejectedValueOnce(new Error('customers table missing'));
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1', ...CONTACT_FIELDS }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.linked).toBe(true);
  });
});

// Row 326 residual (b): until now a refused identity change (either freeze
// point, either action) left only a console.warn — server logs only, not
// owner-queryable. Every refusal now merges an entry onto
// approval_snapshot.identityChangeRefusals (append-only, mirrors
// amend/route.ts's amendments[]) in the SAME database write, so an owner can
// later query WHO tried WHAT on an approved/booked quote and WHEN — the
// missing half of row 251's own near-miss.
describe('HighLevel attach — refusal audit trace (row 326 residual b)', () => {
  function updatesOf(): Record<string, unknown>[] {
    return (sbRef.current as unknown as { updateCalls: Record<string, unknown>[] }).updateCalls;
  }
  function refusalsFrom(payload: Record<string, unknown> | undefined): Record<string, unknown>[] {
    const snapshot = payload?.approval_snapshot as Record<string, unknown> | undefined;
    return (snapshot?.identityChangeRefusals as Record<string, unknown>[] | undefined) ?? [];
  }

  it('writes an identityChangeRefusals entry (and preserves prior snapshot content) when the pre-read freeze refuses an attach', async () => {
    getOperatorMock.mockResolvedValueOnce({ email: 'staff@yulelovelights.com' });
    sbRef.current = makeSb({
      ...HOLIDAY_QUOTE,
      is_test: false,
      customer_approved_at: '2026-08-10T00:00:00Z',
      approval_snapshot: { approvedAt: '2026-08-10T00:00:00Z' },
    });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ linked: false, identityFrozen: true });

    const refusalWrite = updatesOf().find((p) => refusalsFrom(p).length > 0);
    expect(refusalWrite).toBeDefined();
    const [entry] = refusalsFrom(refusalWrite);
    expect(entry).toMatchObject({
      by: 'staff@yulelovelights.com',
      action: 'attach',
      attemptedContactId: 'contact-1',
      stage: 'pre-read',
    });
    // The pre-existing approval_snapshot content (the original approval
    // marker) must survive the merge — never clobbered by the audit write.
    expect((refusalWrite!.approval_snapshot as Record<string, unknown>).approvedAt).toBe(
      '2026-08-10T00:00:00Z',
    );
  });

  it('writes an identityChangeRefusals entry when the pre-read freeze refuses a detach', async () => {
    getOperatorMock.mockResolvedValueOnce({ email: 'staff@yulelovelights.com' });
    sbRef.current = makeSb({
      ...HOLIDAY_QUOTE,
      is_test: false,
      customer_approved_at: '2026-08-10T00:00:00Z',
      // A frozen quote's approval_snapshot is always populated by /approve —
      // see logIdentityRefusal's own null-base guard: an absent snapshot now
      // means "unconfirmed," not "empty," and the write is skipped.
      approval_snapshot: { approvedAt: '2026-08-10T00:00:00Z' },
    });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ detached: false, identityFrozen: true });

    const refusalWrite = updatesOf().find((p) => refusalsFrom(p).length > 0);
    const [entry] = refusalsFrom(refusalWrite);
    expect(entry).toMatchObject({
      by: 'staff@yulelovelights.com',
      action: 'detach',
      attemptedContactId: null,
      stage: 'pre-read',
    });
  });

  it('writes a write-time-stage entry when the attach CAS refusal fires (approval landed during the GHL round trip)', async () => {
    // approval_snapshot must be a CONFIRMED (non-null) value here — the
    // write-time site's readApprovalSnapshot call feeds logIdentityRefusal,
    // whose own null-base guard now refuses to write on an unconfirmed
    // snapshot (fix-round HIGH, the data-loss bug).
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false, approval_snapshot: {} }, null, {
      identityCasMatch: false,
    });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ linked: false, identityFrozen: true });

    const refusalWrite = updatesOf().find((p) => refusalsFrom(p).length > 0);
    const [entry] = refusalsFrom(refusalWrite);
    expect(entry).toMatchObject({ action: 'attach', attemptedContactId: 'contact-1', stage: 'write-time' });
  });

  it('writes a write-time-stage entry when the detach CAS refusal fires', async () => {
    sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false, approval_snapshot: {} }, null, {
      identityCasMatch: false,
    });

    const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ detached: false, identityFrozen: true });

    const refusalWrite = updatesOf().find((p) => refusalsFrom(p).length > 0);
    const [entry] = refusalsFrom(refusalWrite);
    expect(entry).toMatchObject({ action: 'detach', attemptedContactId: null, stage: 'write-time' });
  });

  it('never writes an audit entry when the attach succeeds normally (not frozen)', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(updatesOf().some((p) => refusalsFrom(p).length > 0)).toBe(false);
  });

  it('never writes an audit entry when a detach succeeds normally (not frozen)', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
    expect(updatesOf().some((p) => refusalsFrom(p).length > 0)).toBe(false);
  });

  // Fix-round HIGH (data-loss bug, review-caught): a failed approval_snapshot
  // re-read must SKIP the audit write entirely, never fall back to `{}` and
  // write that back — doing so would REPLACE the real frozen agreement
  // (total, deposit, line items, approvedAt/staffApproved, colour selection)
  // with just the new audit entry. Covers all four refusal sites.
  describe('a failed approval_snapshot read never triggers a write (never clobbers the frozen agreement)', () => {
    it('attach pre-read freeze: skips the audit write, refusal response unchanged', async () => {
      sbRef.current = makeSb(
        {
          ...HOLIDAY_QUOTE,
          is_test: false,
          customer_approved_at: '2026-08-10T00:00:00Z',
          approval_snapshot: { approvedAt: '2026-08-10T00:00:00Z' },
        },
        null,
        { approvalSnapshotReadFails: true },
      );

      const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ linked: false, identityFrozen: true });
      // No update call ever carries approval_snapshot — logIdentityRefusal
      // was never even invoked (the site-level bail-out fired first).
      expect(updatesOf().some((p) => 'approval_snapshot' in p)).toBe(false);
    });

    it('detach pre-read freeze: skips the audit write, refusal response unchanged', async () => {
      sbRef.current = makeSb(
        {
          ...HOLIDAY_QUOTE,
          is_test: false,
          customer_approved_at: '2026-08-10T00:00:00Z',
          approval_snapshot: { approvedAt: '2026-08-10T00:00:00Z' },
        },
        null,
        { approvalSnapshotReadFails: true },
      );

      const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ detached: false, identityFrozen: true });
      expect(updatesOf().some((p) => 'approval_snapshot' in p)).toBe(false);
    });

    it('attach write-time CAS refusal: skips the audit write, refusal response unchanged', async () => {
      sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false, approval_snapshot: {} }, null, {
        identityCasMatch: false,
        approvalSnapshotReadFails: true,
      });

      const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ linked: false, identityFrozen: true });
      expect(updatesOf().some((p) => 'approval_snapshot' in p)).toBe(false);
    });

    it('detach write-time CAS refusal: skips the audit write, refusal response unchanged', async () => {
      sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false, approval_snapshot: {} }, null, {
        identityCasMatch: false,
        approvalSnapshotReadFails: true,
      });

      const res = await POST(makeReq({ quoteId: QUOTE_ID, detach: true }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ detached: false, identityFrozen: true });
      expect(updatesOf().some((p) => 'approval_snapshot' in p)).toBe(false);
    });
  });

  // Row 326 fix-round MED: the value CAS is optimistic concurrency, not a
  // freeze check — a lost race must retry once against a freshly re-read
  // snapshot, and only give up (silently — the refusal response is
  // untouched either way) after a second miss.
  describe('the audit write itself retries once on a lost optimistic-concurrency race', () => {
    it('retries once and lands the entry when the first CAS attempt loses the race', async () => {
      getOperatorMock.mockResolvedValueOnce({ email: 'staff@yulelovelights.com' });
      sbRef.current = makeSb(
        {
          ...HOLIDAY_QUOTE,
          is_test: false,
          customer_approved_at: '2026-08-10T00:00:00Z',
          approval_snapshot: { approvedAt: '2026-08-10T00:00:00Z' },
        },
        null,
        { auditCasMissCount: 1 },
      );

      const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ linked: false, identityFrozen: true });

      // Two attempted writes carrying approval_snapshot: the lost first
      // attempt, then the retry that actually lands.
      const attempts = updatesOf().filter((p) => 'approval_snapshot' in p);
      expect(attempts.length).toBe(2);
      const [entry] = refusalsFrom(attempts[1]);
      expect(entry).toMatchObject({ by: 'staff@yulelovelights.com', action: 'attach', stage: 'pre-read' });
    });

    // Row 326 final-round LOW (delta-verify coverage gap): the retry must
    // CAS on a FRESHLY re-read snapshot, not silently reuse the stale value
    // from attempt 0 — a stale-snapshot retry would always CAS on the same
    // (already-losing) value, and would drop whatever a concurrent
    // legitimate write (amend/pay/apply-color-request) had just added.
    // Neither the CAS-miss-count nor the payload-shape assertions above
    // would catch that regression (the miss counter fires on call COUNT,
    // not on the filter's actual value) — this test inspects the filter
    // value and a distinguishing key directly.
    it('CASes the retry on the FRESH re-read, not the stale first-attempt snapshot, and preserves a concurrent write', async () => {
      const baseSnapshot = { approvedAt: '2026-08-10T00:00:00Z' };
      // Simulates a concurrent legitimate write (e.g. amend/pay) landing
      // between attempt 0 and the retry's re-read.
      const concurrentSnapshot = { approvedAt: '2026-08-10T00:00:00Z', someOtherKey: 'x' };
      sbRef.current = makeSb({ ...HOLIDAY_QUOTE, is_test: false, customer_approved_at: '2026-08-10T00:00:00Z' }, null, {
        auditCasMissCount: 1,
        approvalSnapshotSequence: [baseSnapshot, concurrentSnapshot],
      });

      const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ linked: false, identityFrozen: true });

      const auditCasFilters = (sbRef.current as unknown as { auditCasFilters: string[] }).auditCasFilters;
      expect(auditCasFilters.length).toBe(2);
      // Attempt 0 CASed on the site-level (first) read...
      expect(auditCasFilters[0]).toBe(JSON.stringify(baseSnapshot));
      // ...and the retry MUST CAS on the fresh re-read, not the stale value
      // attempt 0 used. A retry that reused `baseSnapshot` here would fail
      // this line while every other assertion in this file stays green.
      expect(auditCasFilters[1]).toBe(JSON.stringify(concurrentSnapshot));

      const attempts = updatesOf().filter((p) => 'approval_snapshot' in p);
      expect(attempts.length).toBe(2);
      const landedPayload = attempts[1].approval_snapshot as Record<string, unknown>;
      // The concurrent write's key must survive — a stale-snapshot retry
      // would silently drop it.
      expect(landedPayload.someOtherKey).toBe('x');
      const [entry] = refusalsFrom(attempts[1]);
      expect(entry).toMatchObject({ action: 'attach', stage: 'pre-read' });
    });

    it('gives up silently (no clobber, response unchanged) after losing the race twice', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sbRef.current = makeSb(
        {
          ...HOLIDAY_QUOTE,
          is_test: false,
          customer_approved_at: '2026-08-10T00:00:00Z',
          approval_snapshot: { approvedAt: '2026-08-10T00:00:00Z' },
        },
        null,
        { auditCasMissCount: 2 },
      );

      const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ linked: false, identityFrozen: true });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('lost the optimistic-concurrency race twice'),
      );
      warnSpy.mockRestore();
    });
  });
});

describe('HighLevel attach — write-back failure (the fix #53)', () => {
  it('returns 200 with linked:false and logs an error naming quoteId + opportunityId', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, { message: 'db down' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    const json = await res.json();

    // Still a 200 — the GHL card exists; retry is safe and re-attaches.
    expect(res.status).toBe(200);
    expect(json.opportunityId).toBe('opp-1');
    expect(json.linked).toBe(false);

    // The orphan must be discoverable in the logs.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errSpy.mock.calls[0]);
    expect(logged).toContain(QUOTE_ID);
    expect(logged).toContain('opp-1');

    errSpy.mockRestore();
  });
});
