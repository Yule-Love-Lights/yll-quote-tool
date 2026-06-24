import type { EventSummary, HolidayBreakdown, PermanentSummary } from '@/lib/dashboard/types';
import { HolidaySection } from './HolidaySection';
import { PermanentSection } from './PermanentSection';
import { EventSection } from './EventSection';

export function ServiceSections({
  holiday,
  permanent,
  event,
}: {
  holiday: HolidayBreakdown;
  permanent: PermanentSummary;
  event: EventSummary;
}) {
  return (
    <section aria-label="By service line" className="mb-8">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        By service line
      </h2>
      {/* Holiday takes the full row (richer content); Permanent + Event side-by-side. */}
      <div className="grid grid-cols-1 gap-3 mb-3">
        <HolidaySection data={holiday} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PermanentSection data={permanent} />
        <EventSection data={event} />
      </div>
    </section>
  );
}
