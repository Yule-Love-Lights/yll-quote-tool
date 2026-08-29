import type { AdvertisingPlacement } from '@/lib/advertising/placements';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';

// Review-time duplicate detection (Naldo's ruling, audit doc 8B): FLAG
// candidates for the human, never auto-block — several signs can
// legitimately stand near one intersection. Candidates are scoped to the
// SAME CAMPAIGN and flagged for any of: a nearby GPS point, the identical
// suggested address, or the same worker submitting again on the same ET day.

export type DuplicateCandidate = {
  placement: AdvertisingPlacement;
  reasons: string[];
};

const NEARBY_METERS = 75;

/** Haversine distance in meters. */
export function distanceMeters(latA: number, lngA: number, latB: number, lngB: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLng = toRad(lngB - lngA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalizeAddress(address: string | null): string | null {
  if (!address) return null;
  const normalized = address.toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

export function findDuplicateCandidates(
  target: AdvertisingPlacement,
  all: AdvertisingPlacement[],
): DuplicateCandidate[] {
  const targetAddress = normalizeAddress(target.suggestedAddress);
  const targetDay = target.capturedAt ? etDayKey(new Date(target.capturedAt)) : null;

  const out: DuplicateCandidate[] = [];
  for (const p of all) {
    if (p.id === target.id) continue;
    // Same population only: test fixtures flag against each other (so a
    // device check sees the feature) but never against real placements.
    if (p.isTest !== target.isTest) continue;
    if (p.campaignId !== target.campaignId) continue;

    const reasons: string[] = [];

    if (
      target.lat !== null && target.lng !== null &&
      p.lat !== null && p.lng !== null
    ) {
      const d = distanceMeters(target.lat, target.lng, p.lat, p.lng);
      if (d <= NEARBY_METERS) reasons.push(`${Math.round(d)}m away`);
    }

    const pAddress = normalizeAddress(p.suggestedAddress);
    if (targetAddress && pAddress && targetAddress === pAddress) {
      reasons.push('same suggested address');
    }

    if (
      targetDay &&
      p.workerId === target.workerId &&
      p.capturedAt &&
      etDayKey(new Date(p.capturedAt)) === targetDay
    ) {
      reasons.push('same worker, same day');
    }

    if (reasons.length > 0) out.push({ placement: p, reasons });
  }
  return out;
}
