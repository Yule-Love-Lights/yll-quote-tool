import { describe, it, expect } from 'vitest';
import { leadServiceToQuoteServiceType } from './leadServiceVocab';

describe('leadServiceToQuoteServiceType', () => {
  it('maps christmas to holiday', () => {
    expect(leadServiceToQuoteServiceType('christmas')).toBe('holiday');
  });

  it('maps permanent to permanent', () => {
    expect(leadServiceToQuoteServiceType('permanent')).toBe('permanent');
  });

  it('maps event-wedding to event', () => {
    expect(leadServiceToQuoteServiceType('event-wedding')).toBe('event');
  });

  it('maps landscape to permanent_bistro', () => {
    expect(leadServiceToQuoteServiceType('landscape')).toBe('permanent_bistro');
  });

  it('returns null for an unrecognized service string', () => {
    expect(leadServiceToQuoteServiceType('not-a-real-service')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(leadServiceToQuoteServiceType('')).toBeNull();
  });
});
