// Pure HTTP-failure categorizer for the `approve_error` event's `category`
// property (PostHog Wave 1). Shared by StickyBottomBar (stage: 'approve') and
// DepositCheckout (stage: 'deposit') so both buckets use identical rules.
// NEVER pass the raw error/message into an event property — this only ever
// returns a coarse, non-identifying bucket.

export type ApproveErrorCategory = 'http_4xx' | 'http_5xx' | 'network' | 'unknown';

/**
 * `status` is the HTTP status of a response that was actually received, or
 * undefined when the failure happened before any response came back (a
 * network-level `fetch()` throw). Falls back to inspecting the error's own
 * type for the network case (a blocked/offline `fetch()` throws a
 * `TypeError` in every evergreen browser), and to 'unknown' otherwise.
 */
export function categorizeApproveError(status: number | undefined, err: unknown): ApproveErrorCategory {
  if (typeof status === 'number') {
    if (status >= 500) return 'http_5xx';
    if (status >= 400) return 'http_4xx';
  }
  if (err instanceof TypeError) return 'network';
  return 'unknown';
}
