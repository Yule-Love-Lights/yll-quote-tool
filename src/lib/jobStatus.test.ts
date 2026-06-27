import { describe, it, expect } from 'vitest';
import { JOB_STATUSES, canTransition, asJobStatus, type JobStatus } from './jobStatus';

describe('JOB_STATUSES', () => {
  it('mirrors the SPEC §3 billing lifecycle set', () => {
    expect(JOB_STATUSES).toEqual([
      'to_schedule',
      'scheduled',
      'installed',
      'requires_invoicing',
      'done',
      'cancelled',
    ]);
  });
});

describe('canTransition', () => {
  it('allows the forward lifecycle steps', () => {
    expect(canTransition('to_schedule', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'installed')).toBe(true);
    expect(canTransition('installed', 'requires_invoicing')).toBe(true);
    expect(canTransition('requires_invoicing', 'done')).toBe(true);
  });

  it('allows cancelling from any non-terminal state', () => {
    expect(canTransition('to_schedule', 'cancelled')).toBe(true);
    expect(canTransition('scheduled', 'cancelled')).toBe(true);
    expect(canTransition('installed', 'cancelled')).toBe(true);
    expect(canTransition('requires_invoicing', 'cancelled')).toBe(true);
  });

  it('rejects backward / skipping transitions', () => {
    expect(canTransition('scheduled', 'to_schedule')).toBe(false);
    expect(canTransition('to_schedule', 'requires_invoicing')).toBe(false);
    expect(canTransition('installed', 'scheduled')).toBe(false);
  });

  it('treats done and cancelled as terminal', () => {
    expect(canTransition('done', 'cancelled')).toBe(false);
    expect(canTransition('done', 'requires_invoicing')).toBe(false);
    expect(canTransition('cancelled', 'to_schedule')).toBe(false);
  });

  it('rejects a no-op self-transition', () => {
    expect(canTransition('scheduled', 'scheduled')).toBe(false);
  });
});

describe('asJobStatus', () => {
  it('returns the value for a known status', () => {
    expect(asJobStatus('to_schedule')).toBe('to_schedule' satisfies JobStatus);
  });
  it('returns null for an unknown value', () => {
    expect(asJobStatus('booked')).toBeNull();
    expect(asJobStatus(null)).toBeNull();
    expect(asJobStatus(42)).toBeNull();
  });
});
