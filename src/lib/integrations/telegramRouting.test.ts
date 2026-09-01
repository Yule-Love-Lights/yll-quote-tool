import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// getTelegramRouting/putTelegramRouting go through getSupabaseServiceClient
// (@/lib/supabase) — mock it the same way botUsers.test.ts does (a swappable
// current-db ref) so notifyTelegramAudience's internal getTelegramRouting()
// call can be driven from the test without touching real Supabase.
const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));

import {
  sanitizeTelegramRouting,
  chatsForAudience,
  notifyTelegramAudience,
  TELEGRAM_AUDIENCES,
  type TelegramRouting,
} from './telegramRouting';

// Minimal PostgREST-ish fake covering only what getTelegramRouting uses:
// from('app_settings').select('value').eq('key', ...).maybeSingle().
function makeDb(storedValue: unknown) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { value: storedValue }, error: null }),
        }),
      }),
    }),
  };
}

describe('sanitizeTelegramRouting', () => {
  it('rejects non-object / array / null input', () => {
    expect(sanitizeTelegramRouting(null)).toBeNull();
    expect(sanitizeTelegramRouting(undefined)).toBeNull();
    expect(sanitizeTelegramRouting('nope')).toBeNull();
    expect(sanitizeTelegramRouting(42)).toBeNull();
    expect(sanitizeTelegramRouting(['leads'])).toBeNull();
  });

  it('cleans junk out of an audience list: trims strings, drops non-strings/empties', () => {
    const out = sanitizeTelegramRouting({
      leads: ['  -100  ', 123, null, undefined, '', '  ', '200'],
    });
    expect(out).not.toBeNull();
    expect(out!.leads).toEqual(['-100', '200']);
  });

  it('dedupes an audience list, keeping first-seen order', () => {
    const out = sanitizeTelegramRouting({ jobs: ['-100', '-100', '200', '-100'] });
    expect(out!.jobs).toEqual(['-100', '200']);
  });

  it('drops unknown top-level keys and fills missing audiences with []', () => {
    const out = sanitizeTelegramRouting({ leads: ['-100'], somethingElse: ['x'], nested: { a: 1 } });
    expect(out).toEqual({ leads: ['-100'], jobs: [], inventory: [], ops: [], crew: [] });
    expect(Object.keys(out!).sort()).toEqual([...TELEGRAM_AUDIENCES].sort());
  });

  it('ignores a non-array value for an audience (treated as empty)', () => {
    const out = sanitizeTelegramRouting({ ops: 'not-an-array' });
    expect(out!.ops).toEqual([]);
  });
});

describe('chatsForAudience', () => {
  const allow = ['-100', '-200', '300'];

  it('returns the full allowlist when no routing is stored (legacy broadcast)', () => {
    expect(chatsForAudience('leads', null, allow)).toEqual(allow);
  });

  it('returns the intersection of the audience\'s assigned chats and the allowlist', () => {
    const routing: TelegramRouting = { leads: ['-100', '300'], jobs: [], inventory: [], ops: [], crew: [] };
    expect(chatsForAudience('leads', routing, allow)).toEqual(['-100', '300']);
  });

  it('returns [] for an audience with no chats assigned once a routing exists', () => {
    const routing: TelegramRouting = { leads: ['-100'], jobs: [], inventory: [], ops: [], crew: [] };
    expect(chatsForAudience('jobs', routing, allow)).toEqual([]);
  });

  it('drops an assigned chat that has fallen out of the live allowlist (stale-row protection)', () => {
    const routing: TelegramRouting = { leads: ['-100', '-999'], jobs: [], inventory: [], ops: [], crew: [] };
    expect(chatsForAudience('leads', routing, allow)).toEqual(['-100']);
  });
});

describe('notifyTelegramAudience', () => {
  const ENV = ['TELEGRAM_BOT_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHATS'] as const;
  const saved: Record<string, string | undefined> = {};

  function enable() {
    process.env.TELEGRAM_BOT_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_ALLOWED_CHATS = '-100, 200, 300';
  }

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    dbRef.current = null;
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    dbRef.current = null;
  });

  it('no-ops (dormant bot: disabled) — never sends', async () => {
    enable();
    process.env.TELEGRAM_BOT_ENABLED = 'false';
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegramAudience('leads', 'hi', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('no-ops (dormant bot: no token) — never sends', async () => {
    enable();
    delete process.env.TELEGRAM_BOT_TOKEN;
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegramAudience('leads', 'hi', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('no-ops when the allowlist is empty', async () => {
    enable();
    process.env.TELEGRAM_ALLOWED_CHATS = '';
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegramAudience('leads', 'hi', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('broadcasts to the full allowlist while no routing is stored (legacy back-compat)', async () => {
    enable();
    dbRef.current = null; // no db configured => getTelegramRouting() -> null
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegramAudience('jobs', 'hello', send);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledWith('-100', 'hello');
    expect(send).toHaveBeenCalledWith('200', 'hello');
    expect(send).toHaveBeenCalledWith('300', 'hello');
  });

  it('once a routing is stored, sends only to the chats assigned to that audience', async () => {
    enable();
    dbRef.current = makeDb({ leads: ['-100'], jobs: ['300'], inventory: [], ops: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegramAudience('jobs', 'new job', send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('300', 'new job');
  });

  it('sends nothing for an audience with zero chats assigned once a routing exists', async () => {
    enable();
    dbRef.current = makeDb({ leads: ['-100'], jobs: [], inventory: [], ops: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegramAudience('jobs', 'new job', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends to a stored chat that is no longer in the env allowlist', async () => {
    enable();
    dbRef.current = makeDb({ leads: ['-100', '-999'], jobs: [], inventory: [], ops: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyTelegramAudience('leads', 'hi', send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('-100', 'hi');
  });

  it('swallows a per-chat send failure and continues to the rest (never throws)', async () => {
    enable();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    dbRef.current = null;
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    await expect(notifyTelegramAudience('ops', 'digest', send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
