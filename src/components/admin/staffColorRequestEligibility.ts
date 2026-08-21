import type { QuoteStatus } from '@/lib/quoteStatus';
import type { ServiceType } from '@/lib/serviceType';

type StaffColorRequestEligibility = {
  serviceType: ServiceType | null;
  status: QuoteStatus;
  customerApprovedAt: string | null;
  customerSelection: unknown;
  pendingColorRequest: unknown;
};

export function canRecordStaffColorRequest({
  serviceType,
  status,
  customerApprovedAt,
  customerSelection,
  pendingColorRequest,
}: StaffColorRequestEligibility): boolean {
  return (
    serviceType === 'permanent' &&
    status === 'booked' &&
    !!customerApprovedAt &&
    customerSelection != null &&
    pendingColorRequest == null
  );
}
