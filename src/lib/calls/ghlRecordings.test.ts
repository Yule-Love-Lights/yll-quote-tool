// Coverage for call classification and lossless pagination behavior
// (calls_merge_plan_2026-08.md slice S2). Ported from the yll-call-copilot
// repo's src/lib/ghl/recordings.test.ts (master fb1bf326) — the export
// listing's field paths are no longer a hypothesis: see
// docs/context/ghl_transcript_probe_2026-08.md and this slice's PR body.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ghlFetchMock = vi.fn();
vi.mock('../integrations/highlevel', async () => {
  const actual = await vi.importActual<typeof import('../integrations/highlevel')>('../integrations/highlevel');
  return {
    ...actual,
    ghlFetch: (...args: unknown[]) => ghlFetchMock(...args),
  };
});

import { isCompletedCallMessage, listRecentCallRecordings, messageDuration } from './ghlRecordings';

describe('listRecentCallRecordings', () => {
  beforeEach(() => {
    process.env.HIGHLEVEL_API_KEY = 'test-key';
    process.env.HIGHLEVEL_LOCATION_ID = 'test-location';
    ghlFetchMock.mockReset();
  });

  it('treats an ordinary empty terminal page as a complete window, not truncation', async () => {
    ghlFetchMock.mockResolvedValueOnce({ messages: [], nextCursor: null, total: 0 });

    await expect(
      listRecentCallRecordings('2026-08-01T00:00:00.000Z', 2, '2026-08-04T00:00:00.000Z'),
    ).resolves.toEqual({
      messages: [],
      truncated: false,
      stopReason: 'window_exhausted',
      nextSince: null,
    });
  });

  const call = (id: string, dateAdded: string, extra: Record<string, unknown> = {}) => ({
    id,
    messageType: 'TYPE_CALL',
    conversationId: `conversation-${id}`,
    contactId: `contact-${id}`,
    direction: 'outbound',
    dateAdded,
    meta: { callStatus: 'completed', callDuration: '60' },
    ...extra,
  });

  it('uses the location-wide Call export with the pinned window and ascending provider cursor', async () => {
    ghlFetchMock.mockResolvedValueOnce({ messages: [], nextCursor: null, total: 0 });

    await listRecentCallRecordings('2026-08-01T00:00:00.000Z', 2, '2026-08-04T00:00:00.000Z');

    const path = ghlFetchMock.mock.calls[0][0] as string;
    expect(path).toContain('/conversations/messages/export?');
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('channel')).toBe('Call');
    expect(params.get('sortOrder')).toBe('asc');
    expect(params.get('startDate')).toBe('2026-08-01T00:00:00.000Z');
    expect(params.get('endDate')).toBe('2026-08-04T00:00:00.000Z');
    // Version header is passed explicitly through ghlFetch's third arg.
    expect(ghlFetchMock.mock.calls[0][2]).toBe('2021-07-28');
  });

  it('returns the oldest calls first and a safe exclusive cursor so a backlog drains without skips', async () => {
    ghlFetchMock.mockResolvedValueOnce({
      messages: [
        call('m-old', '2026-08-01T12:00:00.000Z'),
        call('m-middle', '2026-08-02T00:00:00.000Z'),
        call('m-new', '2026-08-03T00:00:00.000Z'),
      ],
      nextCursor: null,
      total: 3,
    });

    const page = await listRecentCallRecordings('2026-08-01T00:00:00.000Z', 2, '2026-08-04T00:00:00.000Z');

    expect(page.messages.map(message => message.messageId)).toEqual(['m-old', 'm-middle']);
    expect(page).toMatchObject({
      truncated: true,
      stopReason: 'result_limit',
      nextSince: '2026-08-02T00:00:00.001Z',
    });
  });

  it('follows provider cursors so calls beyond one provider page cannot be lost', async () => {
    ghlFetchMock
      .mockResolvedValueOnce({
        messages: [call('m-page-1', '2026-08-01T12:00:00.000Z')],
        nextCursor: 'provider-page-2',
        total: 2,
      })
      .mockResolvedValueOnce({
        messages: [call('m-page-2', '2026-08-02T12:00:00.000Z')],
        nextCursor: null,
        total: 2,
      });

    const page = await listRecentCallRecordings('2026-08-01T00:00:00.000Z', 10, '2026-08-04T00:00:00.000Z');

    expect(page.messages.map(message => message.messageId)).toEqual(['m-page-1', 'm-page-2']);
    expect(ghlFetchMock.mock.calls[1][0]).toContain('cursor=provider-page-2');
    expect(page).toMatchObject({ truncated: false, stopReason: 'window_exhausted', nextSince: null });
  });

  it('includes every call sharing the limit timestamp before advancing one millisecond', async () => {
    ghlFetchMock.mockResolvedValueOnce({
      messages: [
        call('same-a', '2026-08-02T12:00:00.000Z'),
        call('same-b', '2026-08-02T12:00:00.000Z'),
        call('same-c', '2026-08-02T12:00:00.000Z'),
        call('later', '2026-08-02T12:00:01.000Z'),
      ],
      nextCursor: null,
      total: 4,
    });

    const page = await listRecentCallRecordings('2026-08-01T00:00:00.000Z', 2, '2026-08-04T00:00:00.000Z');

    expect(page.messages.map(message => message.messageId)).toEqual(['same-a', 'same-b', 'same-c']);
    expect(page.nextSince).toBe('2026-08-02T12:00:00.001Z');
  });

  it('does not split one timestamp group across provider pages', async () => {
    ghlFetchMock
      .mockResolvedValueOnce({
        messages: [call('same-a', '2026-08-02T12:00:00.000Z'), call('same-b', '2026-08-02T12:00:00.000Z')],
        nextCursor: 'same-time-page-2',
      })
      .mockResolvedValueOnce({
        messages: [call('same-c', '2026-08-02T12:00:00.000Z'), call('later', '2026-08-02T12:00:01.000Z')],
        nextCursor: null,
      });

    const page = await listRecentCallRecordings('2026-08-01T00:00:00.000Z', 2, '2026-08-04T00:00:00.000Z');

    expect(page.messages.map(message => message.messageId)).toEqual(['same-a', 'same-b', 'same-c']);
    expect(page.nextSince).toBe('2026-08-02T12:00:00.001Z');
  });

  it('returns a proved time continuation at the provider page cap instead of getting stuck forever', async () => {
    for (let index = 0; index < 20; index++) {
      ghlFetchMock.mockResolvedValueOnce({
        messages: [call(`page-${index}`, `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`)],
        nextCursor: `cursor-${index + 1}`,
      });
    }

    const page = await listRecentCallRecordings('2026-08-01T00:00:00.000Z', 100, '2026-08-31T00:00:00.000Z');

    expect(page).toMatchObject({
      truncated: true,
      stopReason: 'provider_page_cap',
      nextSince: '2026-08-19T12:00:00.001Z',
    });
    expect(page.messages).toHaveLength(19);
    expect(ghlFetchMock).toHaveBeenCalledTimes(20);
  });

  it('fails the whole fetch when one export page fails so the caller cannot advance past unseen calls', async () => {
    ghlFetchMock.mockRejectedValueOnce(new Error('GHL export page failed'));

    await expect(
      listRecentCallRecordings('2026-08-01T00:00:00.000Z', 2, '2026-08-04T00:00:00.000Z'),
    ).rejects.toThrow(/export page failed/i);
  });

  it('fails instead of looping when HighLevel repeats a provider cursor', async () => {
    ghlFetchMock
      .mockResolvedValueOnce({ messages: [call('m1', '2026-08-01T12:00:00.000Z')], nextCursor: 'repeat' })
      .mockResolvedValueOnce({ messages: [call('m2', '2026-08-02T12:00:00.000Z')], nextCursor: 'repeat' });

    await expect(
      listRecentCallRecordings('2026-08-01T00:00:00.000Z', 10, '2026-08-04T00:00:00.000Z'),
    ).rejects.toThrow(/repeated a pagination cursor/i);
  });

  it('refuses a missing HIGHLEVEL_LOCATION_ID before ever calling ghlFetch', async () => {
    delete process.env.HIGHLEVEL_LOCATION_ID;

    await expect(
      listRecentCallRecordings('2026-08-01T00:00:00.000Z', 2, '2026-08-04T00:00:00.000Z'),
    ).rejects.toThrow(/HIGHLEVEL_LOCATION_ID/);
    expect(ghlFetchMock).not.toHaveBeenCalled();
  });
});

describe('isCompletedCallMessage', () => {
  it('is true for a completed call message (messageType shape)', () => {
    expect(isCompletedCallMessage({ id: 'm1', messageType: 'TYPE_CALL', meta: { call: { status: 'completed' } } })).toBe(
      true,
    );
  });

  it('is true for a completed call message (flat callStatus shape)', () => {
    expect(isCompletedCallMessage({ id: 'm1', type: 'call', callStatus: 'completed' })).toBe(true);
  });

  it('is false for a non-call message type', () => {
    expect(isCompletedCallMessage({ id: 'm1', messageType: 'TYPE_SMS', meta: { call: { status: 'completed' } } })).toBe(
      false,
    );
  });

  it('is false for a call message that is not completed (voicemail/no-answer/missing status)', () => {
    expect(isCompletedCallMessage({ id: 'm1', messageType: 'TYPE_CALL', meta: { call: { status: 'voicemail' } } })).toBe(
      false,
    );
    expect(isCompletedCallMessage({ id: 'm1', messageType: 'TYPE_CALL' })).toBe(false);
  });
});

describe('messageDuration', () => {
  it('reads the official string duration from meta.callDuration', () => {
    expect(messageDuration({ id: 'm1', meta: { callDuration: '90' } })).toBe(90);
  });

  it('reads duration from the nested meta.call shape', () => {
    expect(messageDuration({ id: 'm1', meta: { call: { duration: 90 } } })).toBe(90);
  });

  it('reads duration from the flat callDuration shape', () => {
    expect(messageDuration({ id: 'm1', callDuration: 45 })).toBe(45);
  });

  it('is null when no duration field is present', () => {
    expect(messageDuration({ id: 'm1' })).toBeNull();
  });
});
