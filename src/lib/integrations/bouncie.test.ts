import { describe, it, expect } from 'vitest';
import { verifyBouncieSecret, bodyHash, parseBouncieEvent, isBouncieWebhookConfigured } from './bouncie';

describe('verifyBouncieSecret', () => {
  const secret = 'a-long-shared-secret-value';

  it('accepts the value in the Authorization header', () => {
    expect(verifyBouncieSecret(secret, null, secret)).toBe(true);
  });

  it('accepts the value in X-Bouncie-Authorization, for platforms that strip Authorization', () => {
    expect(verifyBouncieSecret(null, secret, secret)).toBe(true);
  });

  it('rejects a wrong value in both headers', () => {
    expect(verifyBouncieSecret('nope', 'nope', secret)).toBe(false);
  });

  it('rejects when neither header is present', () => {
    expect(verifyBouncieSecret(null, null, secret)).toBe(false);
  });

  it('FAILS CLOSED when no secret is configured, even if a header is sent', () => {
    // An unset BOUNCIE_WEBHOOK_SECRET must never mean "accept everything".
    expect(verifyBouncieSecret('anything', 'anything', undefined)).toBe(false);
    expect(verifyBouncieSecret(null, null, undefined)).toBe(false);
  });

  it('does not accept a prefix or a superstring of the secret', () => {
    expect(verifyBouncieSecret(secret.slice(0, -1), null, secret)).toBe(false);
    expect(verifyBouncieSecret(`${secret}x`, null, secret)).toBe(false);
  });

  it('does not accept a Bearer-prefixed value (Bouncie sends the bare key)', () => {
    expect(verifyBouncieSecret(`Bearer ${secret}`, null, secret)).toBe(false);
  });
});

describe('isBouncieWebhookConfigured', () => {
  it('follows the env var', () => {
    const prev = process.env.BOUNCIE_WEBHOOK_SECRET;
    try {
      delete process.env.BOUNCIE_WEBHOOK_SECRET;
      expect(isBouncieWebhookConfigured()).toBe(false);
      process.env.BOUNCIE_WEBHOOK_SECRET = 'x';
      expect(isBouncieWebhookConfigured()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BOUNCIE_WEBHOOK_SECRET;
      else process.env.BOUNCIE_WEBHOOK_SECRET = prev;
    }
  });
});

describe('bodyHash', () => {
  it('is stable for identical bodies, so a redelivery collapses', () => {
    const body = '{"eventType":"tripStart"}';
    expect(bodyHash(body)).toBe(bodyHash(body));
  });

  it('differs for bodies that differ by one character', () => {
    expect(bodyHash('{"a":1}')).not.toBe(bodyHash('{"a":2}'));
  });
});

describe('parseBouncieEvent', () => {
  it('reads the shared fields every event carries', () => {
    const facts = parseBouncieEvent({
      eventType: 'tripStart',
      imei: '123456789012345',
      vin: '1HGBIQOJXMN109186',
      transactionId: '123456789012345-1735920000-202501',
      start: { timestamp: '2026-08-26T13:00:00.000Z', timeZone: 'America/New_York', odometer: 45678.9 },
    });
    expect(facts).toMatchObject({
      eventType: 'tripStart',
      imei: '123456789012345',
      vin: '1HGBIQOJXMN109186',
      transactionId: '123456789012345-1735920000-202501',
      occurredAt: '2026-08-26T13:00:00.000Z',
    });
  });

  it('reads tripEnd from end.timestamp', () => {
    expect(
      parseBouncieEvent({ eventType: 'tripEnd', end: { timestamp: '2026-08-26T14:30:00.000Z' } }).occurredAt,
    ).toBe('2026-08-26T14:30:00.000Z');
  });

  it('reads a geozone event from geozone.timestamp', () => {
    expect(
      parseBouncieEvent({
        eventType: 'applicationGeozone',
        geozone: {
          id: '65f8a2b4c9d7e1234567890a',
          name: '12 Elm St',
          event: 'ENTER',
          timestamp: '2026-08-26T13:45:00.000Z',
          location: { lat: 40.7, lon: -73.5, heading: 90 },
        },
      }).occurredAt,
    ).toBe('2026-08-26T13:45:00.000Z');
  });

  it('takes the FRESHEST point from a tripData batch, not the first', () => {
    // A staleness check cares about the newest point in the batch.
    expect(
      parseBouncieEvent({
        eventType: 'tripData',
        data: [
          { timestamp: '2026-08-26T13:00:00.000Z', gps: { lat: 40.7, lon: -73.5, heading: 90 } },
          { timestamp: '2026-08-26T13:05:00.000Z', gps: { lat: 40.71, lon: -73.51, heading: 91 } },
        ],
      }).occurredAt,
    ).toBe('2026-08-26T13:05:00.000Z');
  });

  it('skips a trailing point with no usable timestamp and keeps scanning back', () => {
    expect(
      parseBouncieEvent({
        eventType: 'tripData',
        data: [{ timestamp: '2026-08-26T13:00:00.000Z' }, { gps: { lat: 1, lon: 2, heading: 3 } }],
      }).occurredAt,
    ).toBe('2026-08-26T13:00:00.000Z');
  });

  // The point of this phase: a payload that does not match the spec must still
  // be readable for whatever it does carry, and must never throw.
  describe('tolerates anything', () => {
    it('returns empty facts rather than throwing on junk', () => {
      expect(parseBouncieEvent(null)).toEqual({});
      expect(parseBouncieEvent(undefined)).toEqual({});
      expect(parseBouncieEvent('a string')).toEqual({});
      expect(parseBouncieEvent(42)).toEqual({});
      expect(parseBouncieEvent([])).toEqual({});
    });

    it('keeps the fields it can read when others are missing or wrong-typed', () => {
      const facts = parseBouncieEvent({ eventType: 'tripStart', imei: 12345, vin: '  ', transactionId: 'tx-1' });
      expect(facts.eventType).toBe('tripStart');
      expect(facts.transactionId).toBe('tx-1');
      expect(facts.imei).toBeUndefined(); // a number, not the documented string
      expect(facts.vin).toBeUndefined(); // whitespace only
    });

    it('ignores an unparseable timestamp instead of storing an invalid date', () => {
      expect(parseBouncieEvent({ eventType: 'tripStart', start: { timestamp: 'not a date' } }).occurredAt)
        .toBeUndefined();
    });

    it('reads an unknown event type through, so a new event is captured not dropped', () => {
      expect(parseBouncieEvent({ eventType: 'somethingNew', imei: '1' }).eventType).toBe('somethingNew');
    });
  });
});
