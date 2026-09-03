import { dHashFromGray9x8 } from '@/lib/advertising/photoHash';

// The sharp-dependent half of photo hashing, separated from photoHash.ts so
// the pure math stays testable with no image pipeline in the loop. Server
// only (sharp), imported by the capture pipeline. BEST-EFFORT: any failure
// returns null — a capture must never fail over a hash, and a null hash
// simply carries no similarity signal.

export async function computePhotoHash(bytes: Buffer): Promise<string | null> {
  try {
    const sharp = (await import('sharp')).default;
    const raw = await sharp(bytes)
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();
    if (raw.length !== 72) return null;
    return dHashFromGray9x8(new Uint8Array(raw));
  } catch (error) {
    console.error('computePhotoHash failed (hash skipped):', error instanceof Error ? error.message : error);
    return null;
  }
}
