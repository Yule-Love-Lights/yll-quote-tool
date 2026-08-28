import { describe, it, expect } from 'vitest';
import { geofenceAnchorRefusal } from './geofenceAnchor';
import { isPreciseAddress, isServedArea } from './selfServe/serviceArea';

describe('geofenceAnchorRefusal', () => {
  const rooftopOnLongIsland = {
    locationType: 'ROOFTOP',
    partialMatch: false,
    hasStreetAddress: true,
    county: 'Suffolk County',
    state: 'New York',
  };

  it('accepts a confirmed rooftop hit inside the service area', () => {
    expect(geofenceAnchorRefusal(rooftopOnLongIsland)).toBeNull();
  });

  it('accepts a Nassau County rooftop too', () => {
    expect(geofenceAnchorRefusal({ ...rooftopOnLongIsland, county: 'Nassau County' })).toBeNull();
  });

  it('refuses a fuzzy match', () => {
    expect(geofenceAnchorRefusal({ ...rooftopOnLongIsland, partialMatch: true })).toMatch(/partial_match/);
  });

  it('refuses a result with no street_number + route', () => {
    expect(geofenceAnchorRefusal({ ...rooftopOnLongIsland, hasStreetAddress: false })).toMatch(
      /no street_number/,
    );
  });

  it('refuses the town-centroid fallback', () => {
    expect(
      geofenceAnchorRefusal({
        ...rooftopOnLongIsland,
        locationType: 'APPROXIMATE',
        partialMatch: true,
        hasStreetAddress: false,
      }),
    ).not.toBeNull();
  });

  it('refuses GEOMETRIC_CENTER (a street midpoint, not a house)', () => {
    expect(geofenceAnchorRefusal({ ...rooftopOnLongIsland, locationType: 'GEOMETRIC_CENTER' })).toMatch(
      /not a confirmed rooftop/,
    );
  });

  it('refuses a missing location_type rather than defaulting to accept', () => {
    expect(geofenceAnchorRefusal({ ...rooftopOnLongIsland, locationType: undefined })).toMatch(
      /not a confirmed rooftop/,
    );
  });

  // The two defects the 2026-08-25 dry run over the real properties table found.
  // Both produced a coordinate that LOOKED clean: valid numbers, real street,
  // partial_match false. Shape-only validation cannot catch either one.
  describe('REGRESSION: defects found by the first live dry run', () => {
    it('refuses RANGE_INTERPOLATED, which resolved to the wrong TOWN five times out of five', () => {
      // "30 Wagon Ln, Smithtown, NY 11787" came back as
      // "30 Wagon Ln S, Centereach, NY 11720" — different town, different ZIP,
      // still Suffolk County, and partial_match FALSE so nothing flagged it.
      const wrongTown = {
        ...rooftopOnLongIsland,
        locationType: 'RANGE_INTERPOLATED',
      };
      expect(geofenceAnchorRefusal(wrongTown)).toMatch(/not a confirmed rooftop/);

      // ...and it must stay refused even though the estimator's looser gate,
      // which is correct for ITS job of photographing a house, accepts it.
      expect(isPreciseAddress(wrongTown)).toBe(true);
    });

    it('refuses a precise hit in the wrong STATE', () => {
      // "7 COUNTRY LAKE CT" — a row with no town or state stored — resolved to
      // "7 Country Lake Ct, St Peters, MO 63376". Real street number, real route,
      // partial_match false. Only a plausibility check catches this.
      const missouri = {
        locationType: 'ROOFTOP',
        partialMatch: false,
        hasStreetAddress: true,
        county: 'St. Charles County',
        state: 'Missouri',
      };
      expect(geofenceAnchorRefusal(missouri)).toMatch(/outside the service area/);
      expect(geofenceAnchorRefusal(missouri)).toContain('Missouri');
      expect(isServedArea(missouri.county, missouri.state)).toBe(false);
    });

    it('refuses when Google returns no county or state at all', () => {
      const noRegion = {
        locationType: 'ROOFTOP',
        partialMatch: false,
        hasStreetAddress: true,
        county: undefined,
        state: undefined,
      };
      expect(geofenceAnchorRefusal(noRegion)).toMatch(/outside the service area/);
    });
  });
});
