import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTelegramFileUrl, downloadTelegramFile } from './telegramMedia';

const realFetch = global.fetch;
const realToken = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  global.fetch = realFetch;
  if (realToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = realToken;
  vi.restoreAllMocks();
});

describe('getTelegramFileUrl', () => {
  it('returns null when TELEGRAM_BOT_TOKEN is unset', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(await getTelegramFileUrl('file123')).toBeNull();
  });

  it('returns null when Telegram responds ok:false', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN:abc';
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await getTelegramFileUrl('file123')).toBeNull();
  });

  it('returns null when file_path is missing from the result', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN:abc';
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await getTelegramFileUrl('file123')).toBeNull();
  });

  it('builds the correct file URL from getFile on the happy path', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN:abc';
    global.fetch = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.telegram.org/botTESTTOKEN:abc/getFile?file_id=file123');
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.oga' } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const url = await getTelegramFileUrl('file123');
    expect(url).toBe('https://api.telegram.org/file/botTESTTOKEN:abc/voice/file_1.oga');
  });

  it('returns null and never throws when fetch rejects', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN:abc';
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(getTelegramFileUrl('file123')).resolves.toBeNull();
  });
});

describe('downloadTelegramFile', () => {
  it('returns null when TELEGRAM_BOT_TOKEN is unset', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(await downloadTelegramFile('file123')).toBeNull();
  });

  it('downloads the bytes + content-type on the happy path', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN:abc';
    const bytes = new Uint8Array([1, 2, 3, 4]);
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/p1.jpg' } }), {
          status: 200,
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength) },
      });
    }) as unknown as typeof fetch;

    const result = await downloadTelegramFile('file123');
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe('image/jpeg');
    expect(Buffer.compare(result!.buffer, Buffer.from(bytes))).toBe(0);
  });

  it('defaults content-type to application/octet-stream when the header is absent', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN:abc';
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'x/y.bin' } }), { status: 200 });
      }
      return new Response(new Uint8Array([9]), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await downloadTelegramFile('file123');
    expect(result?.contentType).toBe('application/octet-stream');
  });

  it('returns null when the declared content-length exceeds the 20MB cap', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN:abc';
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'video/huge.mp4' } }), {
          status: 200,
        });
      }
      return new Response(new Uint8Array(10), {
        status: 200,
        headers: { 'content-length': String(21 * 1024 * 1024) },
      });
    }) as unknown as typeof fetch;

    expect(await downloadTelegramFile('file123')).toBeNull();
  });

  it('returns null and never throws when the file fetch rejects', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN:abc';
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/p1.jpg' } }), {
          status: 200,
        });
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(downloadTelegramFile('file123')).resolves.toBeNull();
  });

  it('never logs the bot token, even on failure paths', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'SUPERSECRETTOKEN9999';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/p1.jpg' } }), {
          status: 200,
        });
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await downloadTelegramFile('file123');

    const allOutput = [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map(String)
      .join(' ');
    expect(allOutput).not.toContain('SUPERSECRETTOKEN9999');
  });
});
