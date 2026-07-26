// src/lib/integrations/transcribe.ts
// Turns crew voice notes into text via OpenAI's Whisper transcription API.
// Feeds the Telegram bot's voice-note flow — file bytes come from
// telegramMedia.ts's downloadTelegramFile(); this module only knows about
// OpenAI's API, not Telegram.
//
// Env:
//   OPENAI_API_KEY   OpenAI API key with audio.transcriptions access

const API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 25 * 1024 * 1024; // Whisper's hard per-file limit

export function isTranscriptionConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Transcribe an audio buffer to text. Never throws — a crew member's voice
 * note that can't be transcribed should fall back to "couldn't transcribe,
 * please type it" rather than crash the bot, so every failure path (missing
 * key, oversized file, non-2xx, malformed JSON, timeout) returns null.
 */
export async function transcribeAudio(buffer: Buffer, filename: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // Reject oversized buffers before spending a network round trip — Whisper
  // rejects anything over 25MB anyway, so this just fails fast and locally
  // (and never puts the audio bytes in a log line).
  if (buffer.byteLength > MAX_BYTES) {
    console.warn(`[transcribe] audio buffer (${buffer.byteLength} bytes) exceeds the Whisper 25MB limit`);
    return null;
  }

  // Buffer's ArrayBufferLike is wider than BlobPart's ArrayBuffer (it also
  // covers SharedArrayBuffer), so wrap in a fresh Uint8Array view first —
  // same pattern as the PDF route's NextResponse body (route.tsx).
  const form = new FormData();
  form.append('file', new File([new Uint8Array(buffer)], filename));
  form.append('model', 'whisper-1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[transcribe] Whisper request failed: ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { text?: unknown };
    const text = typeof json?.text === 'string' ? json.text.trim() : '';
    return text || null;
  } catch {
    // Covers network errors, the AbortController timeout, and malformed-JSON
    // parse failures from res.json() — never leak the key or audio bytes.
    console.warn('[transcribe] Whisper request errored (timeout, network, or bad response)');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
