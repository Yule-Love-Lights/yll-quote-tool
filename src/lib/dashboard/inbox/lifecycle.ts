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

export function isStale(lastActivityIso: string | null, days: number, now: Date): boolean {
  if (!lastActivityIso) return false;
  return now.getTime() - new Date(lastActivityIso).getTime() > days * 86_400_000;
}

export type ReverseAction = 'handled' | 'followed' | 'completed' | 'dismissed';
export type ReverseTarget = { status: InboxStatus | null; clearFollowed: boolean; unsuppress: boolean };

export function inverseOf(action: ReverseAction, from?: { status?: InboxStatus; wasFollowed?: boolean }): ReverseTarget {
  switch (action) {
    case 'dismissed':
      return { status: from?.status ?? 'unresponded', clearFollowed: false, unsuppress: true };
    case 'completed':
      return { status: from?.status ?? 'handled', clearFollowed: false, unsuppress: false };
    case 'handled':
      return { status: 'unresponded', clearFollowed: false, unsuppress: false };
    case 'followed':
      return { status: null, clearFollowed: true, unsuppress: false };
  }
}

export function clampFollowUpDays(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.min(60, Math.max(1, Math.round(v)));
}
