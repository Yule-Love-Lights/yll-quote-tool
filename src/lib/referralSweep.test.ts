// Tests for the referral link sweep (naldo/referral-link-sweep).
//
// IO seams mocked (GHL + Supabase); the pure suppression/idempotency helpers
// and ghlPipelineMap's real allPipelineStages/checkNeighborsSuppression run
// for real, so the fail-loud + suppression logic is genuinely exercised
// against the SAME constants the production code uses (not a re-typed copy
// that could silently drift from them).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HighLevelContact, HighLevelOpportunity } from '@/lib/integrations/types';

const {
  hlConfigured,
  listPipelines,
  searchContactsPage,
  findAllOpportunitiesForContact,
  addContactTags,
  findOrCreateCustomer,
  getCustomerByHlContactId,
  ensureReferralCode,
  stampReferralLinkOnContact,
} = vi.hoisted(() => ({
  hlConfigured: { value: true },
  listPipelines: vi.fn(async (): Promise<unknown> => ({ pipelines: [] })),
  searchContactsPage: vi.fn(
    async (_input: { pageLimit?: number; searchAfter?: unknown[] }) =>
      ({ contacts: [] as HighLevelContact[], nextSearchAfter: undefined as unknown[] | undefined }),
  ),
  findAllOpportunitiesForContact: vi.fn(async (_contactId: string, _pipelineId: string) => [] as HighLevelOpportunity[]),
  addContactTags: vi.fn(async (_contactId: string, _tags: string[]) => ({}) as { tags?: string[] }),
  findOrCreateCustomer: vi.fn(async (_identity: unknown, _opts?: unknown) => ({ id: 'cust-1' }) as { id: string } | null),
  getCustomerByHlContactId: vi.fn(async (_id: string) => null as { id: string } | null),
  ensureReferralCode: vi.fn(async (_id: string) => 'CODE1234' as string | null),
  stampReferralLinkOnContact: vi.fn(async (_id: string | null, _code: string) => true),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => supabaseMock.client }));

vi.mock('@/lib/integrations/highlevel', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/integrations/highlevel')>();
  return {
    ...actual,
    isHighLevelConfigured: () => hlConfigured.value,
    listPipelines,
    searchContactsPage,
    findAllOpportunitiesForContact,
    addContactTags,
  };
});

vi.mock('@/lib/customers', () => ({ findOrCreateCustomer, getCustomerByHlContactId }));

vi.mock('@/lib/referrals', () => ({
  ensureReferralCode,
  stampReferralLinkOnContact,
  REFERRAL_LINK_FIELD_ENV: 'HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK',
}));

import { runReferralSweep, alreadyProcessed, isSuppressedByOpportunities } from './referralSweep';
import { HighLevelError } from '@/lib/integrations/highlevel';
import {
  NEIGHBORS_PIPELINE_ID,
  NEIGHBORS_DECLINED_STAGE_ID,
  NEIGHBORS_DO_NOT_CALL_STAGE_NAME,
} from '@/lib/integrations/ghlPipelineMap';

// ─── Supabase fake: just enough of the query-builder chain the sweep uses ──

type FakeError = { message: string } | null;

function makeSupabaseMock(opts: { bookedCustomerIds?: Set<string>; initialCursor?: unknown[] | null } = {}) {
  const bookedCustomerIds = opts.bookedCustomerIds ?? new Set<string>();
  let cursorValue: unknown[] | null = opts.initialCursor ?? null;
  const savedCursors: (unknown[] | null)[] = [];
  let quotesQueryError: FakeError = null;

  const client = {
    from(table: string) {
      if (table === 'quotes') {
        return {
          select: () => ({
            eq: (_c1: string, customerId: string) => ({
              eq: () => ({
                not: () => ({
                  limit: async () => ({
                    data: quotesQueryError ? null : bookedCustomerIds.has(customerId) ? [{ id: 'q1' }] : [],
                    error: quotesQueryError,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'app_settings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: cursorValue !== null ? { value: { searchAfter: cursorValue } } : null,
                error: null,
              }),
            }),
          }),
          upsert: async (row: { key: string; value: { searchAfter: unknown[] | null } }) => {
            cursorValue = row.value.searchAfter;
            savedCursors.push(cursorValue);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table in test fixture: ${table}`);
    },
  };

  return {
    client,
    savedCursors,
    setQuotesError: (err: FakeError) => {
      quotesQueryError = err;
    },
    get cursorValue() {
      return cursorValue;
    },
  };
}

let supabaseMock = makeSupabaseMock();

// ─── GHL fixtures ───────────────────────────────────────────────────────────

function makeContact(overrides: Partial<HighLevelContact> = {}): HighLevelContact {
  return {
    id: 'contact-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    phone: '+15551234567',
    tags: [],
    customFields: [],
    ...overrides,
  };
}

/** A "Do Not Call" stage id distinct from any hardcoded constant, so a test
 *  can't accidentally pass by conflating it with NEIGHBORS_DECLINED_STAGE_ID.
 *  Do Not Call is resolved by NAME in production (no verified id exists for
 *  it), so fixtures below carry NEIGHBORS_DO_NOT_CALL_STAGE_NAME as the
 *  stage's `name`, never a caller-supplied id. */
const LIVE_DO_NOT_CALL_STAGE_ID = 'live-do-not-call-stage-id';

/** The full set of Neighbors suppression stages as "present live": the
 *  happy-path default so tests that don't care about the fail-loud check
 *  don't accidentally trip it. "Declined for 2026" is matched by id
 *  (NEIGHBORS_DECLINED_STAGE_ID); "Do Not Call" is matched by NAME, so its
 *  fixture stage carries NEIGHBORS_DO_NOT_CALL_STAGE_NAME as `name` with an
 *  id only a live listing would actually reveal (LIVE_DO_NOT_CALL_STAGE_ID). */
function livePipelinesJson(
  stages: { id: string; name: string }[] = [
    { id: NEIGHBORS_DECLINED_STAGE_ID, name: 'Declined for 2026' },
    { id: LIVE_DO_NOT_CALL_STAGE_ID, name: NEIGHBORS_DO_NOT_CALL_STAGE_NAME },
  ],
) {
  return {
    pipelines: [{ id: NEIGHBORS_PIPELINE_ID, name: 'Yule Love Lights Neighbors', stages }],
  };
}

/** The suppressed-stage-ids list runReferralSweep computes internally once
 *  both suppression stages resolve, matching the happy-path fixture above.
 *  isSuppressedByOpportunities is now a pure function of its second
 *  argument (the module no longer holds a static suppressed-ids list), so
 *  tests calling it directly pass this. */
const TEST_SUPPRESSED_STAGE_IDS = [NEIGHBORS_DECLINED_STAGE_ID, LIVE_DO_NOT_CALL_STAGE_ID];

function opportunity(pipelineStageId: string, overrides: Partial<HighLevelOpportunity> = {}): HighLevelOpportunity {
  return { id: 'opp-1', contactId: 'contact-1', pipelineId: NEIGHBORS_PIPELINE_ID, pipelineStageId, status: 'open', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  hlConfigured.value = true;
  supabaseMock = makeSupabaseMock();
  listPipelines.mockResolvedValue(livePipelinesJson());
  searchContactsPage.mockResolvedValue({ contacts: [], nextSearchAfter: undefined });
  findAllOpportunitiesForContact.mockResolvedValue([]);
  findOrCreateCustomer.mockResolvedValue({ id: 'cust-1' });
  getCustomerByHlContactId.mockResolvedValue(null);
  ensureReferralCode.mockResolvedValue('CODE1234');
  stampReferralLinkOnContact.mockResolvedValue(true);
  // Set by default so every test exercises the normal path; the one test
  // that cares about this being MISSING sets it explicitly to ''.
  process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK = 'field-1';
});

afterEach(() => {
  delete process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK;
});

const FAST = { pacingMs: 0 };

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('alreadyProcessed', () => {
  it('is false for a contact with neither sweep tag nor a stamped field', () => {
    expect(alreadyProcessed(makeContact(), 'field-1')).toBe(false);
  });
  it('is true when the contact already carries the neighbor tag', () => {
    expect(alreadyProcessed(makeContact({ tags: ['neighbor'] }), 'field-1')).toBe(true);
  });
  it('is true when the contact already carries the has-referral-link tag', () => {
    expect(alreadyProcessed(makeContact({ tags: ['has-referral-link'] }), 'field-1')).toBe(true);
  });
  it('is true when the referral-link custom field already has a non-empty value, even with no tag', () => {
    const contact = makeContact({ customFields: [{ id: 'field-1', value: 'https://quote.yulelovelights.com/refer/ABC' }] });
    expect(alreadyProcessed(contact, 'field-1')).toBe(true);
  });
  it('ignores an empty-string field value (not actually stamped)', () => {
    const contact = makeContact({ customFields: [{ id: 'field-1', value: '   ' }] });
    expect(alreadyProcessed(contact, 'field-1')).toBe(false);
  });
});

describe('isSuppressedByOpportunities', () => {
  it('is false with no opportunities', () => {
    expect(isSuppressedByOpportunities([], TEST_SUPPRESSED_STAGE_IDS)).toBe(false);
  });
  it('is true when an opportunity sits at a suppressed stage, regardless of its status field', () => {
    const opp = opportunity(TEST_SUPPRESSED_STAGE_IDS[0]!, { status: 'open' });
    expect(isSuppressedByOpportunities([opp], TEST_SUPPRESSED_STAGE_IDS)).toBe(true);
  });
  it('is false when every opportunity sits at a non-suppressed stage', () => {
    expect(isSuppressedByOpportunities([opportunity('some-other-stage')], TEST_SUPPRESSED_STAGE_IDS)).toBe(false);
  });
});

// ─── The sweep itself ───────────────────────────────────────────────────────

describe('runReferralSweep: fail-loud on a missing suppression stage', () => {
  it('refuses to run and touches NO contact when no live stage matches the Do Not Call name', async () => {
    // Only "Declined for 2026" present; nothing named NEIGHBORS_DO_NOT_CALL_STAGE_NAME.
    listPipelines.mockResolvedValue(
      livePipelinesJson([{ id: NEIGHBORS_DECLINED_STAGE_ID, name: 'Declined for 2026' }]),
    );
    searchContactsPage.mockResolvedValue({ contacts: [makeContact()], nextSearchAfter: undefined });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.ok).toBe(false);
    expect(summary.error).toBeTruthy();
    expect(summary.error).toContain(NEIGHBORS_DO_NOT_CALL_STAGE_NAME);
    expect(summary.resolvedDoNotCallStageId).toBeUndefined();
    expect(summary.scanned).toBe(0);
    expect(searchContactsPage).not.toHaveBeenCalled();
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it('refuses to run when the Neighbors pipeline itself is not found live', async () => {
    listPipelines.mockResolvedValue({ pipelines: [{ id: 'some-other-pipeline', name: 'Unrelated', stages: [] }] });
    const summary = await runReferralSweep({ ...FAST, dryRun: false });
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain(NEIGHBORS_DECLINED_STAGE_ID);
  });

  it('never matches a same-named "Do Not Call" stage sitting in a DIFFERENT pipeline: still refuses to run', async () => {
    listPipelines.mockResolvedValue({
      pipelines: [
        {
          id: NEIGHBORS_PIPELINE_ID,
          name: 'Yule Love Lights Neighbors',
          stages: [{ id: NEIGHBORS_DECLINED_STAGE_ID, name: 'Declined for 2026' }], // no DNC stage here
        },
        {
          id: 'some-other-pipeline-id',
          name: 'Some Other Pipeline',
          stages: [{ id: 'imposter-id', name: NEIGHBORS_DO_NOT_CALL_STAGE_NAME }], // right name, wrong pipeline
        },
      ],
    });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain(NEIGHBORS_DO_NOT_CALL_STAGE_NAME);
    expect(summary.resolvedDoNotCallStageId).toBeUndefined();
  });

  it('runs normally when both suppression stages are confirmed live, and logs the resolved Do Not Call id (the happy-path default)', async () => {
    searchContactsPage.mockResolvedValue({ contacts: [], nextSearchAfter: undefined });
    const summary = await runReferralSweep({ ...FAST, dryRun: false });
    expect(summary.ok).toBe(true);
    expect(summary.error).toBeUndefined();
    expect(summary.resolvedDoNotCallStageId).toBe(LIVE_DO_NOT_CALL_STAGE_ID);
  });

  it('matches a Do Not Call stage name that differs only by case/whitespace: still resolves and runs', async () => {
    listPipelines.mockResolvedValue(
      livePipelinesJson([
        { id: NEIGHBORS_DECLINED_STAGE_ID, name: 'Declined for 2026' },
        { id: LIVE_DO_NOT_CALL_STAGE_ID, name: '  do not call  ' }, // lowercased + padded
      ]),
    );
    searchContactsPage.mockResolvedValue({ contacts: [], nextSearchAfter: undefined });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.ok).toBe(true);
    expect(summary.error).toBeUndefined();
    expect(summary.resolvedDoNotCallStageId).toBe(LIVE_DO_NOT_CALL_STAGE_ID);
  });
});

describe('runReferralSweep: fail-loud on a missing referral-link field id (self-review addition)', () => {
  it('refuses to run, in BOTH modes, when HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK is unset', async () => {
    delete process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK;
    searchContactsPage.mockResolvedValue({ contacts: [makeContact()], nextSearchAfter: undefined });

    const live = await runReferralSweep({ ...FAST, dryRun: false });
    expect(live.ok).toBe(false);
    expect(live.error).toContain('HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK');
    expect(searchContactsPage).not.toHaveBeenCalled();

    const dry = await runReferralSweep({ ...FAST, dryRun: true });
    expect(dry.ok).toBe(false);
    expect(dry.error).toContain('HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK');
  });
});

describe('runReferralSweep: suppression skips a contact ENTIRELY', () => {
  it('"Declined for 2026" (hardcoded id): mints nothing, stamps nothing, tags nothing, creates no Supabase customer', async () => {
    const suppressed = makeContact({ id: 'contact-suppressed' });
    searchContactsPage.mockResolvedValue({ contacts: [suppressed], nextSearchAfter: undefined });
    findAllOpportunitiesForContact.mockImplementation(async (contactId: string, pipelineId: string) => {
      if (contactId === 'contact-suppressed' && pipelineId === NEIGHBORS_PIPELINE_ID) {
        return [opportunity(NEIGHBORS_DECLINED_STAGE_ID)]; // "Declined for 2026"
      }
      return [];
    });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.ok).toBe(true);
    expect(summary.scanned).toBe(1);
    expect(summary.suppressed).toBe(1);
    expect(summary.alreadyDone).toBe(0);
    expect(summary.minted).toBe(0);
    expect(summary.tagged).toBe(0);
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(ensureReferralCode).not.toHaveBeenCalled();
    expect(stampReferralLinkOnContact).not.toHaveBeenCalled();
    expect(addContactTags).not.toHaveBeenCalled();
  });

  it('"Do Not Call" (resolved by name at runtime) also skips entirely', async () => {
    const suppressed = makeContact({ id: 'contact-dnc' });
    searchContactsPage.mockResolvedValue({ contacts: [suppressed], nextSearchAfter: undefined });
    // LIVE_DO_NOT_CALL_STAGE_ID is the id the happy-path livePipelinesJson()
    // fixture resolves NEIGHBORS_DO_NOT_CALL_STAGE_NAME to. This is only
    // suppressed if the sweep actually resolved it by name and threaded it
    // through to the per-contact check, not a hardcoded constant.
    findAllOpportunitiesForContact.mockResolvedValue([opportunity(LIVE_DO_NOT_CALL_STAGE_ID)]);

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.suppressed).toBe(1);
    expect(addContactTags).not.toHaveBeenCalled();
  });
});

describe('runReferralSweep: idempotency', () => {
  it('skips a contact that already carries a sweep tag, with no GHL suppression call and no writes', async () => {
    const done = makeContact({ id: 'contact-done', tags: ['neighbor'] });
    searchContactsPage.mockResolvedValue({ contacts: [done], nextSearchAfter: undefined });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.scanned).toBe(1);
    expect(summary.alreadyDone).toBe(1);
    expect(summary.suppressed).toBe(0);
    // The whole point: no wasted suppression-check call on an already-done contact.
    expect(findAllOpportunitiesForContact).not.toHaveBeenCalled();
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(stampReferralLinkOnContact).not.toHaveBeenCalled();
  });

  it('skips a contact whose referral-link field is already stamped, even with no tag yet', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK = 'field-99';
    const done = makeContact({
      id: 'contact-field-done',
      customFields: [{ id: 'field-99', value: 'https://quote.yulelovelights.com/refer/XYZ' }],
    });
    searchContactsPage.mockResolvedValue({ contacts: [done], nextSearchAfter: undefined });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.alreadyDone).toBe(1);
    expect(stampReferralLinkOnContact).not.toHaveBeenCalled();
    delete process.env.HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK;
  });

  it('running twice on the same not-yet-done contact only writes once (second run sees the tag from the fixture and skips)', async () => {
    const contact = makeContact({ id: 'contact-repeat' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });

    const first = await runReferralSweep({ ...FAST, dryRun: false });
    expect(first.tagged).toBe(1);

    // Simulate the tag having landed on the contact for the next page read.
    contact.tags = ['has-referral-link'];
    vi.clearAllMocks();
    listPipelines.mockResolvedValue(livePipelinesJson());
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });

    const second = await runReferralSweep({ ...FAST, dryRun: false });
    expect(second.alreadyDone).toBe(1);
    expect(second.tagged).toBe(0);
    expect(addContactTags).not.toHaveBeenCalled();
  });
});

describe('runReferralSweep: tag selection', () => {
  it('tags "neighbor" when Supabase shows a real booked (non-test) quote for the resolved customer', async () => {
    const contact = makeContact({ id: 'contact-booked' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });
    findOrCreateCustomer.mockResolvedValue({ id: 'cust-booked' });
    supabaseMock = makeSupabaseMock({ bookedCustomerIds: new Set(['cust-booked']) });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.taggedNeighbor).toBe(1);
    expect(summary.taggedHasReferralLink).toBe(0);
    expect(addContactTags).toHaveBeenCalledWith('contact-booked', ['neighbor']);
  });

  it('tags "neighbor" from a GHL booked-or-later opportunity when Supabase shows nothing (deposit-paid stage)', async () => {
    const contact = makeContact({ id: 'contact-ghl-booked' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });
    findOrCreateCustomer.mockResolvedValue({ id: 'cust-not-in-supabase' });
    // Neighbors pipeline: not suppressed, but sitting at the Booked (depositPaid) stage.
    findAllOpportunitiesForContact.mockImplementation(async (_contactId: string, pipelineId: string) => {
      if (pipelineId === NEIGHBORS_PIPELINE_ID) return [opportunity('da6521b1-b945-4484-8251-6c6dc487c860')]; // Neighbors Booked
      return [];
    });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.taggedNeighbor).toBe(1);
    expect(addContactTags).toHaveBeenCalledWith('contact-ghl-booked', ['neighbor']);
  });

  it('tags "has-referral-link" (the conservative default) when no signal establishes a booking', async () => {
    const contact = makeContact({ id: 'contact-never-booked' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });
    findOrCreateCustomer.mockResolvedValue({ id: 'cust-never-booked' });
    // No booked quote in Supabase (default empty set), no opportunities anywhere.

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.taggedHasReferralLink).toBe(1);
    expect(summary.taggedNeighbor).toBe(0);
    expect(addContactTags).toHaveBeenCalledWith('contact-never-booked', ['has-referral-link']);
  });

  it('tags "has-referral-link" when the Supabase booked-quote read itself errors (fails toward the conservative default)', async () => {
    const contact = makeContact({ id: 'contact-db-error' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });
    findOrCreateCustomer.mockResolvedValue({ id: 'cust-db-error' });
    supabaseMock.setQuotesError({ message: 'boom' });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.taggedHasReferralLink).toBe(1);
  });

  it('applies exactly ONE tag per contact, never both', async () => {
    const contact = makeContact({ id: 'contact-one-tag' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });
    findOrCreateCustomer.mockResolvedValue({ id: 'cust-booked-2' });
    supabaseMock = makeSupabaseMock({ bookedCustomerIds: new Set(['cust-booked-2']) });

    await runReferralSweep({ ...FAST, dryRun: false });

    expect(addContactTags).toHaveBeenCalledTimes(1);
    expect(addContactTags).toHaveBeenCalledWith('contact-one-tag', ['neighbor']);
  });
});

describe('runReferralSweep: dry run writes NOTHING', () => {
  it('is the default (no dryRun option passed at all)', async () => {
    const contact = makeContact({ id: 'contact-default-dry' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });

    const summary = await runReferralSweep(FAST);

    expect(summary.dryRun).toBe(true);
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it('projects tag counts and sample contacts but calls none of the writing functions', async () => {
    const booked = makeContact({ id: 'contact-would-be-neighbor' });
    const notBooked = makeContact({ id: 'contact-would-be-referral-link' });
    searchContactsPage.mockResolvedValue({ contacts: [booked, notBooked], nextSearchAfter: undefined });
    getCustomerByHlContactId.mockImplementation(async (id: string) =>
      id === 'contact-would-be-neighbor' ? { id: 'cust-existing' } : null,
    );
    supabaseMock = makeSupabaseMock({ bookedCustomerIds: new Set(['cust-existing']) });

    const summary = await runReferralSweep({ ...FAST, dryRun: true });

    expect(summary.wouldTagNeighbor).toBe(1);
    expect(summary.wouldTagHasReferralLink).toBe(1);
    expect(summary.sampleContacts).toHaveLength(2);
    expect(summary.sampleContacts.map((c) => c.tag).sort()).toEqual(['has-referral-link', 'neighbor']);

    // The hard safety requirement: zero writes, anywhere.
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(ensureReferralCode).not.toHaveBeenCalled();
    expect(stampReferralLinkOnContact).not.toHaveBeenCalled();
    expect(addContactTags).not.toHaveBeenCalled();
    expect(supabaseMock.savedCursors).toHaveLength(0); // no cursor persisted either
  });

  it('never mints/stamps/tags even for a contact that WOULD be eligible and booked', async () => {
    const contact = makeContact({ id: 'contact-dry-booked' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });
    getCustomerByHlContactId.mockResolvedValue({ id: 'cust-dry' });
    supabaseMock = makeSupabaseMock({ bookedCustomerIds: new Set(['cust-dry']) });

    const summary = await runReferralSweep({ ...FAST, dryRun: true });

    expect(summary.wouldTagNeighbor).toBe(1);
    expect(ensureReferralCode).not.toHaveBeenCalled();
    expect(addContactTags).not.toHaveBeenCalled();
  });

  it('only an explicit dryRun:false writes anything: dryRun:true and dryRun:undefined both stay dry', async () => {
    const contact = makeContact({ id: 'contact-explicit-true' });
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });

    await runReferralSweep({ ...FAST, dryRun: true });
    expect(findOrCreateCustomer).not.toHaveBeenCalled();

    vi.clearAllMocks();
    listPipelines.mockResolvedValue(livePipelinesJson());
    searchContactsPage.mockResolvedValue({ contacts: [contact], nextSearchAfter: undefined });
    await runReferralSweep(FAST); // dryRun omitted entirely
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });
});

describe('runReferralSweep: mid-run failures report ok:false, not a contradictory ok:true+error', () => {
  it('a non-429 contact-listing failure mid-run sets ok:false alongside the error (self-review regression)', async () => {
    searchContactsPage.mockImplementationOnce(async () => {
      throw new Error('GHL is down');
    });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.error).toContain('GHL is down');
    expect(summary.ok).toBe(false);
  });

  it('a successful run with no errors still reports ok:true (the fix does not break the happy path)', async () => {
    searchContactsPage.mockResolvedValue({ contacts: [], nextSearchAfter: undefined });
    const summary = await runReferralSweep({ ...FAST, dryRun: false });
    expect(summary.ok).toBe(true);
    expect(summary.error).toBeUndefined();
  });
});

describe('runReferralSweep: 429 stops the run cleanly', () => {
  it('stops immediately on a 429 from a GHL call, without hammering further contacts', async () => {
    const a = makeContact({ id: 'contact-a' });
    const b = makeContact({ id: 'contact-b' });
    searchContactsPage.mockResolvedValue({ contacts: [a, b], nextSearchAfter: undefined });
    findAllOpportunitiesForContact.mockImplementationOnce(async () => {
      throw new HighLevelError('rate limited', 429);
    });

    const summary = await runReferralSweep({ ...FAST, dryRun: false });

    expect(summary.ok).toBe(true);
    expect(summary.stoppedOn429).toBe(true);
    expect(summary.scanned).toBe(1); // contact-b never reached
    expect(addContactTags).not.toHaveBeenCalled();
  });

  it('a 429 while listing contact pages also stops cleanly', async () => {
    searchContactsPage.mockImplementationOnce(async () => {
      throw new HighLevelError('rate limited', 429);
    });
    const summary = await runReferralSweep({ ...FAST, dryRun: false });
    expect(summary.stoppedOn429).toBe(true);
    expect(summary.scanned).toBe(0);
  });
});

describe('runReferralSweep: config guards', () => {
  it('returns a fatal error, untouched, when HighLevel is not configured', async () => {
    hlConfigured.value = false;
    const summary = await runReferralSweep({ ...FAST, dryRun: false });
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain('HighLevel');
    expect(listPipelines).not.toHaveBeenCalled();
  });

  it('returns a fatal error, untouched, when Supabase service role is not configured', async () => {
    supabaseMock = { client: null, savedCursors: [], setQuotesError: () => {}, cursorValue: null } as unknown as ReturnType<
      typeof makeSupabaseMock
    >;

    const summary = await runReferralSweep({ ...FAST, dryRun: false });
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain('Supabase');
  });
});
