// Shared security helpers.
//
// Audit fix: admin / webhook shared-secret checks used `provided !== expected`,
// a content-dependent comparison whose runtime can leak a timing side-channel.
// `safeEqual` does a constant-time compare for equal-length inputs. A length
// mismatch short-circuits (the length of a 256-bit hex secret isn't itself
// secret), which is acceptable per the audit.

import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string equality for shared-secret comparisons.
 * Returns false for any missing input or length mismatch; otherwise compares
 * the bytes in constant time so the work done doesn't depend on how many
 * leading characters happen to match.
 */
export function safeEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
