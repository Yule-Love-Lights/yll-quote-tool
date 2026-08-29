// Photo-similarity assist on the duplicate flags (Naldo 2026-08-29). Kept in
// its own test file: a concurrent PR owns duplicates.test.ts, and these tests
// only cover the new optional hash signal.

import { describe, expect, it } from 'vitest';

import { findDuplicateCandidates } from './duplicates';
import type { AdvertisingPlacement } from './placements';

let seq = 0;
function placement(overrides: Partial<AdvertisingPlacement> = {}): AdvertisingPlacement {
  return {
    id: `p-${++seq}`,
    campaignId: 'campaign-1',
    workerId: `worker-${seq}`, // distinct workers so same-day never fires here
    kind: 'yard_sign',
    status: 'pending',
    lat: null,
    lng: null,
    accuracyM: null,
    capturedAt: '2026-08-24T15:00:00.000Z',
    photoPath: 'proof.jpg',
    suggestedAddress: null,
    route: null,
    neighborhood: null,
    propertyId: null,
    rejectionReason: null,
    workerNote: null,
    photoHash: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    acceptedRateCents: null,
    reviewedBy: null,
    reviewedAt: null,
    isTest: false,
    createdAt: '2026-08-24T15:00:00.000Z',
    updatedAt: '2026-08-24T15:00:00.000Z',
    ...overrides,
  };
}

describe('photo-similarity duplicate flags', () => {
  it('flags a near-identical photo hash in the same campaign, naming the signal', () => {
    const target = placement({ photoHash: '0f0f0f0f0f0f0f0f' });
    const similar = placement({ photoHash: '0f0f0f0f0f0f0f0e' }); // 1 bit off
    const different = placement({ photoHash: 'f0f0f0f0f0f0f0f0' }); // 64 bits off

    const candidates = findDuplicateCandidates(target, [target, similar, different]);
    expect(candidates.map((c) => c.placement.id)).toEqual([similar.id]);
    expect(candidates[0].reasons.join(' ')).toMatch(/similar photo/i);
  });

  it('no hashes, no signal — null-hash rows behave exactly as before', () => {
    const target = placement();
    const other = placement();
    expect(findDuplicateCandidates(target, [target, other])).toHaveLength(0);
  });

  it('similarity STACKS with the other reasons on one candidate', () => {
    const target = placement({ lat: 40.75, lng: -73.42, photoHash: '0f0f0f0f0f0f0f0f' });
    const near = placement({ lat: 40.7503, lng: -73.42, photoHash: '0f0f0f0f0f0f0f0f' });
    const candidates = findDuplicateCandidates(target, [target, near]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reasons.length).toBeGreaterThanOrEqual(2);
  });
});
