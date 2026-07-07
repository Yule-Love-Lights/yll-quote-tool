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

vi.mock('@/lib/integrations/highlevel', () => ({
  addContactTags: vi.fn(),
  findOrCreateOpportunityForContact: vi.fn(),
  isHighLevelConfigured: vi.fn(),
  markConversationRead: vi.fn(),
  searchConversations: vi.fn(),
  sendEmail: vi.fn(),
}));

import { runGmailPoll } from './sync';

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
