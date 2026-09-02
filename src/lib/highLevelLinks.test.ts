// Tests for the one place that knows the shape of a HighLevel contact URL.
// The point of this module is that the shape is stated once, so these tests
// pin the shape itself, not just that a string comes back.

import { describe, it, expect, afterEach } from 'vitest';
import { highLevelContactUrl, highLevelContactUrlFromEnv, highLevelLocationId } from './highLevelLinks';

const ORIGINAL = process.env.HIGHLEVEL_LOCATION_ID;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.HIGHLEVEL_LOCATION_ID;
  else process.env.HIGHLEVEL_LOCATION_ID = ORIGINAL;
});

describe('highLevelContactUrl', () => {
  it('builds the v2 location contact detail URL both existing call sites used', () => {
    expect(highLevelContactUrl('loc-123', 'contact-abc')).toBe(
      'https://app.gohighlevel.com/v2/location/loc-123/contacts/detail/contact-abc',
    );
  });

  it('percent-encodes the contact id so a stray character cannot break out of the path', () => {
    expect(highLevelContactUrl('loc-123', 'a/b?c')).toBe(
      'https://app.gohighlevel.com/v2/location/loc-123/contacts/detail/a%2Fb%3Fc',
    );
  });
});

describe('highLevelContactUrlFromEnv', () => {
  it('builds the URL from the configured location id', () => {
    process.env.HIGHLEVEL_LOCATION_ID = 'loc-env';
    expect(highLevelContactUrlFromEnv('c-1')).toBe(
      'https://app.gohighlevel.com/v2/location/loc-env/contacts/detail/c-1',
    );
  });

  it('returns null when the environment has no location id, rather than a broken URL', () => {
    delete process.env.HIGHLEVEL_LOCATION_ID;
    expect(highLevelLocationId()).toBeNull();
    expect(highLevelContactUrlFromEnv('c-1')).toBeNull();
  });

  it('returns null for a null contact id even when the location id is configured', () => {
    process.env.HIGHLEVEL_LOCATION_ID = 'loc-env';
    expect(highLevelContactUrlFromEnv(null)).toBeNull();
  });
});
