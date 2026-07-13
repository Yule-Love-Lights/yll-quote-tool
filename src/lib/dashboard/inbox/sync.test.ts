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

vi.mock('./store', () => ({
  closeFollowUp: vi.fn(),
  ensureFollowUp: vi.fn(),
  getSyncCursor: vi.fn(),
  ingestTouch: (...args: unknown[]) => ingestTouchMock(...args),
  listEscalatableItems: vi.fn(),
  recordSyncRun: vi.fn().mockResolvedValue(undefined),
  setEscalation: vi.fn(),
  setSyncCursor: vi.fn(),
}));

vi.mock('./suppression', () => ({
  getSuppressedSenders: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock('./gmail', () => ({
  mapGmailThread: (raw: unknown) => raw,
  normalizeGmailThread: (mapped: unknown) => mapped,
}));

const addContactTagsMock = vi.fn();
const markConversationReadMock = vi.fn();
const isHighLevelConfiguredMock = vi.fn();
const findOrCreateOpportunityForContactMock = vi.fn();

vi.mock('@/lib/integrations/highlevel', () => ({
  addContactTags: (...args: unknown[]) => addContactTagsMock(...args),
  findOrCreateOpportunityForContact: (...args: unknown[]) => findOrCreateOpportunityForContactMock(...args),
  isHighLevelConfigured: (...args: unknown[]) => isHighLevelConfiguredMock(...args),
  markConversationRead: (...args: unknown[]) => markConversationReadMock(...args),
  searchConversations: vi.fn(),
  sendEmail: vi.fn(),
}));

import { runGmailPoll, runHandledWriteback } from './sync';
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

// WA-A6: the Handled write-back used to "ensure a pipeline opportunity" via the
// legacy holiday-only HIGHLEVEL_PIPELINE_ID/STAGE_QUOTE_CREATED env vars,
// regardless of the contact's actual vertical — filing permanent/event contacts
// into the Christmas Lights pipeline (and risking a holiday drip firing at a
// non-holiday customer). That step was dropped entirely (HandledTarget carries
// no service_type to resolve the right pipeline with). These tests lock in that
// no opportunity is ever created/found from the Handled route, holiday-shaped
// env vars or not.
describe('runHandledWriteback (WA-A6)', () => {
  const baseTarget: HandledTarget = {
    source: 'ghl',
    externalId: 'conv-1',
    sourceMessageId: 'msg-1',
    ghlContactId: 'contact-1',
    displayName: 'Jane Permanent-Lead',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    isHighLevelConfiguredMock.mockReturnValue(true);
    markConversationReadMock.mockResolvedValue(undefined);
    addContactTagsMock.mockResolvedValue(undefined);
  });

  it('never creates/finds a GHL opportunity, even with the legacy holiday pipeline env vars set', async () => {
    process.env.HIGHLEVEL_PIPELINE_ID = 'holiday-pipeline-id';
    process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = 'holiday-stage-id';
    try {
      const sync = await runHandledWriteback(baseTarget, 'Jason');

      expect(findOrCreateOpportunityForContactMock).not.toHaveBeenCalled();
      expect(sync.ghlOpportunity).toBeUndefined();
      // The real "handled" side-effects still fire.
      expect(markConversationReadMock).toHaveBeenCalledWith('conv-1', 'msg-1');
      expect(addContactTagsMock).toHaveBeenCalledWith('contact-1', expect.arrayContaining(['dashboard-handled']));
    } finally {
      delete process.env.HIGHLEVEL_PIPELINE_ID;
      delete process.env.HIGHLEVEL_STAGE_QUOTE_CREATED;
    }
  });

  it('never creates/finds a GHL opportunity for a non-holiday (e.g. permanent) contact with no pipeline env vars set', async () => {
    delete process.env.HIGHLEVEL_PIPELINE_ID;
    delete process.env.HIGHLEVEL_STAGE_QUOTE_CREATED;

    const sync = await runHandledWriteback(baseTarget, 'Jason');

    expect(findOrCreateOpportunityForContactMock).not.toHaveBeenCalled();
    expect(sync.ghlOpportunity).toBeUndefined();
  });
});
