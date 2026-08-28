import { SERVICE_TYPE_LABELS, DEFAULT_SERVICE_TYPE, asServiceType } from '@/lib/serviceType';
import type { ServiceType } from '@/lib/serviceType';

// Service-line badge palette (#123) — so an operator can tell holiday vs event
// vs permanent at a glance. Holiday (the default, the majority) is muted; the
// rarer verticals get their own accent so they pop out of the list. Extracted
// from /admin/quotes (row 419) so every admin table renders the same chip.
const SERVICE_TYPE_STYLES: Record<ServiceType, string> = {
  holiday: 'bg-slate-100 text-slate-600',
  permanent: 'bg-indigo-100 text-indigo-700',
  event: 'bg-amber-100 text-amber-800',
  permanent_bistro: 'bg-teal-100 text-teal-700',
};

/**
 * Row 419: the Holiday / Permanent / Event / Bistro chip, shared by the admin
 * quote/job/invoice tables and the customer profile. An unset or unrecognized
 * service_type reads as the default (holiday), matching the DB backfill rule
 * in src/lib/serviceType.ts.
 */
export function ServiceTypeBadge({ serviceType }: { serviceType: string | null | undefined }) {
  const svc = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${SERVICE_TYPE_STYLES[svc]}`}>
      {SERVICE_TYPE_LABELS[svc]}
    </span>
  );
}
