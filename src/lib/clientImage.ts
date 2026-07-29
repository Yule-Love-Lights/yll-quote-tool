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

function readRawDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
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
    const bitmap = await createImageBitmap(file);
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

// Downscale a user-picked photo before it's base64-encoded into an upload
// body. Skips re-encoding for already-small photos. PNGs (screenshots etc.)
// flatten onto JPEG on the resize path — these are house photos, so alpha
// transparency isn't a real concern (decided, #186).
//
// Falls back to the raw file (unresized, original mediaType) if decoding
// fails — some browsers can't decode HEIC straight from a File/Blob — so
// upload still works, just without 413 protection for that rare case.
export async function downscaleForUpload(file: File): Promise<{ dataUrl: string; mediaType: string }> {
  try {
    const img = await decodeImage(file);
    try {
      if (shouldSkipDownscale(file.size, img.width, img.height)) {
        return { dataUrl: await readRawDataUrl(file), mediaType: file.type || 'image/jpeg' };
      }
      const { width, height } = computeTargetDimensions(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');
      img.draw(ctx, width, height);
      return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), mediaType: 'image/jpeg' };
    } finally {
      img.cleanup();
    }
  } catch {
    return { dataUrl: await readRawDataUrl(file), mediaType: file.type || 'image/jpeg' };
  }
}
