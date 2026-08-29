// Ops suggestions round: the admin pay page counts door hangers per worker
// (did the work happen, do workers bother logging it). Written under the
// old never-pays rule; the count survives pay-per-photo (2026-08-29)
// because it answers logging volume, not money. Same is_test posture as
// the money math: test rows count for nothing.

import { describe, it, expect } from 'vitest';
import { countDoorHangersByWorker, type AdvertisingPlacement } from './placements';

const row = (over: Partial<AdvertisingPlacement>): AdvertisingPlacement => ({
  id: Math.random().toString(36).slice(2),
  campaignId: 'c1',
  workerId: 'w1',
  kind: 'door_hanger',
  status: 'pending',
  lat: 40.87,
  lng: -73.59,
  accuracyM: null,
  capturedAt: '2026-08-29T12:00:00Z',
  photoPath: 'p.jpg',
  suggestedAddress: null,
  route: null,
  neighborhood: null,
  propertyId: null,
  workerNote: null,
  acceptedRateCents: null,
  rejectionReason: null,
  reviewedBy: null,
  reviewedAt: null,
  isTest: false,
  createdAt: '2026-08-29T12:00:00Z',
  updatedAt: '2026-08-29T12:00:00Z',
  ...over,
});

describe('countDoorHangersByWorker', () => {
  it('counts door hangers per worker across statuses', () => {
    const counts = countDoorHangersByWorker([
      row({ workerId: 'w1' }),
      row({ workerId: 'w1', status: 'accepted' }),
      row({ workerId: 'w2' }),
    ]);
    expect(counts.get('w1')).toBe(2);
    expect(counts.get('w2')).toBe(1);
  });

  it('ignores yard signs and test rows', () => {
    const counts = countDoorHangersByWorker([
      row({ kind: 'yard_sign' }),
      row({ isTest: true }),
    ]);
    expect(counts.size).toBe(0);
  });
});
