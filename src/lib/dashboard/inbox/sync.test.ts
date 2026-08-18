// runGmailPoll concurrency: fetches thread bodies in bounded chunks (CHUNK_SIZE=8,
// mirroring backfillCustomersFromQuotes) instead of serializing 25 Gmail round
// trips. Every other collaborator is mocked — this file only exercises the
// chunking/error-isolation shape, not the (separately-tested) pure decisions.

import { describe, it, expect, vi, beforeEach } from 'vitest';
// #263: real (unmocked) implementation — quotetool.ts now imports
// isHiddenLegacyRebookQuote from './store' alongside EXCLUDE_LEGACY_REBOOK_FROM_INBOX;
// the strict mock below must supply it so quotetool.ts's real suppression
// logic keeps running for real (this file's existing intent), not throw on
// an export the factory doesn't define.
import { isParkedLegacyRebookDraft } from '@/lib/quoteStatus';

const getThreadMock = vi.fn();
const listInboxThreadsMock = vi.fn();
const getAccessTokenMock = vi.fn();
const isGmailConfiguredMock = vi.fn();
const modifyThreadMock = vi.fn();
const modifyMessageMock = vi.fn();

vi.mock('@/lib/integrations/gmail', () => ({
  getAccessToken: (...args: unknown[]) => getAccessTokenMock(...args),
  getOrCreateLabel: vi.fn(),
  getThread: (...args: unknown[]) => getThreadMock(...args),
  isGmailConfigured: (...args: unknown[]) => isGmailConfiguredMock(...args),
  listInboxThreads: (...args: unknown[]) => listInboxThreadsMock(...args),
  modifyThread: (...args: unknown[]) => modifyThreadMock(...args),
  modifyMessage: (...args: unknown[]) => modifyMessageMock(...args),
}));

const ingestTouchMock = vi.fn();
const closeFollowUpMock = vi.fn();
const ensureFollowUpMock = vi.fn();
const recordSyncRunMock = vi.fn();
const recordSuppressedFollowUpMock = vi.fn();
const sweepOrphanedFollowUpsMock = vi.fn();
const sweepResolvedItemFollowUpsMock = vi.fn();

vi.mock('./store', () => ({
  closeFollowUp: (...args: unknown[]) => closeFollowUpMock(...args),
  // quotetool.ts (unmocked — its pure functions run for real in this file)
  // imports this flag from './store'; the strict vitest mock throws on any
  // accessed export the factory doesn't define.
  EXCLUDE_LEGACY_REBOOK_FROM_INBOX: true,
  ensureFollowUp: (...args: unknown[]) => ensureFollowUpMock(...args),
  getSyncCursor: vi.fn(),
  ingestTouch: (...args: unknown[]) => ingestTouchMock(...args),
  // #263: real store.ts re-exports this as isParkedLegacyRebookDraft
  // (@/lib/quoteStatus) — delegate to the real, unmocked predicate so
  // quotetool.ts's suppression logic still runs for real here.
  isHiddenLegacyRebookQuote: isParkedLegacyRebookDraft,
  listEscalatableItems: vi.fn(),
  recordSuppressedFollowUp: (...args: unknown[]) => recordSuppressedFollowUpMock(...args),
  recordSyncRun: (...args: unknown[]) => recordSyncRunMock(...args),
  setEscalation: vi.fn(),
  setSyncCursor: vi.fn(),
  sweepOrphanedFollowUps: (...args: unknown[]) => sweepOrphanedFollowUpsMock(...args),
  sweepResolvedItemFollowUps: (...args: unknown[]) => sweepResolvedItemFollowUpsMock(...args),
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

const normalizeGmailThreadTouchesMock = vi.fn();
vi.mock('./gmail', () => ({
  mapGmailThread: (raw: unknown) => raw,
  normalizeGmailThreadTouches: (...args: unknown[]) => normalizeGmailThreadTouchesMock(...args),
}));

const addContactTagsMock = vi.fn();
const findOrCreateOpportunityForContactMock = vi.fn();
const isHighLevelConfiguredMock = vi.fn();
const markConversationReadMock = vi.fn();
const searchConversationsMock = vi.fn();

vi.mock('@/lib/integrations/highlevel', () => ({
  addContactTags: (...args: unknown[]) => addContactTagsMock(...args),
  // Not imported by sync.ts anymore (WT-49) — kept mocked so a regression that
  // re-adds the import/call is caught by "not have been called" assertions
  // below rather than a mock-not-found crash.
  findOrCreateOpportunityForContact: (...args: unknown[]) => findOrCreateOpportunityForContactMock(...args),
  isHighLevelConfigured: (...args: unknown[]) => isHighLevelConfiguredMock(...args),
  markConversationRead: (...args: unknown[]) => markConversationReadMock(...args),
  searchConversations: (...args: unknown[]) => searchConversationsMock(...args),
  sendEmail: vi.fn(),
}));

// normalizeGhlConversation ('./ghl') is deliberately NOT mocked below — the
// #252 activity-noise counter test exercises the real adapter so it proves
// the isActivityNoise flag actually flows from ghl.ts into sync.ts's summary.
import { runGhlReconcile, runGmailPoll, runHandledWriteback, runQuoteToolReconcile } from './sync';
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
    // Default: pass-through-wrapped-in-an-array, mirroring normalizeGmailThread's
    // old 1-touch-per-thread shape so the pre-existing tests below (written
    // against the singular function) still hold under the plural one (#288).
    normalizeGmailThreadTouchesMock.mockImplementation((mapped: unknown) => [mapped]);
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

  // #288: normalizeGmailThreadTouches can return MORE THAN ONE touch for a
  // single coalesced GML thread (one per distinct customer). `scanned` stays
  // thread-count, but ingestTouch must run — and be counted — once per touch,
  // not once per thread.
  it('ingests and counts every touch a single thread splits into, while `scanned` stays the thread count (#288)', async () => {
    listInboxThreadsMock.mockResolvedValue(threadRefs(1));
    getThreadMock.mockResolvedValue({ messages: [{ id: 'm1' }] });
    normalizeGmailThreadTouchesMock.mockReturnValue([{ id: 'touch-a' }, { id: 'touch-b' }, { id: 'touch-c' }]);

    const summary = await runGmailPoll(new Date(), { maxResults: 1 });

    expect(summary.ok).toBe(true);
    expect(summary.scanned).toBe(1);
    expect(ingestTouchMock).toHaveBeenCalledTimes(3);
    expect(summary.ingested).toBe(3);
  });

  it('one bad touch (ingestTouch failure) does not stop sibling touches from the SAME split thread from being ingested (#288)', async () => {
    listInboxThreadsMock.mockResolvedValue(threadRefs(1));
    getThreadMock.mockResolvedValue({ messages: [{ id: 'm1' }] });
    normalizeGmailThreadTouchesMock.mockReturnValue([{ id: 'touch-a' }, { id: 'touch-b' }, { id: 'touch-c' }]);
    ingestTouchMock.mockImplementation(async (touch: { id?: string }) => {
      if (touch.id === 'touch-b') return { ok: false, error: 'boom' };
      return OK_RESULT;
    });

    const summary = await runGmailPoll(new Date(), { maxResults: 1 });

    expect(summary.ok).toBe(true);
    expect(summary.errors).toBe(1);
    expect(summary.ingested).toBe(2);
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

// #288: a GML-split gmail item's external_id can be `${threadId}:${msgId}`
// (gmail.ts's normalizeGmailThreadTouches) for every customer after the
// thread's earliest.
//
// #288 fix round (staff HIGH): modifyThread is THREAD-wide — Gmail's
// threads.modify labels/marks-read EVERY message on the thread, so marking
// one split row Handled would silently stamp sibling customers' still-
// unworked forwards read/labeled too (a staffer triaging raw Gmail — the
// tool's own "Reply in Gmail" affordance sends them there — would see an
// already-handled thread and skip it, reintroducing the buried-lead failure
// one layer up). The write-back now goes MESSAGE-level (modifyMessage)
// whenever the row knows its own message id, and only falls back to the
// thread-wide modifyThread for a genuinely bare, non-composite external_id
// (a legacy/non-split/non-GML row). modifyThread's URL wants the bare Gmail
// THREAD id in that fallback — a composite external_id passed straight
// through would target a nonexistent thread, hence
// gmailThreadIdFromExternalId's strip (kept as a defensive no-op: today's
// code never actually reaches it with a composite value — test (iv) below
// proves the composite+null case skips instead of reaching modifyThread).
//
// #288 backfill fix round (staff HIGH, 2nd instance): every real LIVE-FETCH
// split touch (hybrid or 2+, gmail.ts's normalizeGmailThreadTouches) carries
// a sourceMessageId — but scripts/backfill-gml-threads.ts's STORED-RAW mode
// mints composite external_ids (`${threadId}:bf-<epochMs>`) for backfilled
// rows that predate #787's per-message ids, so sourceMessageId is null on
// THOSE rows. Falling through to the thread-wide modifyThread for a
// composite id (as this code used to) re-opens the exact bug above for the
// backfilled population: marking one buried customer Handled would silently
// mark every sibling customer's still-unworked forward read/labeled too. Fix:
// a composite external_id with no sourceMessageId now SKIPS the Gmail
// write-back entirely — no signal beats a wrong signal, and the write-back is
// best-effort by design (the local handled_at stamp already landed before
// this runs). See test (iv) below.
describe('runHandledWriteback — Gmail write-back targeting (#288 GML split + fix round message-level HIGH)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGmailConfiguredMock.mockReturnValue(true);
    getAccessTokenMock.mockResolvedValue('token');
    modifyThreadMock.mockResolvedValue(undefined);
    modifyMessageMock.mockResolvedValue(undefined);
  });

  it('(i) a target with sourceMessageId goes MESSAGE-level: modifyMessage is called with the bare message id, modifyThread is never called', async () => {
    const target: HandledTarget = {
      source: 'gmail',
      externalId: 'thr-abc123:msg-def456',
      sourceMessageId: 'msg-def456',
      ghlContactId: null,
      displayName: 'Later Customer',
    };

    const sync = await runHandledWriteback(target, 'jason');

    expect(modifyMessageMock).toHaveBeenCalledTimes(1);
    expect(modifyMessageMock).toHaveBeenCalledWith('token', 'msg-def456', expect.objectContaining({ removeLabelIds: ['UNREAD'] }));
    expect(modifyThreadMock).not.toHaveBeenCalled();
    expect(sync.gmailLabel).toBe('ok');
  });

  it('(ii) a target with NO sourceMessageId (legacy / non-split row) falls back to THREAD-level modifyThread on the (already-bare) id — existing behavior pinned', async () => {
    const target: HandledTarget = {
      source: 'gmail',
      externalId: 'thr-abc123',
      sourceMessageId: null,
      ghlContactId: null,
      displayName: 'Legacy Row',
    };

    const sync = await runHandledWriteback(target, 'jason');

    expect(modifyThreadMock).toHaveBeenCalledTimes(1);
    expect(modifyThreadMock).toHaveBeenCalledWith('token', 'thr-abc123', expect.objectContaining({ removeLabelIds: ['UNREAD'] }));
    expect(modifyMessageMock).not.toHaveBeenCalled();
    expect(sync.gmailLabel).toBe('ok');
  });

  it('(iv) a composite external_id with NO sourceMessageId (a STORED-RAW backfilled row — scripts/backfill-gml-threads.ts mints `${threadId}:bf-<epochMs>` for these, since stored raw predates #787\'s per-message ids) skips the Gmail write-back entirely: neither modifyMessage nor modifyThread is called, and the outcome is recorded as skipped', async () => {
    const target: HandledTarget = {
      source: 'gmail',
      externalId: 'thr-abc123:bf-1755500000000',
      sourceMessageId: null,
      ghlContactId: null,
      displayName: 'Backfilled Row',
    };

    const sync = await runHandledWriteback(target, 'jason');

    expect(modifyMessageMock).not.toHaveBeenCalled();
    expect(modifyThreadMock).not.toHaveBeenCalled();
    expect(sync.gmailLabel).toBe('skipped');
  });

  it('(iii) two rows from the same coalesced thread each get their OWN independent message-level write-back — no cross-talk, no error propagation', async () => {
    const aliceTarget: HandledTarget = {
      source: 'gmail',
      externalId: 'thr-gml',
      sourceMessageId: 'm1',
      ghlContactId: null,
      displayName: 'Alice Anderson',
    };
    const bobTarget: HandledTarget = {
      source: 'gmail',
      externalId: 'thr-gml:m2',
      sourceMessageId: 'm2',
      ghlContactId: null,
      displayName: 'Bob Baker',
    };

    const aliceSync = await runHandledWriteback(aliceTarget, 'jason');
    const bobSync = await runHandledWriteback(bobTarget, 'jason');

    expect(modifyMessageMock).toHaveBeenCalledTimes(2);
    expect(modifyMessageMock).toHaveBeenNthCalledWith(1, 'token', 'm1', expect.anything());
    expect(modifyMessageMock).toHaveBeenNthCalledWith(2, 'token', 'm2', expect.anything());
    expect(modifyThreadMock).not.toHaveBeenCalled();
    expect(aliceSync.gmailLabel).toBe('ok');
    expect(bobSync.gmailLabel).toBe('ok');
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
    recordSuppressedFollowUpMock.mockResolvedValue(undefined);
    getFollowUpDaysMock.mockResolvedValue(3);
    listQuotesForDashboardMock.mockResolvedValue([]);
    sweepResolvedItemFollowUpsMock.mockResolvedValue(0);
  });

  it('calls sweepOrphanedFollowUps once with the quote_sent_no_reply reason and adds its count into followUpsClosed', async () => {
    sweepOrphanedFollowUpsMock.mockResolvedValue(2);

    const summary = await runQuoteToolReconcile(new Date());

    expect(summary.ok).toBe(true);
    expect(sweepOrphanedFollowUpsMock).toHaveBeenCalledTimes(1);
    expect(sweepOrphanedFollowUpsMock).toHaveBeenCalledWith('quote_sent_no_reply');
    expect(summary.followUpsClosed).toBe(2);
  });

  // #252 follow-up-autoclose backlog sweep: a pending follow-up whose anchored
  // item was ALREADY completed/dismissed before the write-site fix existed.
  // Verifies the wiring — the pure decision is covered in store.test.ts.
  it('calls sweepResolvedItemFollowUps once and adds its count into followUpsClosed', async () => {
    sweepOrphanedFollowUpsMock.mockResolvedValue(0);
    sweepResolvedItemFollowUpsMock.mockResolvedValue(3);

    const summary = await runQuoteToolReconcile(new Date());

    expect(summary.ok).toBe(true);
    expect(sweepResolvedItemFollowUpsMock).toHaveBeenCalledTimes(1);
    expect(summary.followUpsClosed).toBe(3);
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
    closeFollowUpMock.mockResolvedValue(0);
    sweepOrphanedFollowUpsMock.mockResolvedValue(0);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const summary = await runQuoteToolReconcile(new Date('2026-08-07T12:00:00Z'));

      expect(summary.followUpsCreated).toBe(0);
      expect(summary.followUpsSuppressed).toBe(1);
      expect(summary.followUpsClosed).toBe(0);
      expect(ensureFollowUpMock).not.toHaveBeenCalled();
      expect(closeFollowUpMock).toHaveBeenCalledWith('item-1', 'quote_sent_no_reply');
      expect(warnSpy).toHaveBeenCalledWith(
        '[inbox] quotetool follow-up suppressed for internal recipient:',
        expect.objectContaining({
          quoteId: 'q1262',
          quoteNumber: 1262,
          customerEmail: 'sales@mail.yulelovelights.com',
        }),
      );
      // #230(a): the same event also lands in dashboard_activity (visible on
      // /inbox/activity), not just a Vercel console.warn nobody opens.
      expect(recordSuppressedFollowUpMock).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({ quoteId: 'q1262', quoteNumber: 1262 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('closes an already-pending internal-recipient follow-up without double-counting it as closed (#220 live quote 1262)', async () => {
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
    closeFollowUpMock.mockResolvedValue(1);
    sweepOrphanedFollowUpsMock.mockResolvedValue(0);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const summary = await runQuoteToolReconcile(new Date('2026-08-10T12:00:00Z'));

      expect(summary.followUpsCreated).toBe(0);
      expect(summary.followUpsSuppressed).toBe(1);
      expect(summary.followUpsClosed).toBe(0);
      expect(ensureFollowUpMock).not.toHaveBeenCalled();
      expect(closeFollowUpMock).toHaveBeenCalledTimes(1);
      expect(closeFollowUpMock).toHaveBeenCalledWith('item-1', 'quote_sent_no_reply');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays idempotent on a second suppress pass for the same internal quote (#220)', async () => {
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
    closeFollowUpMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    sweepOrphanedFollowUpsMock.mockResolvedValue(0);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const first = await runQuoteToolReconcile(new Date('2026-08-10T12:00:00Z'));
      const second = await runQuoteToolReconcile(new Date('2026-08-10T12:05:00Z'));

      expect(first.followUpsSuppressed).toBe(1);
      expect(first.followUpsClosed).toBe(0);
      expect(second.followUpsSuppressed).toBe(1);
      expect(second.followUpsClosed).toBe(0);
      expect(closeFollowUpMock).toHaveBeenNthCalledWith(1, 'item-1', 'quote_sent_no_reply');
      expect(closeFollowUpMock).toHaveBeenNthCalledWith(2, 'item-1', 'quote_sent_no_reply');
      expect(ensureFollowUpMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('#230(b): does not re-warn/re-close/re-count a steady-state suppressed quote once ingestTouch reports it a no-op', async () => {
    // Real ingestTouch (unmocked, store.ts's noopReingest) returns
    // skipped:true once the item's status + last_message_at stop changing —
    // the every-5-minute steady state for a permanently-unapproved internal
    // quote. This test's MOCK models that exact steady-state tick: itemId is
    // still populated (the item exists), but skipped is true and nothing about
    // the ingest changed (autoResolved/reopened both false, matching a noop).
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
    ingestTouchMock.mockResolvedValue({
      ok: true,
      skipped: true,
      itemId: 'item-1',
      contactId: 'contact-1',
      autoResolved: false,
      reopened: false,
      ambiguous: false,
      skipReason: null,
    });
    sweepOrphanedFollowUpsMock.mockResolvedValue(0);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const summary = await runQuoteToolReconcile(new Date('2026-08-14T12:00:00Z'));

      expect(summary.followUpsSuppressed).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(closeFollowUpMock).not.toHaveBeenCalled();
      expect(recordSuppressedFollowUpMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still creates a quote_sent_no_reply follow-up for a real customer quote (#220 regression guard)', async () => {
    listQuotesForDashboardMock.mockResolvedValue([
      {
        id: 'q-real',
        customer_name: 'Yelena Nossa',
        customer_email: 'yelena.nossa@gmail.com',
        customer_phone: null,
        total: 1200,
        created_at: '2026-08-06T10:00:00Z',
        quote_sent_at: '2026-08-06T11:00:00Z',
        customer_approved_at: null,
        deposit_paid_at: null,
        homeworks_sent_at: null,
        homeworks_signed_at: null,
        highlevel_contact_id: null,
        service_type: null,
        quote_number: 2201,
      },
    ]);
    ingestTouchMock.mockResolvedValue(OK_RESULT);
    sweepOrphanedFollowUpsMock.mockResolvedValue(0);

    const summary = await runQuoteToolReconcile(new Date('2026-08-10T12:00:00Z'));

    expect(summary.followUpsCreated).toBe(1);
    expect(summary.followUpsSuppressed).toBe(0);
    expect(summary.followUpsClosed).toBe(0);
    expect(ensureFollowUpMock).toHaveBeenCalledWith({
      inboxItemId: 'item-1',
      contactId: 'contact-1',
      reason: 'quote_sent_no_reply',
      sentAt: new Date('2026-08-06T11:00:00Z'),
      afterDays: 3,
    });
    expect(closeFollowUpMock).not.toHaveBeenCalled();
  });
});

// #252: activityNoiseSkipped must stay a distinguishable subset of `skipped`
// in the reconcile summary, so a swallow regression is observable in prod
// (the raw `skipped` count is expected to be nonzero every run for unrelated
// reasons — outbound-no-existing, noop-reingest — so it alone proves nothing).
describe('runGhlReconcile — activity-noise skip counter (#252)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function conv(over: Record<string, unknown> = {}) {
    return {
      id: 'conv-1',
      locationId: 'loc-1',
      lastMessageDate: 1782693272654,
      lastMessageType: 'TYPE_SMS',
      lastMessageBody: 'hello',
      lastMessageDirection: 'inbound',
      unreadCount: 1,
      contactId: 'contact-1',
      fullName: 'Jane Doe',
      contactName: 'Jane Doe',
      email: 'jane@example.com',
      phone: '(631) 555-2223',
      type: 'TYPE_PHONE',
      ...over,
    };
  }

  it('counts an activity-noise conversation that ingestTouch skips FOR REASON 2 (existing item) as activityNoiseSkipped', async () => {
    searchConversationsMock.mockResolvedValue({
      conversations: [conv({ id: 'a1', lastMessageType: 'TYPE_ACTIVITY_OPPORTUNITY' })],
    });
    // The real ingestTouch/planIngest shape for "existing item + activity
    // noise" (proved by store.test.ts) — skipReason is what the counter is
    // keyed off, not touch.isActivityNoise.
    ingestTouchMock.mockResolvedValue({ ...OK_RESULT, skipped: true, skipReason: 'activity-noise-existing' });

    const summary = await runGhlReconcile(new Date());

    expect(summary.ok).toBe(true);
    expect(summary.skipped).toBe(1);
    expect(summary.activityNoiseSkipped).toBe(1);
    expect(summary.ingested).toBe(0);
  });

  it('does NOT count an ordinary (non-noise) skip as activity-noise', async () => {
    searchConversationsMock.mockResolvedValue({
      conversations: [conv({ id: 'a2', lastMessageType: 'TYPE_SMS' })],
    });
    ingestTouchMock.mockResolvedValue({ ...OK_RESULT, skipped: true, skipReason: 'cold-outbound' });

    const summary = await runGhlReconcile(new Date());

    expect(summary.skipped).toBe(1);
    expect(summary.activityNoiseSkipped).toBe(0);
  });

  it('ingests an activity-noise conversation normally when ingestTouch reports it was NOT skipped (no existing item — the #252 swallow case)', async () => {
    searchConversationsMock.mockResolvedValue({
      conversations: [conv({ id: 'a3', lastMessageType: 'TYPE_ACTIVITY_CONTACT' })],
    });
    ingestTouchMock.mockResolvedValue({ ...OK_RESULT, skipped: false, skipReason: null });

    const summary = await runGhlReconcile(new Date());

    expect(summary.ingested).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.activityNoiseSkipped).toBe(0);
  });

  // #252 delta-verify MEDIUM: a brand-new conversation (no existing row) whose
  // latest GHL event is BOTH outbound-direction AND activity noise is skipped
  // for REASON 1 (cold-outbound — an ordinary "we cold-contacted, nothing to
  // track" skip) even though the touch's isActivityNoise flag is still true.
  // Pre-fix, this counter was keyed off touch.isActivityNoise alone and had
  // no way to tell the two skip reasons apart, so it over-counted this case as
  // #252 noise even though zero reason-2 events occurred (live GHL data shows
  // direction varies independently of message type, so this is a real,
  // reachable combination, not a hypothetical).
  it('does NOT count a cold-outbound activity-noise touch (no existing row) toward activityNoiseSkipped', async () => {
    searchConversationsMock.mockResolvedValue({
      conversations: [conv({ id: 'a4', lastMessageType: 'TYPE_ACTIVITY_OPPORTUNITY', lastMessageDirection: 'outbound' })],
    });
    ingestTouchMock.mockImplementation(async (touch: { isActivityNoise?: boolean | null }) => {
      // Sanity: the real (unmocked) ghl.ts adapter did flag this touch as
      // activity noise — that's exactly why keying the counter off it alone,
      // instead of off the outcome's skipReason, over-counts.
      expect(touch.isActivityNoise).toBe(true);
      // The real ingestTouch/planIngest shape for "no existing item + cold
      // outbound" (proved by store.test.ts): skipped, but skipReason is
      // 'cold-outbound', NOT #252's 'activity-noise-existing'.
      return { ...OK_RESULT, skipped: true, skipReason: 'cold-outbound' };
    });

    const summary = await runGhlReconcile(new Date());

    expect(summary.skipped).toBe(1);
    expect(summary.activityNoiseSkipped).toBe(0);
  });
});
