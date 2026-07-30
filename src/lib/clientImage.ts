'use client';

// Client-side photo downscale before upload (#186). Every photo-upload path
// in the app base64-encodes the raw File into a JSON request body
// (DesignEditor's extra photos, QuoteBuilder's main + satellite uploads, the
// embedded editor's base-photo swap, the training-capture page). Base64
// inflates the raw bytes ~33%, and Vercel's serverless functions hard-cap the
// request body at 4.5MB — a photo over ~3.4MB 413s at the platform layer
// before our own code (which tolerates decoded images up to 10MB) ever runs.
// Resizing + re-compressing on the client keeps typical phone/camera photos
// comfortably under that cap.

const MAX_EDGE_PX = 2560; // longest-edge cap — plenty for the design canvas/portal display.
const SKIP_BELOW_BYTES = 2.5 * 1024 * 1024; // already-small files upload as-is (no quality loss).
const JPEG_QUALITY = 0.85;

// Proportional target size for an image capped at maxEdge on its longest
// side. Never upscales — an image already within the cap keeps its own size.
export function computeTargetDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE_PX,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= 0 || longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// True when a source file is small enough (bytes) AND already within the
// edge cap (pixels) that re-encoding it would only cost quality for nothing.
export function shouldSkipDownscale(
  fileSizeBytes: number,
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE_PX,
  skipBelowBytes: number = SKIP_BELOW_BYTES,
): boolean {
  return fileSizeBytes < skipBelowBytes && Math.max(width, height) <= maxEdge;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(blob);
  });
}

// Promisified canvas.toBlob — the native way to get re-encoded image bytes
// as a Blob (no dataURL round-trip needed for the multipart/FormData path).
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), type, quality);
  });
}

// The raw-upload fallback's mediaType (skip-path + decode-failure path): trust
// the browser's reported file.type only when it actually looks like an image
// — some Android/Chrome HEIC combos report a non-image type (or an empty
// string), which would otherwise get sent to our API as photoMediaType.
export function safeMediaType(mediaType: string | null | undefined): string {
  return mediaType && mediaType.startsWith('image/') ? mediaType : 'image/jpeg';
}

type Decoded = {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  cleanup: () => void;
};

// Decode via createImageBitmap where available (fast, no DOM attach); fall
// back to an <img> + object URL for browsers/formats that reject it.
async function decodeImage(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    // Pin orientation explicitly: the canvas re-encode below discards EXIF
    // permanently, so an implicit browser default is too much trust — today's
    // browsers already default to 'from-image', but that's not guaranteed.
    // The HTMLImageElement fallback applies EXIF orientation natively.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      cleanup: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

// Shared decode/skip/re-encode core behind both downscaleForUpload (dataUrl,
// for the base64-JSON upload paths) and downscaleForUploadAsBlob (Blob, for
// the multipart/FormData upload paths, #186 phase 2). Skips re-encoding for
// already-small photos. PNGs (screenshots etc.) flatten onto JPEG on the
// resize path — these are house photos, so alpha transparency isn't a real
// concern (decided, #186).
//
// Falls back to the raw file (unresized, original mediaType) if decoding
// fails — some browsers can't decode HEIC straight from a File/Blob — so
// upload still works, just without 413 protection for that rare case.
async function downscaleForUploadCore(file: File): Promise<{ blob: Blob; mediaType: string }> {
  try {
    const img = await decodeImage(file);
    try {
      if (shouldSkipDownscale(file.size, img.width, img.height)) {
        // No re-encoding needed — return the original File untouched rather
        // than a decode→re-encode round-trip that would cost quality/CPU for
        // nothing.
        return { blob: file, mediaType: safeMediaType(file.type) };
      }
      const { width, height } = computeTargetDimensions(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');
      img.draw(ctx, width, height);
      const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
      return { blob, mediaType: 'image/jpeg' };
    } finally {
      img.cleanup();
    }
  } catch {
    return { blob: file, mediaType: safeMediaType(file.type) };
  }
}

// Downscale a user-picked photo before it's base64-encoded into a JSON
// upload body. See downscaleForUploadCore above.
export async function downscaleForUpload(file: File): Promise<{ dataUrl: string; mediaType: string }> {
  const { blob, mediaType } = await downscaleForUploadCore(file);
  return { dataUrl: await readAsDataUrl(blob), mediaType };
}

// Downscale a user-picked photo for a multipart/FormData upload body (#186
// phase 2 — the analyze-photo/training multipart senders were still
// appending the raw File, so they kept 413ing on Vercel's ~4.5MB raw-body
// cap after the JSON paths were fixed in #186 phase 1). Returns a Blob
// directly — no dataUrl round-trip — so callers just fd.append('photo', blob, name).
export async function downscaleForUploadAsBlob(file: File): Promise<{ blob: Blob; mediaType: string }> {
  return downscaleForUploadCore(file);
}

// Multi-photo batch precheck (#186 review): a single site (the training-
// capture page) submits several photos in ONE JSON body. Even after each
// photo is downscaled individually, a handful of them can still add up past
// Vercel's 4.5MB request-body cap — 5 photos at a realistic ~800KB downscaled
// size are already ~4MB of base64 alone, before the rest of the JSON body.
// Sum the (already-downscaled) base64 lengths — that's the actual wire size
// those photos contribute, since base64 is single-byte-per-char ASCII — and
// compare against a budget safely under the cap so the caller can block the
// submit with a clear error instead of letting the request 413.
export const SUBMIT_BYTE_BUDGET = 3 * 1024 * 1024; // ~3MB — leaves headroom for the rest of the body.

export function totalBase64Bytes(base64s: string[]): number {
  return base64s.reduce((sum, b) => sum + b.length, 0);
}

export function exceedsSubmitBudget(base64s: string[], budget: number = SUBMIT_BYTE_BUDGET): boolean {
  return totalBase64Bytes(base64s) > budget;
}

// ─── Multipart precheck + graceful error handling (#186 phase 2) ──────────
// Some multipart uploads must NOT be downscaled (/api/uploads' custom
// graphic library — decorative PNGs need their transparency, so JPEG
// flattening isn't an option there). Those sites instead get a client-side
// size precheck: reject an oversized file with a clear message BEFORE the
// network round-trip, rather than let Vercel's raw-body cap 413 it.
export const MULTIPART_SIZE_LIMIT_BYTES = 4 * 1024 * 1024; // ~4MB — headroom under Vercel's ~4.5MB raw-body cap.

export function exceedsMultipartSizeLimit(fileSizeBytes: number, limit: number = MULTIPART_SIZE_LIMIT_BYTES): boolean {
  return fileSizeBytes > limit;
}

// Staff-facing oversize message, e.g. "This graphic is 6.2MB — the server
// accepts about 4MB."
export function oversizeMessage(
  fileSizeBytes: number,
  limit: number = MULTIPART_SIZE_LIMIT_BYTES,
  noun: string = 'file',
): string {
  const sizeMb = (fileSizeBytes / (1024 * 1024)).toFixed(1);
  const limitMb = Math.round(limit / (1024 * 1024));
  return `This ${noun} is ${sizeMb}MB — the server accepts about ${limitMb}MB.`;
}

// A response Vercel rejected at the platform layer for being too large comes
// back with a PLAIN-TEXT "Request Entity Too Large" body, status 413 — NOT
// JSON. Blindly calling res.json() on that throws a raw SyntaxError
// ("Unexpected token 'R'... is not valid JSON") which every upload call site
// caught only generically (err.message), leaking that raw parse error to the
// user. Read the body as text first; map 413 to a friendly message, and only
// attempt to parse anything else as JSON.
export async function readUploadErrorMessage(
  res: Response,
  fallback: string = 'Upload failed',
  tooLargeMessage: string = 'This photo is too large for the server — try a smaller photo.',
): Promise<string> {
  if (res.status === 413) return tooLargeMessage;
  const text = await res.text().catch(() => '');
  if (!text) return fallback;
  try {
    const data = JSON.parse(text) as { error?: unknown };
    return typeof data?.error === 'string' ? data.error : fallback;
  } catch {
    return fallback;
  }
}
