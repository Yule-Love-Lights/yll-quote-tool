// Pure inbox lifecycle decisions (#58 v3) — bucketing, staleness, reverse-inverse,
// threshold clamp. No I/O; the store + routes apply these.
import type { InboxStatus } from './types';

export type Bucket = 'needs_reply' | 'awaiting_reply' | 'handled' | 'completed' | 'dismissed';

export function bucketOf(item: { status: InboxStatus; followedUpAt: string | null }): Bucket {
  if (item.status === 'dismissed') return 'dismissed';
  if (item.status === 'completed') return 'completed';
  if (item.followedUpAt) return 'awaiting_reply';
  if (item.status === 'handled') return 'handled';
  return 'needs_reply';
}

/** The buckets any store.ts query actually filters BY. 'completed'/'dismissed'
 *  items are only ever read/updated by id (never listed by bucket), so they're
 *  intentionally excluded — see applyBucketFilter's doc comment. */
export type QueryBucket = Extract<Bucket, 'needs_reply' | 'awaiting_reply' | 'handled'>;

/**
 * #252 slice C: applies bucketOf()'s status/followed_up_at logic as a DB-level
 * Supabase filter chain, so a bucket's definition lives in exactly one place.
 * Before this, listOpenItems, listInWorks (both its awaiting + handled
 * queries), and listEscalatableItems each hand-rolled their own .eq/.is/.not
 * chain independently of bucketOf and of each other — nothing kept them in
 * sync. lifecycle.test.ts's "applyBucketFilter — DB predicate matches
 * bucketOf" describe block is the proof: it enumerates every (status ×
 * followed_up_at null/non-null) combination and asserts, for every bucket,
 * that this predicate admits a row iff bucketOf assigns that row to that
 * bucket.
 *
 * Untyped in/out: this repo's SupabaseClient carries no Database generic (see
 * store.ts's `as unknown as` casts on every query result), so this accepts
 * anything exposing eq/is/not and returns the same (chained) object — callers
 * can keep chaining their own additional filters (e.g. listEscalatableItems'
 * lead_kind .or(...)) straight off the return value.
 */
export function applyBucketFilter<
  Q extends {
    eq: (column: string, value: unknown) => Q;
    is: (column: string, value: unknown) => Q;
    not: (column: string, operator: string, value: unknown) => Q;
  },
>(query: Q, bucket: QueryBucket): Q {
  switch (bucket) {
    case 'needs_reply':
      return query.eq('status', 'unresponded').is('followed_up_at', null);
    case 'awaiting_reply':
      return query.not('followed_up_at', 'is', null).not('status', 'in', '(completed,dismissed)');
    case 'handled':
      return query.eq('status', 'handled').is('followed_up_at', null);
  }
}

export function isStale(lastActivityIso: string | null, days: number, now: Date): boolean {
  if (!lastActivityIso) return false;
  return now.getTime() - new Date(lastActivityIso).getTime() > days * 86_400_000;
}

export type ReverseAction = 'handled' | 'followed' | 'completed' | 'dismissed' | 'reclassified';
export type ReverseTarget = { status: InboxStatus | null; clearFollowed: boolean; setFollowed: boolean; unsuppress: boolean };

export function inverseOf(action: ReverseAction, from?: { status?: InboxStatus; wasFollowed?: boolean }): ReverseTarget {
  switch (action) {
    case 'dismissed':
      return { status: from?.status ?? 'unresponded', clearFollowed: false, setFollowed: false, unsuppress: true };
    case 'completed':
      // Restore the prior bucket: if it was awaiting-reply (followed) before being
      // completed, re-set the follow flag so the reverse returns it to that group.
      return { status: from?.status ?? 'handled', clearFollowed: false, setFollowed: !!from?.wasFollowed, unsuppress: false };
    case 'handled':
      return { status: 'unresponded', clearFollowed: false, setFollowed: false, unsuppress: false };
    case 'followed':
    // row 312: the S41 'reclassified' data op only ever SET followed_up_at (to
    // quote_sent_at) on an already-handled row — it never touched status — so
    // its inverse is identical to 'followed': clear the flag, leave status
    // alone. No detail.from restore needed; the audit rows' own wording
    // ("reversible by setting followed_up_at back to null") already says this.
    case 'reclassified':
      return { status: null, clearFollowed: true, setFollowed: false, unsuppress: false };
  }
}

export function clampFollowUpDays(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.min(60, Math.max(1, Math.round(v)));
}
