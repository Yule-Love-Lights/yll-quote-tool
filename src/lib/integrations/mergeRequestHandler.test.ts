import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logBotAction = vi.fn();
vi.mock('./botAudit', () => ({ logBotAction: (...args: unknown[]) => logBotAction(...args) }));

import { handleMergeRequest } from './mergeRequestHandler';

const APPROVER = '55501234';
const OTHER_USER = '99999999';
const ORIGINAL_ENV = process.env;

function configured() {
  process.env.MERGE_APPROVER_TELEGRAM_USER_ID = APPROVER;
  process.env.MERGE_ROUTINE_FIRE_URL = 'https://api.anthropic.com/v1/code/routines/trig_test/fire';
  process.env.MERGE_ROUTINE_FIRE_TOKEN = 'sk-ant-oat01-test-token-value';
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  logBotAction.mockReset();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MERGE_APPROVER_TELEGRAM_USER_ID;
  delete process.env.MERGE_ROUTINE_FIRE_URL;
  delete process.env.MERGE_ROUTINE_FIRE_TOKEN;
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.unstubAllGlobals();
});

describe('handleMergeRequest — what it lets through', () => {
  it('fires the routine and acknowledges when the approver names a pull request', async () => {
    configured();
    const out = await handleMergeRequest(APPROVER, 'merge 1043', { chatId: 'c1' });
    expect(out.handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(process.env.MERGE_ROUTINE_FIRE_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).text).toContain('1043');
    expect(out.handled && out.reply).toContain('1043');
    // The ack must not imply the merge already happened.
    expect(out.handled && out.reply).toMatch(/nothing is live until then/i);
  });

  it('records the request in the audit log as having run', async () => {
    configured();
    await handleMergeRequest(APPROVER, 'merge 1043', { chatId: 'c1' });
    expect(logBotAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'merge_request',
        outcome: 'ran',
        userId: APPROVER,
        args: { prNumber: 1043 },
      }),
    );
  });

  it('ignores traffic that is not a merge request, so normal dispatch continues', async () => {
    configured();
    const out = await handleMergeRequest(APPROVER, 'status', {});
    expect(out).toEqual({ handled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleMergeRequest — what it refuses', () => {
  it('refuses a sender who is not the configured approver, and never fires', async () => {
    configured();
    const out = await handleMergeRequest(OTHER_USER, 'merge 1043', { chatId: 'c1' });
    expect(out).toEqual({ handled: true, reply: 'Only the owner can merge from here.' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logBotAction).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'merge_request', outcome: 'denied', userId: OTHER_USER }),
    );
  });

  it('stays silent in a group when a non-approver types it unaddressed', async () => {
    configured();
    const out = await handleMergeRequest(OTHER_USER, 'merge 12', { addressed: false });
    expect(out).toEqual({ handled: false });
    expect(fetchMock).not.toHaveBeenCalled();
    // Still audited, so an unexpected attempt is findable later.
    expect(logBotAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'denied' }),
    );
  });

  it('refuses everyone when no approver is configured', async () => {
    process.env.MERGE_ROUTINE_FIRE_URL = 'https://example.invalid/fire';
    process.env.MERGE_ROUTINE_FIRE_TOKEN = 'token';
    const out = await handleMergeRequest(APPROVER, 'merge 1043', {});
    expect(out.handled).toBe(true);
    expect(out.handled && out.reply).toMatch(/not set up yet/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when the routine is not configured, without pretending it worked', async () => {
    process.env.MERGE_APPROVER_TELEGRAM_USER_ID = APPROVER;
    const out = await handleMergeRequest(APPROVER, 'merge 1043', {});
    expect(out.handled && out.reply).toMatch(/not set up yet/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logBotAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', detail: 'merge routine not configured' }),
    );
  });

  it('coaches the approver when the number is missing instead of guessing', async () => {
    configured();
    const out = await handleMergeRequest(APPROVER, 'merge', {});
    expect(out.handled && out.reply).toMatch(/which pull request/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not coach anyone else about the merge channel', async () => {
    configured();
    const out = await handleMergeRequest(OTHER_USER, 'merge', {});
    expect(out).toEqual({ handled: false });
  });
});

describe('handleMergeRequest — when the hand-off fails', () => {
  it('says nothing was merged when the routine call returns an error status', async () => {
    configured();
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const out = await handleMergeRequest(APPROVER, 'merge 1043', {});
    expect(out.handled && out.reply).toMatch(/nothing was merged/i);
    expect(logBotAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', detail: 'fire returned 401' }),
    );
  });

  it('says nothing was merged when the routine call throws', async () => {
    configured();
    fetchMock.mockRejectedValue(new Error('network down'));
    const out = await handleMergeRequest(APPROVER, 'merge 1043', {});
    expect(out.handled && out.reply).toMatch(/nothing was merged/i);
    expect(logBotAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
    );
  });

  it('never leaks the bearer token or the routine url into a reply or the audit log', async () => {
    configured();
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED https://api.anthropic.com'));
    const out = await handleMergeRequest(APPROVER, 'merge 1043', {});
    const token = process.env.MERGE_ROUTINE_FIRE_TOKEN as string;
    const url = process.env.MERGE_ROUTINE_FIRE_URL as string;
    const reply = out.handled ? out.reply : '';
    expect(reply).not.toContain(token);
    expect(reply).not.toContain(url);
    const audited = JSON.stringify(logBotAction.mock.calls);
    expect(audited).not.toContain(token);
    expect(audited).not.toContain(url);
  });
});
