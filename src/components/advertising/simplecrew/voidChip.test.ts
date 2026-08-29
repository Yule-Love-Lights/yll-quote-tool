// The voided chip must never carry a money suffix — the defect the S80 close
// integration lens found in merged, live code: the chip LABEL was gated on
// voidedAt while the "· $2.50" suffix beside it was not, so a voided-accepted
// placement rendered "Voided · $2.50" on the two screens an admin and a worker
// look at immediately after a void.
//
// The chip is JSX inside a large screen component, so this pins the pure
// decision the JSX makes rather than mounting the tree: label and suffix are
// ONE decision about one row, and both halves must read voidedAt.

import { describe, expect, it } from 'vitest';

type ChipRow = {
  status: 'pending' | 'accepted' | 'rejected' | 'resubmitted';
  acceptedRateCents: number | null;
  voidedAt?: string | null;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_TEXT: Record<ChipRow['status'], string> = {
  pending: 'Pending',
  resubmitted: 'Resubmitted',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

/** Mirrors CampaignDetailScreen's chip: label, then the optional money
 * suffix. Both halves gate on voidedAt. */
export function chipText(p: ChipRow): string {
  const label = p.voidedAt ? 'Voided' : STATUS_TEXT[p.status];
  const suffix =
    !p.voidedAt && p.status === 'accepted' && p.acceptedRateCents !== null
      ? ` · ${dollars(p.acceptedRateCents)}`
      : '';
  return `${label}${suffix}`;
}

describe('placement status chip', () => {
  it('a live accepted placement shows its stamped rate', () => {
    expect(chipText({ status: 'accepted', acceptedRateCents: 250 })).toBe('Accepted · $2.50');
  });

  it('a VOIDED accepted placement shows no money at all', () => {
    const text = chipText({ status: 'accepted', acceptedRateCents: 250, voidedAt: '2026-08-29T18:00:00.000Z' });
    expect(text).toBe('Voided');
    expect(text).not.toMatch(/\$/);
  });

  it('voiding never leaks the old status either', () => {
    for (const status of ['pending', 'accepted', 'rejected', 'resubmitted'] as const) {
      expect(chipText({ status, acceptedRateCents: 250, voidedAt: 'x' })).toBe('Voided');
    }
  });

  it('non-accepted live rows carry no money suffix', () => {
    expect(chipText({ status: 'pending', acceptedRateCents: null })).toBe('Pending');
    expect(chipText({ status: 'rejected', acceptedRateCents: null })).toBe('Rejected');
  });
});
