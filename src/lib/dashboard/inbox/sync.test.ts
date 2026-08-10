// runGmailPoll concurrency: fetches thread bodies in bounded chunks (CHUNK_SIZE=8,
// mirroring backfillCustomersFromQuotes) instead of serializing 25 Gmail round
// trips. Every other collaborator is mocked — this file only exercises the
// chunking/error-isolation shape, not the (separately-tested) pure decisions.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getThreadMock = vi.fn();
const listInboxThreadsMock = vi.fn();
const getAccessTokenMock = vi.fn();
const isGmailConfiguredMock = vi.fn();

vi.mock('@/lib/integrations/gmail', () => ({
  getAccessToken: (...args: unknown[]) => getAccessTokenMock(...args),
  getOrCreateLabel: vi.fn(),
  getThread: (...args: unknown[]) => getThreadMock(...args),
  isGmailConfigured: (...args: unknown[]) => isGmailConfiguredMock(...args),
  listInboxThreads: (...args: unknown[]) => listInboxThreadsMock(...args),
  modifyThread: vi.fn(),
}));

const ingestTouchMock = vi.fn();
const closeFollowUpMock = vi.fn();
const ensureFollowUpMock = vi.fn();
const recordSyncRunMock = vi.fn();
const sweepOrphanedFollowUpsMock = vi.fn();

vi.mock('./store', () => ({
  closeFollowUp: (...args: unknown[]) => closeFollowUpMock(...args),
  // quotetool.ts (unmocked — its pure functions run for real in this file)
  // imports this flag from './store'; the strict vitest mock throws on any
  // accessed export the factory doesn't define.
  EXCLUDE_LEGACY_REBOOK_FROM_INBOX: true,
  ensureFollowUp: (...args: unknown[]) => ensureFollowUpMock(...args),
  getSyncCursor: vi.fn(),
  ingestTouch: (...args: unknown[]) => ingestTouchMock(...args),
  listEscalatableItems: vi.fn(),
  recordSyncRun: (...args: unknown[]) => recordSyncRunMock(...args),
  setEscalation: vi.fn(),
  setSyncCursor: vi.fn(),
  sweepOrphanedFollowUps: (...args: unknown[]) => sweepOrphanedFollowUpsMock(...args),
}));

const listQuotesForDashboardMock = vi.fn();
vi.mock('@/lib/dashboard/queries', () => ({
  listQuotesForDashboard: (...args: unknown[]) => listQuotesForDashboardMock(...args),
}));

const getFollowUpDaysMock = vi.fn();
vi.mock('./settings', () => ({
  getFollowUpDays: (...args: unknown[]) => getFollowUpDaysMock(...args),
}));

vi.mock('./suppression', () => ({
  getSuppressedSenders: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock('./gmail', () => ({
  mapGmailThread: (raw: unknown) => raw,
  normalizeGmailThread: (mapped: unknown) => mapped,
}));

const addContactTagsMock = vi.fn();
const findOrCreateOpportunityForContactMock = vi.fn();
const isHighLevelConfiguredMock = vi.fn();
const markConversationReadMock = vi.fn();

vi.mock('@/lib/integrations/highlevel', () => ({
  addContactTags: (...args: unknown[]) => addContactTagsMock(...args),
  // Not imported by sync.ts anymore (WT-49) — kept mocked so a regression that
  // re-adds the import/call is caught by "not have been called" assertions
  // below rather than a mock-not-found crash.
  findOrCreateOpportunityForContact: (...args: unknown[]) => findOrCreateOpportunityForContactMock(...args),
  isHighLevelConfigured: (...args: unknown[]) => isHighLevelConfiguredMock(...args),
  markConversationRead: (...args: unknown[]) => markConversationReadMock(...args),
  searchConversations: vi.fn(),
  sendEmail: vi.fn(),
}));

import { runGmailPoll, runHandledWriteback, runQuoteToolReconcile } from './sync';
import type { HandledTarget } from './store';

function threadRefs(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `t${i}` }));
}

const OK_RESULT = {
  ok: true as const,
  skipped: false,
  itemId: 'item-1',
  contactId: 'contact-1',
  autoResolved: false,
  reopened: false,
  ambiguous: false,
};

describe('runGmailPoll concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGmailConfiguredMock.mockReturnValue(true);
    getAccessTokenMock.mockResolvedValue('token');
    ingestTouchMock.mockResolvedValue(OK_RESULT);
  });

  it('fetches thread bodies with bounded (<=8) concurrency, not serially', async () => {
    const THREAD_COUNT = 20;
    listInboxThreadsMock.mockResolvedValue(threadRefs(THREAD_COUNT));

    let inFlight = 0;
    let maxInFlight = 0;
    getThreadMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { messages: [{ id: 'm1' }] };
    });

    const summary = await runGmailPoll(new Date(), { maxResults: THREAD_COUNT });

    expect(getThreadMock).toHaveBeenCalledTimes(THREAD_COUNT);
    expect(summary.scanned).toBe(THREAD_COUNT);
    expect(summary.ingested).toBe(THREAD_COUNT);
    expect(summary.errors).toBe(0);
    // Bounded: never more than one chunk (8) in flight at once.
    expect(maxInFlight).toBeLessThanOrEqual(8);
    // Actually concurrent: more than one in flight at a time (proves it isn't
    // still serialized one-at-a-time).
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('isolates one bad thread (getThread throw) without failing the rest of the batch', async () => {
    const THREAD_COUNT = 10;
    listInboxThreadsMock.mockResolvedValue(threadRefs(THREAD_COUNT));
    getThreadMock.mockImplementation(async (_token: string, id: string) => {
      if (id === 't3') throw new Error('gmail 500');
      return { messages: [{ id: 'm1' }] };
    });

    const summary = await runGmailPoll(new Date(), { maxResults: THREAD_COUNT });

    expect(summary.ok).toBe(true);
    expect(summary.errors).toBe(1);
    expect(summary.ingested).toBe(THREAD_COUNT - 1);
  });

  it('isolates one bad thread (ingestTouch failure) without failing the rest of the batch', async () => {
    const THREAD_COUNT = 10;
    listInboxThreadsMock.mockResolvedValue(threadRefs(THREAD_COUNT));
    // Carry the thread id through the (pass-through-mocked) map/normalize steps
    // so ingestTouch can tell which thread it was called for.
    getThreadMock.mockImplementation(async (_token: string, id: string) => ({
      messages: [{ id: 'm1' }],
      id,
    }));
    ingestTouchMock.mockImplementation(async (touch: { id?: string }) => {
      if (touch.id === 't3') return { ok: false, error: 'boom' };
      return OK_RESULT;
    });

    const summary = await runGmailPoll(new Date(), { maxResults: THREAD_COUNT });

    expect(summary.ok).toBe(true);
    expect(summary.errors).toBe(1);
    expect(summary.ingested).toBe(THREAD_COUNT - 1);
  });
});

// WT-49: Mark-Handled must never create a GHL pipeline opportunity. It used to
// findOrCreateOpportunityForContact against the legacy holiday-only
// HIGHLEVEL_PIPELINE_ID/HIGHLEVEL_STAGE_QUOTE_CREATED env vars — since
// HandledTarget carries no service_type, a permanent/event/bistro contact
// marked Handled got a duplicate card CREATED in the holiday pipeline.
describe('runHandledWriteback — WT-49 (no opportunity write)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ghlTarget: HandledTarget = {
    source: 'ghl',
    externalId: 'conv-1',
    sourceMessageId: 'msg-1',
    ghlContactId: 'contact-1',
    displayName: 'Jane Doe',
  };

  it('never calls findOrCreateOpportunityForContact, even with the legacy pipeline env vars set', async () => {
    const savedPipelineId = process.env.HIGHLEVEL_PIPELINE_ID;
    const savedStageId = process.env.HIGHLEVEL_STAGE_QUOTE_CREATED;
    process.env.HIGHLEVEL_PIPELINE_ID = 'legacy-pipeline';
    process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = 'legacy-stage';
    try {
      isHighLevelConfiguredMock.mockReturnValue(true);
      addContactTagsMock.mockResolvedValue(undefined);
      markConversationReadMock.mockResolvedValue(undefined);

      const sync = await runHandledWriteback(ghlTarget, 'jason');

      expect(findOrCreateOpportunityForContactMock).not.toHaveBeenCalled();
      expect(sync.ghlOpportunity).toBeUndefined();
      expect(sync.ghlOpportunityError).toBeUndefined();
    } finally {
      if (savedPipelineId === undefined) delete process.env.HIGHLEVEL_PIPELINE_ID;
      else process.env.HIGHLEVEL_PIPELINE_ID = savedPipelineId;
      if (savedStageId === undefined) delete process.env.HIGHLEVEL_STAGE_QUOTE_CREATED;
      else process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = savedStageId;
    }
  });

  it('still marks the conversation read and tags the contact (the rest of the write-back stays intact)', async () => {
    isHighLevelConfiguredMock.mockReturnValue(true);
    addContactTagsMock.mockResolvedValue(undefined);
    markConversationReadMock.mockResolvedValue(undefined);

    const sync = await runHandledWriteback(ghlTarget, 'jason');

    expect(markConversationReadMock).toHaveBeenCalledWith('conv-1', 'msg-1');
    expect(sync.ghlMarkRead).toBe('ok');
    expect(addContactTagsMock).toHaveBeenCalledWith('contact-1', ['dashboard-handled', expect.any(String)]);
    expect(sync.ghlTags).toBe('ok');
    expect(findOrCreateOpportunityForContactMock).not.toHaveBeenCalled();
  });
});

// #183 BUG 3: runQuoteToolReconcile's main loop only ever visits quotes still
// returned by listQuotesForDashboard, so a follow-up anchored to a DELETED
// quote can never be closed there. Verifies the wiring (not just the pure
// decision, already covered in store.test.ts): the sweep is actually called
// once per reconcile and its count folds into followUpsClosed.
describe('runQuoteToolReconcile — orphan follow-up sweep wiring (#183 BUG 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureFollowUpMock.mockResolvedValue(undefined);
    recordSyncRunMock.mockResolvedValue(undefined);
    getFollowUpDaysMock.mockResolvedValue(3);
    listQuotesForDashboardMock.mockResolvedValue([]);
  });

  it('calls sweepOrphanedFollowUps once with the quote_sent_no_reply reason and adds its count into followUpsClosed', async () => {
    sweepOrphanedFollowUpsMock.mockResolvedValue(2);

    const summary = await runQuoteToolReconcile(new Date());

    expect(summary.ok).toBe(true);
    expect(sweepOrphanedFollowUpsMock).toHaveBeenCalledTimes(1);
    expect(sweepOrphanedFollowUpsMock).toHaveBeenCalledWith('quote_sent_no_reply');
    expect(summary.followUpsClosed).toBe(2);
  });

  it('adds to (not replaces) follow-ups closed by the main per-quote loop', async () => {
    listQuotesForDashboardMock.mockResolvedValue([
      {
        id: 'q1',
        customer_name: 'Jane Doe',
        customer_email: 'jane@example.com',
        customer_phone: null,
        total: 1000,
        created_at: '2026-06-01T00:00:00Z',
        quote_sent_at: '2026-06-02T00:00:00Z',
        customer_approved_at: '2026-06-03T00:00:00Z', // approved -> main loop closes this one
        deposit_paid_at: null,
        homeworks_sent_at: null,
        homeworks_signed_at: null,
        highlevel_contact_id: null,
        service_type: null,
      },
    ]);
    ingestTouchMock.mockResolvedValue({
      ok: true,
      skipped: false,
      itemId: 'item-1',
      contactId: 'contact-1',
      autoResolved: true,
      reopened: false,
      ambiguous: false,
    });
    closeFollowUpMock.mockResolvedValue(1); // the main loop's own close
    sweepOrphanedFollowUpsMock.mockResolvedValue(3); // the sweep's separate closes

    const summary = await runQuoteToolReconcile(new Date());

    expect(summary.followUpsClosed).toBe(1 + 3);
  });

  it('counts and logs a suppressed internal-domain quote instead of creating its follow-up (#220)', async () => {
    listQuotesForDashboardMock.mockResolvedValue([
      {
        id: 'q1262',
        customer_name: 'Yule Love Lights',
        customer_email: 'sales@mail.yulelovelights.com',
        customer_phone: null,
        total: 348,
        created_at: '2026-08-06T10:00:00Z',
        quote_sent_at: '2026-08-06T11:00:00Z',
        customer_approved_at: null,
        deposit_paid_at: null,
        homeworks_sent_at: null,
        homeworks_signed_at: null,
        highlevel_contact_id: null,
        service_type: null,
        quote_number: 1262,
      },
    ]);
    ingestTouchMock.mockResolvedValue(OK_RESULT);
    sweepOrphanedFollowUpsMock.mockResolvedValue(0);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const summary = await runQuoteToolReconcile(new Date('2026-08-07T12:00:00Z'));

      expect(summary.followUpsCreated).toBe(0);
      expect(summary.followUpsSuppressed).toBe(1);
      expect(ensureFollowUpMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[inbox] quotetool follow-up suppressed for internal recipient:',
        expect.objectContaining({
          quoteId: 'q1262',
          quoteNumber: 1262,
          customerEmail: 'sales@mail.yulelovelights.com',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
