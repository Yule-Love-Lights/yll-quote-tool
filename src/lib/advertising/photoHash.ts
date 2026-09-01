// Perceptual photo hashing for duplicate-flag ASSISTANCE (Naldo 2026-08-29).
// dHash over a 9x8 grayscale thumbnail: bit = "pixel brighter than its right
// neighbor", 64 bits, 16 hex chars stored on the placement row
// (photo_hash). Comparison is Hamming distance; the strict threshold keeps
// this a HINT beside the GPS/address/same-day flags, never an auto-verdict —
// duplicate detection is review-time tooling and the human decides.
//
// Hash COMPUTATION from image bytes lives with the upload path (it needs
// sharp to build the 9x8 grayscale); this module is the pure math so the
// money-adjacent flag logic is testable with no image pipeline in the loop.

/** Strict bit-distance threshold: <= 10 of 64 differing bits reads as "the
 * same photo, maybe re-exposed/re-cropped a touch". */
const SIMILAR_MAX_BITS = 10;

/** dHash from a 9x8 row-major grayscale buffer (72 bytes). */
export function dHashFromGray9x8(pixels: Uint8Array): string {
  if (pixels.length !== 72) {
    throw new Error(`dHashFromGray9x8: expected 72 grayscale bytes (9x8), got ${pixels.length}`);
  }
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = pixels[y * 9 + x];
      const right = pixels[y * 9 + x + 1];
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bits++;
      if (bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

const HASH_RE = /^[0-9a-f]{16}$/;

/** Hamming distance between two 16-hex-char hashes (0..64); 64 for garbage
 * input so malformed data can never read as similar. */
export function hammingDistanceHex(a: string, b: string): number {
  if (!HASH_RE.test(a) || !HASH_RE.test(b)) return 64;
  let distance = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/** True when both hashes exist, are well-formed, and sit within the strict
 * similarity threshold. Null/absent hashes are never similar: no signal, no
 * flag. */
export function isSimilarPhotoHash(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return hammingDistanceHex(a, b) <= SIMILAR_MAX_BITS;
}
