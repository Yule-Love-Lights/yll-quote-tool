import { describe, it, expect } from 'vitest';
import { bearingDegrees, compassLabel, relabelPermanentSides } from './orientation';
import type { PermanentSatelliteLines } from './photoAnalysis';

describe('bearingDegrees (S25 orientation)', () => {
  const house = { lat: 40.1, lng: -74.1 };
  it('cardinal directions', () => {
    expect(bearingDegrees(house, { lat: 40.101, lng: -74.1 })).toBeCloseTo(0, 3); // north
    expect(bearingDegrees(house, { lat: 40.1, lng: -74.099 })).toBeCloseTo(90, 3); // east
    expect(bearingDegrees(house, { lat: 40.099, lng: -74.1 })).toBeCloseTo(180, 3); // south
    expect(bearingDegrees(house, { lat: 40.1, lng: -74.101 })).toBeCloseTo(270, 3); // west
  });
  it('diagonal accounts for longitude compression at latitude', () => {
    // Equal degree deltas are NOT 45° off-equator: Δlng shrinks by cos(lat).
    const b = bearingDegrees(house, { lat: 40.101, lng: -74.099 });
    expect(b).toBeGreaterThan(30);
    expect(b).toBeLessThan(45);
    expect(b).toBeCloseTo((Math.atan2(Math.cos((40.1005 * Math.PI) / 180), 1) * 180) / Math.PI, 2);
  });
});

describe('compassLabel', () => {
  it('maps the 8 winds', () => {
    expect(compassLabel(0)).toBe('north');
    expect(compassLabel(45)).toBe('north-east');
    expect(compassLabel(90)).toBe('east');
    expect(compassLabel(180)).toBe('south');
    expect(compassLabel(225)).toBe('south-west');
    expect(compassLabel(315)).toBe('north-west');
    expect(compassLabel(359)).toBe('north'); // wraps
  });
});

describe('relabelPermanentSides', () => {
  // A unit-square house in normalized satellite coords (y down, north-up image).
  const northEdge = [{ points: [[0.2, 0.2], [0.8, 0.2]] as [number, number][], label: 'n' }];
  const southEdge = [{ points: [[0.2, 0.8], [0.8, 0.8]] as [number, number][], label: 's' }];
  const westEdge = [{ points: [[0.2, 0.2], [0.2, 0.8]] as [number, number][], label: 'w' }];
  const eastEdge = [{ points: [[0.8, 0.2], [0.8, 0.8]] as [number, number][], label: 'e' }];

  // Left/right convention (Jason, S25 device round): standing AT THE HOUSE
  // facing the street — the homeowner's left hand = "left".

  it('fixes the S25 device-round mirror (6 Birch Road): road NORTH, left must be the WEST edge', () => {
    // frontBearing=0 (camera due north): front=north edge; facing the street
    // (north), the homeowner's left hand points WEST. The input carries the
    // road-viewer mirror the first cut of this fix produced (left=east).
    const mirrored: PermanentSatelliteLines = {
      front: northEdge,
      back: southEdge,
      left: eastEdge,
      right: westEdge,
    };
    const out = relabelPermanentSides(mirrored, 0);
    expect(out.front).toBe(northEdge);
    expect(out.back).toBe(southEdge);
    expect(out.left).toBe(westEdge);
    expect(out.right).toBe(eastEdge);
  });

  it("fixes the original S25 failure: AI flipped 180° (front↔back), road SOUTH of house", () => {
    // frontBearing=180: front=south edge; facing the street (south), the
    // homeowner's left hand points EAST.
    const aiFlipped: PermanentSatelliteLines = {
      front: northEdge,
      back: southEdge,
      left: westEdge,
      right: eastEdge,
    };
    const out = relabelPermanentSides(aiFlipped, 180);
    expect(out.front).toBe(southEdge);
    expect(out.back).toBe(northEdge);
    expect(out.left).toBe(eastEdge);
    expect(out.right).toBe(westEdge);
  });

  it('returns the SAME object when the AI labels already match the bearing', () => {
    const correct: PermanentSatelliteLines = {
      front: southEdge,
      back: northEdge,
      left: eastEdge,
      right: westEdge,
    };
    expect(relabelPermanentSides(correct, 180)).toBe(correct);
  });

  it('road EAST of house (bearing 90): front=east edge, left=north edge', () => {
    // Facing the street (east), the homeowner's left hand points north.
    const mislabeled: PermanentSatelliteLines = {
      front: northEdge,
      back: southEdge,
      left: eastEdge,
      right: westEdge,
    };
    const out = relabelPermanentSides(mislabeled, 90);
    expect(out.front).toBe(eastEdge);
    expect(out.back).toBe(westEdge);
    expect(out.left).toBe(northEdge);
    expect(out.right).toBe(southEdge);
  });

  it('relabels with a missing side (3 channels) — empty channel stays empty', () => {
    const threeSides: PermanentSatelliteLines = {
      front: northEdge,
      back: [],
      left: eastEdge,
      right: westEdge,
    };
    const out = relabelPermanentSides(threeSides, 180);
    expect(out.back).toBe(northEdge);
    expect(out.left).toBe(eastEdge);
    expect(out.right).toBe(westEdge);
    expect(out.front).toEqual([]);
  });

  it('fewer than 2 non-empty channels → no-op (nothing to disambiguate against)', () => {
    const oneSide: PermanentSatelliteLines = { front: northEdge, back: [], left: [], right: [] };
    expect(relabelPermanentSides(oneSide, 180)).toBe(oneSide);
  });

  it('polylines move buckets byte-identical — never mutated', () => {
    const aiFlipped: PermanentSatelliteLines = {
      front: northEdge,
      back: southEdge,
      left: eastEdge,
      right: westEdge,
    };
    const out = relabelPermanentSides(aiFlipped, 180);
    // Same array references, only re-bucketed.
    expect(out.back).toBe(northEdge);
    expect(northEdge[0].points).toEqual([[0.2, 0.2], [0.8, 0.2]]);
  });
});
