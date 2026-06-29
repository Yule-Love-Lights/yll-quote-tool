import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchConversations, getConversationMessages, markConversationRead, addContactTags } from './highlevel';

const realFetch = global.fetch;

beforeEach(() => {
  process.env.HIGHLEVEL_API_KEY = 'test-key';
  process.env.HIGHLEVEL_LOCATION_ID = 'loc-1';
});
afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = realFetch;
});

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('searchConversations', () => {
  it('calls /conversations/search with locationId + the conversations Version header', async () => {
    const fetchMock = stubFetch({ conversations: [{ id: 'c1', lastMessageDate: 1, lastMessageDirection: 'inbound' }], total: 1 });
    const res = await searchConversations({ limit: 5 });
    expect(res.total).toBe(1);
    expect(res.conversations).toHaveLength(1);
    expect(res.conversations[0].id).toBe('c1');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/conversations/search');
    expect(url).toContain('locationId=loc-1');
    expect(url).toContain('limit=5');
    const headers = init.headers as Record<string, string>;
    expect(headers.Version).toBe('2021-04-15');
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('defaults to an empty array + 0 total when the API omits fields', async () => {
    stubFetch({});
    const res = await searchConversations();
    expect(res.conversations).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('throws on a non-200 (e.g. missing conversations scope)', async () => {
    stubFetch({ message: 'forbidden' }, 403);
    await expect(searchConversations()).rejects.toThrow();
  });
});

describe('getConversationMessages', () => {
  it('unwraps the double-nested messages.messages array (spike finding)', async () => {
    stubFetch({
      messages: {
        messages: [
          { id: 'm1', direction: 'inbound', messageType: 'TYPE_SMS' },
          { id: 'm2', direction: 'outbound', messageType: 'TYPE_SMS' },
        ],
        lastMessageId: 'm1',
      },
      traceId: 't',
    });
    const res = await getConversationMessages('conv-1');
    expect(res.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('returns an empty array when the nesting is absent', async () => {
    stubFetch({ messages: {} });
    const res = await getConversationMessages('conv-1');
    expect(res.messages).toEqual([]);
  });
});

describe('addContactTags — write path (handled-by / dashboard-handled tags)', () => {
  it('POSTs the tags to the contact tags endpoint', async () => {
    const fetchMock = stubFetch({ tags: ['dashboard-handled'] });
    await addContactTags('contact-1', ['dashboard-handled', 'handled-by-naldo']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).toContain('/contacts/contact-1/tags');
    expect(JSON.parse(init.body as string)).toEqual({ tags: ['dashboard-handled', 'handled-by-naldo'] });
  });
});

describe('markConversationRead — write path (documented; verify badge semantics live before relying on it)', () => {
  it('issues a PUT to the message status endpoint with status:read', async () => {
    const fetchMock = stubFetch({ ok: true });
    await markConversationRead('conv-1', 'msg-9');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(url).toContain('/conversations/conv-1/messages/msg-9/status');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'read' });
  });
});
