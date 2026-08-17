import { describe, it, expect } from 'vitest';
import {
  asServiceType,
  canCustomerRecolor,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  DEFAULT_SERVICE_TYPE,
} from './serviceType';

describe('serviceType', () => {
  it('has the four canonical types with a label each', () => {
    expect(SERVICE_TYPES).toEqual(['holiday', 'permanent', 'event', 'permanent_bistro']);
    for (const t of SERVICE_TYPES) {
      expect(SERVICE_TYPE_LABELS[t]).toBeTruthy();
    }
  });

  it('defaults to holiday (matches the migration backfill)', () => {
    expect(DEFAULT_SERVICE_TYPE).toBe('holiday');
  });

  it('asServiceType accepts the valid values', () => {
    expect(asServiceType('holiday')).toBe('holiday');
    expect(asServiceType('permanent')).toBe('permanent');
    expect(asServiceType('event')).toBe('event');
    expect(asServiceType('permanent_bistro')).toBe('permanent_bistro');
  });

  it('asServiceType rejects anything else as null', () => {
    expect(asServiceType('Holiday')).toBeNull(); // case-sensitive
    expect(asServiceType('seasonal')).toBeNull();
    expect(asServiceType('')).toBeNull();
    expect(asServiceType(null)).toBeNull();
    expect(asServiceType(undefined)).toBeNull();
    expect(asServiceType(3)).toBeNull();
  });

  // #245: single source of truth for the LightColorPicker gate + DesignReprise's
  // "Click here to change colors" jump-button — the two must never drift apart.
  it('canCustomerRecolor allows holiday, permanent, event, and null/undefined', () => {
    expect(canCustomerRecolor('holiday')).toBe(true);
    expect(canCustomerRecolor('permanent')).toBe(true);
    expect(canCustomerRecolor('event')).toBe(true);
    expect(canCustomerRecolor(null)).toBe(true);
    expect(canCustomerRecolor(undefined)).toBe(true);
  });

  it('canCustomerRecolor excludes permanent_bistro (warm-white Edison only)', () => {
    expect(canCustomerRecolor('permanent_bistro')).toBe(false);
  });
});
