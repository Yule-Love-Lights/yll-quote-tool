// src/lib/integrations/telegramMedia.ts
// Downloads media files (voice notes, photos) that crew send to the staff
// Telegram bot (#82 Phase 3+). Telegram's Bot API is a two-step fetch:
//   1. getFile  — resolve an update's `file_id` to a short-lived `file_path`
//                 on Telegram's CDN.
//   2. the file — GET https://api.telegram.org/file/bot<token>/<file_path>.
// Both URLs embed the bot token, so they're secrets themselves — never log
// the resolved URL or the token, only the file_id.
//
// Env:
//   TELEGRAM_BOT_TOKEN   bot token from @BotFather (same var as telegram.ts)

const API_BASE = 'https://api.telegram.org';
const FETCH_TIMEOUT_MS = 20_000;
// Telegram's own Bot API file-download endpoint caps at 20MB regardless of
// what we ask for — enforce the same ceiling locally so a lying/missing
// Content-Length header can't make us buffer an unbounded response.
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Resolve a Telegram `file_id` to a downloadable URL. Returns null on any
 * failure (missing token, non-ok response, missing file_path, network error,
 * timeout) — callers treat "can't fetch this media" as a normal outcome to
 * handle, not an exception to catch.
 */
export async function getTelegramFileUrl(fileId: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[telegramMedia] getFile failed for file_id=${fileId}: ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { ok?: boolean; result?: { file_path?: string } };
    if (!json?.ok) {
      console.warn(`[telegramMedia] getFile returned ok:false for file_id=${fileId}`);
      return null;
    }
    const filePath = json.result?.file_path;
    if (!filePath) {
      console.warn(`[telegramMedia] getFile missing file_path for file_id=${fileId}`);
      return null;
    }
    return `${API_BASE}/file/bot${token}/${filePath}`;
  } catch {
    // Network error / timeout — swallow rather than throw a message that
    // could carry the request URL (and therefore the token) upstream.
    console.warn(`[telegramMedia] getFile request errored for file_id=${fileId}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a Telegram file's bytes + content-type. Checks the declared
 * Content-Length up front (cheap early-out) AND the actual downloaded size
 * (a header can be absent or wrong) before accepting the buffer.
 */
export async function downloadTelegramFile(
  fileId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const url = await getTelegramFileUrl(fileId);
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[telegramMedia] file download failed for file_id=${fileId}: ${res.status}`);
      return null;
    }

    const declaredLength = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
      console.warn(`[telegramMedia] file_id=${fileId} exceeds the ${MAX_BYTES}-byte cap (declared)`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_BYTES) {
      console.warn(`[telegramMedia] file_id=${fileId} exceeds the ${MAX_BYTES}-byte cap (actual)`);
      return null;
    }

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    return { buffer: Buffer.from(arrayBuffer), contentType };
  } catch {
    console.warn(`[telegramMedia] file download errored for file_id=${fileId}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
