// Maps the website lead-capture vocabulary (LeadService, src/lib/leads/leadService.ts)
// to the quote builder's canonical ServiceType (src/lib/serviceType.ts) — the two
// vocabularies are deliberately separate (see leadService.ts's header comment), so
// the "Create quote" link on /admin/leads needs its own translation when prefilling
// the blank builder. No existing exported mapping does this (leadService.ts only
// maps LeadService -> GHL pipeline), so this is a new one, colocated with the page
// that's the only consumer.
import { asLeadService, type LeadService } from '@/lib/leads/leadService';
import type { ServiceType } from '@/lib/serviceType';

export const LEAD_SERVICE_TO_QUOTE_SERVICE_TYPE: Record<LeadService, ServiceType> = {
  christmas: 'holiday',
  permanent: 'permanent',
  'event-wedding': 'event',
  landscape: 'permanent_bistro',
};

/** Map a lead's raw `service` string to a quote ServiceType, or null when it
 *  isn't a recognized LeadService. */
export function leadServiceToQuoteServiceType(service: string): ServiceType | null {
  const lead = asLeadService(service);
  return lead ? LEAD_SERVICE_TO_QUOTE_SERVICE_TYPE[lead] : null;
}
