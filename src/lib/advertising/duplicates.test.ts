import { describe, expect, it } from 'vitest';

import { findDuplicateCandidates } from './duplicates';
import type { AdvertisingPlacement } from './placements';

// Duplicate detection is REVIEW-TIME TOOLING for admin, never an automatic
// block (Naldo's ruling, audit doc 8B): several signs can legitimately stand
// near one intersection, so this flags candidates with reasons and lets the
// human decide.

let seq = 0;
function placement(overrides: Partial<AdvertisingPlacement> = {}): AdvertisingPlacement {
  return {
    id: `p-${++seq}`,
    campaignId: 'campaign-1',
    workerId: 'worker-1',
    kind: 'yard_sign',
    status: 'pending',
    lat: 40.75,
    lng: -73.42,
    accuracyM: 8,
    capturedAt: '2026-08-24T15:00:00.000Z',
    photoPath: 'placements/worker-1/x.jpg',
    suggestedAddress: '12 Main St, Farmingdale, NY',
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

describe('findDuplicateCandidates', () => {
  it('flags a nearby GPS point in the same campaign, with the distance in the reason', () => {
    const target = placement();
    // ~33m north of the target (0.0003 deg latitude); different workers so
    // only the distance rule can fire.
    const near = placement({ lat: 40.7503, suggestedAddress: null, workerId: 'worker-2' });
    const far = placement({ lat: 40.76, suggestedAddress: null, workerId: 'worker-3' }); // ~1.1km away

    const candidates = findDuplicateCandidates(target, [target, near, far]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].placement.id).toBe(near.id);
    expect(candidates[0].reasons.join(' ')).toMatch(/\d+m/);
  });

  it('flags an identical suggested address even when GPS differs', () => {
    const target = placement();
    const sameAddress = placement({ lat: 40.9, lng: -73.1, suggestedAddress: ' 12 MAIN ST, Farmingdale, NY ' });

    const candidates = findDuplicateCandidates(target, [target, sameAddress]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reasons.join(' ')).toMatch(/address/i);
  });

  it('flags the same worker submitting again on the same ET day, even far apart', () => {
    const target = placement({ capturedAt: '2026-08-24T15:00:00.000Z' });
    const sameDay = placement({
      lat: 40.9,
      lng: -73.1,
      suggestedAddress: null,
      capturedAt: '2026-08-24T22:00:00.000Z',
    });
    const otherDay = placement({
      lat: 40.9,
      lng: -73.1,
      suggestedAddress: null,
      capturedAt: '2026-08-25T15:00:00.000Z',
      workerId: 'worker-1',
    });

    const candidates = findDuplicateCandidates(target, [target, sameDay, otherDay]);
    expect(candidates.map((c) => c.placement.id)).toEqual([sameDay.id]);
    expect(candidates[0].reasons.join(' ')).toMatch(/same day/i);
  });

  it('never crosses campaigns, never flags the target itself, and never crosses the test/real line', () => {
    const target = placement();
    const otherCampaign = placement({ campaignId: 'campaign-2' });
    const testRow = placement({ isTest: true });

    expect(findDuplicateCandidates(target, [target, otherCampaign, testRow])).toHaveLength(0);

    // Test fixtures DO flag against each other, so a device check with
    // seeded test rows still demonstrates the feature.
    const testTarget = placement({ isTest: true });
    const testNear = placement({ isTest: true, lat: 40.7503, workerId: 'worker-2', suggestedAddress: null });
    const real = placement();
    const testFlags = findDuplicateCandidates(testTarget, [testTarget, testNear, real]);
    expect(testFlags.map((c) => c.placement.id)).toEqual([testNear.id]);
  });

  it('collects MULTIPLE reasons on one candidate', () => {
    const target = placement();
    const both = placement({ lat: 40.7503 }); // near AND same address AND same worker/day

    const candidates = findDuplicateCandidates(target, [target, both]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('handles placements with no GPS or no address without throwing', () => {
    const target = placement({ lat: null, lng: null, suggestedAddress: null, capturedAt: null });
    const other = placement({ suggestedAddress: null });
    expect(findDuplicateCandidates(target, [target, other]).length).toBeGreaterThanOrEqual(0);
  });
});
