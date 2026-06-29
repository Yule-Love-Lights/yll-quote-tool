import { describe, it, expect, afterEach, vi } from 'vitest';
import { notifyTelegram, appBaseUrl } from './telegramNotify';

const ENV = ['TELEGRAM_BOT_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHATS', 'PORTAL_BASE_URL'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

function enable() {
  process.env.TELEGRAM_BOT_ENABLED = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.TELEGRAM_ALLOWED_CHATS = '-100, 200';
}

describe('notifyTelegram', () => {
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it('no-ops when the bot is disabled', async () => {
    enable();
    process.env.TELEGRAM_BOT_ENABLED = 'false';
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegram('hi', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('no-ops when the token is not configured', async () => {
    enable();
    delete process.env.TELEGRAM_BOT_TOKEN;
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegram('hi', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('no-ops when the allowlist is empty', async () => {
    enable();
    process.env.TELEGRAM_ALLOWED_CHATS = '';
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegram('hi', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('broadcasts to every allowlisted chat', async () => {
    enable();
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegram('hello', send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('-100', 'hello');
    expect(send).toHaveBeenCalledWith('200', 'hello');
  });

  it('swallows a send failure and continues to the other chats (never throws)', async () => {
    enable();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    await expect(notifyTelegram('hi', send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('appBaseUrl', () => {
  afterEach(() => {
    if (saved.PORTAL_BASE_URL === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = saved.PORTAL_BASE_URL;
  });

  it('uses PORTAL_BASE_URL when set (trailing slash stripped)', () => {
    process.env.PORTAL_BASE_URL = 'https://example.com/';
    expect(appBaseUrl()).toBe('https://example.com');
  });

  it('falls back to the prod domain when unset', () => {
    delete process.env.PORTAL_BASE_URL;
    expect(appBaseUrl()).toBe('https://quote.yulelovelights.com');
  });
});
