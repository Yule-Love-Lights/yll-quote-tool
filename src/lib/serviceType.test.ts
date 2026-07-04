import { describe, it, expect } from 'vitest';
import {
  asServiceType,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  DEFAULT_SERVICE_TYPE,
  visibleServiceTypes,
} from './serviceType';

describe('serviceType', () => {
  it('has the three canonical types with a label each', () => {
    expect(SERVICE_TYPES).toEqual(['holiday', 'permanent', 'event']);
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
  });

  it('asServiceType rejects anything else as null', () => {
    expect(asServiceType('Holiday')).toBeNull(); // case-sensitive
    expect(asServiceType('seasonal')).toBeNull();
    expect(asServiceType('')).toBeNull();
    expect(asServiceType(null)).toBeNull();
    expect(asServiceType(undefined)).toBeNull();
    expect(asServiceType(3)).toBeNull();
  });

  describe('visibleServiceTypes', () => {
    it('hides Event when eventEnabled is off', () => {
      expect(visibleServiceTypes({ eventEnabled: false, current: null })).toEqual([
        'holiday',
        'permanent',
      ]);
    });

    it('shows Event when eventEnabled is on', () => {
      expect(visibleServiceTypes({ eventEnabled: true, current: null })).toEqual([
        'holiday',
        'permanent',
        'event',
      ]);
    });

    it('always shows permanent (not gated) regardless of eventEnabled', () => {
      expect(visibleServiceTypes({ eventEnabled: false, current: null })).toContain('permanent');
    });

    it('still shows Event when editing an already-saved event quote, even if off', () => {
      expect(visibleServiceTypes({ eventEnabled: false, current: 'event' })).toEqual([
        'holiday',
        'permanent',
        'event',
      ]);
    });
  });
});
