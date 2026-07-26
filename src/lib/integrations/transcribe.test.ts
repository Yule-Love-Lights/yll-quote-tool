import { describe, it, expect, vi, afterEach } from 'vitest';
import { isTranscriptionConfigured, transcribeAudio } from './transcribe';

const realFetch = global.fetch;
const realKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  vi.restoreAllMocks();
});

describe('isTranscriptionConfigured', () => {
  it('is true when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(isTranscriptionConfigured()).toBe(true);
  });

  it('is false when OPENAI_API_KEY is unset', () => {
    delete process.env.OPENAI_API_KEY;
    expect(isTranscriptionConfigured()).toBe(false);
  });
});

describe('transcribeAudio', () => {
  it('returns null when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await transcribeAudio(Buffer.from('abc'), 'note.oga')).toBeNull();
  });

  it('posts model whisper-1 with the bearer key and returns the trimmed text', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let capturedForm: FormData | undefined;
    let capturedAuth: string | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ text: '  turn on the front lights  ' }), { status: 200 });
    }) as unknown as typeof fetch;

    const text = await transcribeAudio(Buffer.from('fake audio bytes'), 'note.oga');
    expect(text).toBe('turn on the front lights');
    expect(capturedAuth).toBe('Bearer sk-test');
    expect(capturedForm?.get('model')).toBe('whisper-1');
    expect(capturedForm?.get('file')).toBeTruthy();
  });

  it('returns null on a non-2xx response', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    global.fetch = vi.fn(async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;
    expect(await transcribeAudio(Buffer.from('abc'), 'note.oga')).toBeNull();
  });

  it('returns null WITHOUT calling fetch when the buffer exceeds 25MB', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const big = Buffer.alloc(26 * 1024 * 1024);

    expect(await transcribeAudio(big, 'note.oga')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on malformed JSON', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    global.fetch = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    expect(await transcribeAudio(Buffer.from('abc'), 'note.oga')).toBeNull();
  });

  it('returns null when the transcribed text is empty', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ text: '   ' }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await transcribeAudio(Buffer.from('abc'), 'note.oga')).toBeNull();
  });

  it('returns null and never throws on a network error / timeout', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(transcribeAudio(Buffer.from('abc'), 'note.oga')).resolves.toBeNull();
  });

  it('never logs the API key or audio bytes', async () => {
    process.env.OPENAI_API_KEY = 'sk-SUPERSECRETKEY9999';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = vi.fn(async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;

    await transcribeAudio(Buffer.from('secret-audio-bytes'), 'note.oga');

    const allOutput = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join(' ');
    expect(allOutput).not.toContain('sk-SUPERSECRETKEY9999');
    expect(allOutput).not.toContain('secret-audio-bytes');
  });
});
