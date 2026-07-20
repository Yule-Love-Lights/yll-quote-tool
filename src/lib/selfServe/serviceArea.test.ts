import { describe, it, expect } from 'vitest';
import { isServedArea, isPreciseAddress } from './serviceArea';
import { addressComponent } from '@/lib/googleMaps';

describe('isPreciseAddress', () => {
  const rooftop = { locationType: 'ROOFTOP', partialMatch: false, hasStreetAddress: true };

  it('accepts an exact rooftop hit', () => {
    expect(isPreciseAddress(rooftop)).toBe(true);
  });

  it('accepts a range-interpolated hit (between known house numbers on the street)', () => {
    expect(isPreciseAddress({ ...rooftop, locationType: 'RANGE_INTERPOLATED' })).toBe(true);
  });

  it('REGRESSION: rejects the town-centroid fallback that quoted an unlocated house', () => {
    // The exact shape Google returned for "6 Birds Rose, Amityville, NY" in the
    // first live smoke: a valid Suffolk County, but a locality centroid — no
    // street number, APPROXIMATE, partial match. It passed isServedArea, so we
    // imaged the middle of town and priced it.
    expect(
      isPreciseAddress({ locationType: 'APPROXIMATE', partialMatch: true, hasStreetAddress: false }),
    ).toBe(false);
    // ...and it must stay rejected even though its county IS in our service area.
    expect(isServedArea('Suffolk County', 'New York')).toBe(true);
  });

  it('rejects a fuzzy partial match even when it looks like a street address', () => {
    expect(isPreciseAddress({ ...rooftop, partialMatch: true })).toBe(false);
  });

  it('rejects a street/polygon midpoint (GEOMETRIC_CENTER) and a missing street number', () => {
    expect(isPreciseAddress({ ...rooftop, locationType: 'GEOMETRIC_CENTER' })).toBe(false);
    expect(isPreciseAddress({ ...rooftop, hasStreetAddress: false })).toBe(false);
  });

  it('rejects a missing/unknown location type', () => {
    expect(isPreciseAddress({ partialMatch: false, hasStreetAddress: true })).toBe(false);
  });
});

describe('isServedArea', () => {
  it('serves Nassau + Suffolk in New York', () => {
    expect(isServedArea('Nassau County', 'New York')).toBe(true);
    expect(isServedArea('Suffolk County', 'New York')).toBe(true);
  });

  it('is case- and suffix-tolerant', () => {
    expect(isServedArea('nassau county', 'new york')).toBe(true);
    expect(isServedArea('  Suffolk  ', 'New York')).toBe(true); // missing "County" suffix
  });

  it('rejects a served county name in the wrong state (there is a Suffolk County, MA)', () => {
    expect(isServedArea('Suffolk County', 'Massachusetts')).toBe(false);
  });

  it('rejects other NY counties (Queens, Kings) — LI ZIP ranges bleed into NYC', () => {
    expect(isServedArea('Queens County', 'New York')).toBe(false);
    expect(isServedArea('Kings County', 'New York')).toBe(false);
  });

  it('never serves a missing county or state (we do not quote an unplaceable address)', () => {
    expect(isServedArea(undefined, 'New York')).toBe(false);
    expect(isServedArea('Nassau County', undefined)).toBe(false);
    expect(isServedArea('', '')).toBe(false);
  });
});

describe('addressComponent', () => {
  const components = [
    { long_name: '123 Main St', types: ['street_number', 'route'] },
    { long_name: 'Hempstead', types: ['locality', 'political'] },
    { long_name: 'Nassau County', types: ['administrative_area_level_2', 'political'] },
    { long_name: 'New York', types: ['administrative_area_level_1', 'political'] },
  ];

  it('pulls a component by type', () => {
    expect(addressComponent(components, 'administrative_area_level_2')).toBe('Nassau County');
    expect(addressComponent(components, 'administrative_area_level_1')).toBe('New York');
  });

  it('returns undefined for a missing type or bad input', () => {
    expect(addressComponent(components, 'postal_code')).toBeUndefined();
    expect(addressComponent(undefined, 'administrative_area_level_2')).toBeUndefined();
    expect(addressComponent([], 'administrative_area_level_1')).toBeUndefined();
  });
});
