import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAccessToken,
  listInboxThreads,
  getThread,
  isGmailConfigured,
  getOrCreateLabel,
  modifyMessage,
} from './gmail';

const realFetch = global.fetch;

beforeEach(() => {
  process.env.GMAIL_CLIENT_ID = 'cid';
  process.env.GMAIL_CLIENT_SECRET = 'secret';
  process.env.GMAIL_REFRESH_TOKEN = 'refresh';
  process.env.GMAIL_USER = 'sales@yulelovelights.com';
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

function seqFetch(responses: unknown[]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('isGmailConfigured', () => {
  it('is true only with all OAuth creds present', () => {
    expect(isGmailConfigured()).toBe(true);
    delete process.env.GMAIL_REFRESH_TOKEN;
    expect(isGmailConfigured()).toBe(false);
  });
});

describe('getAccessToken', () => {
  it('exchanges the refresh token and caches the access token', async () => {
    const fetchMock = stubFetch({ access_token: 'tok-1', expires_in: 3600 });
    const t1 = await getAccessToken(1_000);
    expect(t1).toBe('tok-1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('grant_type=refresh_token');
    expect(String(init.body)).toContain('refresh_token=refresh');

    // Second call within the validity window is served from cache (no 2nd fetch).
    const t2 = await getAccessToken(1_000);
    expect(t2).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on a refresh failure', async () => {
    stubFetch({ error: 'invalid_grant' }, 400);
    await expect(getAccessToken(10_000_000_000_000)).rejects.toThrow();
  });
});

describe('listInboxThreads', () => {
  it('queries in:inbox and returns the thread refs', async () => {
    const fetchMock = stubFetch({ threads: [{ id: 't1', snippet: 'hi' }] });
    const res = await listInboxThreads('tok', { maxResults: 10 });
    expect(res).toEqual([{ id: 't1', snippet: 'hi' }]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/users/sales%40yulelovelights.com/threads');
    expect(url).toContain('in%3Ainbox'); // q=in:inbox url-encoded
    expect(url).toContain('maxResults=10');
  });
});

describe('getThread', () => {
  it('fetches a thread with metadata headers', async () => {
    const fetchMock = stubFetch({ id: 't1', messages: [{ id: 'm1' }] });
    const res = await getThread('tok', 't1');
    expect(res.id).toBe('t1');
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/threads/t1');
    expect(url).toContain('format=metadata');
  });
});

describe('getOrCreateLabel (WRITE)', () => {
  it('returns the id of an existing label', async () => {
    stubFetch({ labels: [{ id: 'L1', name: 'YLL/Handled' }] });
    expect(await getOrCreateLabel('tok', 'YLL/Handled')).toBe('L1');
  });
  it('creates the label when it is absent', async () => {
    const fetchMock = seqFetch([{ labels: [] }, { id: 'L2', name: 'YLL/Handled' }]);
    expect(await getOrCreateLabel('tok', 'YLL/Handled')).toBe('L2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'YLL/Handled' });
  });
});

// #293 fix round (customer HIGH, 3rd instance): message-level is the ONLY
// way the Handled write-back touches Gmail — a thread-wide modify would
// label/mark-read every OTHER coalesced customer's still-unworked forward on
// the same thread too (Gmail merges different customers' Zapier lead-forwards
// into one thread when they share a subject line).
describe('modifyMessage (WRITE)', () => {
  it('POSTs add/remove labels to the MESSAGE modify endpoint, not the thread one', async () => {
    const fetchMock = stubFetch({});
    await modifyMessage('tok', 'm1', { addLabelIds: ['L1'], removeLabelIds: ['UNREAD'] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/messages/m1/modify');
    expect(url).not.toContain('/threads/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ addLabelIds: ['L1'], removeLabelIds: ['UNREAD'] });
  });
});
