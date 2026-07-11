import type { BistroSummary, EventSummary, HolidayBreakdown, PermanentSummary } from '@/lib/dashboard/types';
import { HolidaySection } from './HolidaySection';
import { PermanentSection } from './PermanentSection';
import { EventSection } from './EventSection';
import { BistroSection } from './BistroSection';

export function ServiceSections({
  holiday,
  permanent,
  event,
  bistro,
}: {
  holiday: HolidayBreakdown;
  permanent: PermanentSummary;
  event: EventSummary;
  bistro: BistroSummary;
}) {
  return (
    <section aria-label="By service line" className="mb-8">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        By service line
      </h2>
      {/* Holiday takes the full row (richer content); Permanent + Event + Bistro
          share the second row (#117 added the third card). */}
      <div className="grid grid-cols-1 gap-3 mb-3">
        <HolidaySection data={holiday} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <PermanentSection data={permanent} />
        <EventSection data={event} />
        <BistroSection data={bistro} />
      </div>
    </section>
  );
}
