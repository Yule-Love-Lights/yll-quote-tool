import { describe, expect, it } from 'vitest';
import { canRecordStaffColorRequest } from './staffColorRequestEligibility';

const eligible = {
  serviceType: 'permanent',
  status: 'booked',
  customerApprovedAt: '2026-08-20T12:00:00.000Z',
  customerSelection: { packageId: 'C' },
  pendingColorRequest: undefined,
} as const;

describe('canRecordStaffColorRequest', () => {
  it('allows a booked Permanent order with a frozen selection and no pending request', () => {
    expect(canRecordStaffColorRequest(eligible)).toBe(true);
  });

  it.each(['holiday', 'event', 'permanent_bistro'] as const)('excludes %s quotes', (serviceType) => {
    expect(canRecordStaffColorRequest({ ...eligible, serviceType })).toBe(false);
  });

  it('excludes a Permanent quote before it is booked', () => {
    expect(canRecordStaffColorRequest({ ...eligible, status: 'approved' })).toBe(false);
  });

  it('excludes a booked quote without a frozen customer selection', () => {
    expect(canRecordStaffColorRequest({ ...eligible, customerSelection: undefined })).toBe(false);
  });

  it('excludes an order that already has a pending request', () => {
    expect(
      canRecordStaffColorRequest({
        ...eligible,
        pendingColorRequest: { colorSchemeId: 'warm-white' },
      }),
    ).toBe(false);
  });
});
