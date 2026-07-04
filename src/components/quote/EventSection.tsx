'use client';

import { useEffect } from 'react';

// Event Lighting builder inputs (#96) — shown only when service_type='event'.
// Bistro runs are priced automatically from the drawn design (projectScene), so
// this section only collects the event-only extras: freestanding pole/base
// supports (temporary bistro) + the three staff-entered dates the customer sees
// on the portal (install / event / takedown). Maps to QuoteInputs.event.

export type EventFields = {
  barrelBoxes: number;
  installDate: string;
  eventDate: string;
  takedownDate: string;
};

const inp = 'border border-gray-300 rounded px-2 py-1 text-sm';
const lbl = 'block text-xs font-medium text-gray-600 mb-1';

export function EventSection({
  value,
  onChange,
  onValidityChange,
}: {
  value: EventFields;
  onChange: (v: EventFields) => void;
  // Lifts the date-order check (below) to the parent so Send/Calculate can gate
  // on it — the inline warning alone is advisory-only and doesn't block anything.
  onValidityChange?: (valid: boolean) => void;
}) {
  const set = <K extends keyof EventFields>(k: K, v: EventFields[K]) => onChange({ ...value, [k]: v });

  // The council's date-order check (takedown ≥ event ≥ install) — surfaced as a
  // visible cue so a fat-fingered date is caught before send.
  const { installDate: i, eventDate: e, takedownDate: t } = value;
  const dateWarning =
    i && e && i > e
      ? 'Install date is after the event date.'
      : e && t && e > t
        ? 'Takedown date is before the event date.'
        : i && t && i > t
          ? 'Install date is after the takedown date.'
          : null;

  useEffect(() => {
    onValidityChange?.(dateWarning == null);
  }, [dateWarning, onValidityChange]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Event lighting is temporary. Bistro runs you draw on the design are priced automatically —
        add any freestanding pole/base supports and the three dates below.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className={lbl}>Install date</label>
          <input
            type="date"
            className={inp}
            value={value.installDate}
            onChange={(ev) => set('installDate', ev.target.value)}
          />
        </div>
        <div>
          <label className={lbl}>Event date</label>
          <input
            type="date"
            className={inp}
            value={value.eventDate}
            onChange={(ev) => set('eventDate', ev.target.value)}
          />
        </div>
        <div>
          <label className={lbl}>Takedown date</label>
          <input
            type="date"
            className={inp}
            value={value.takedownDate}
            onChange={(ev) => set('takedownDate', ev.target.value)}
          />
        </div>
      </div>

      {dateWarning && <p className="text-xs text-amber-600">⚠ {dateWarning}</p>}

      <div>
        <label className={lbl}>Freestanding pole &amp; base supports (temporary bistro)</label>
        <input
          type="number"
          min={0}
          step="1"
          className={`${inp} w-24 text-right`}
          value={value.barrelBoxes}
          onChange={(ev) => set('barrelBoxes', Math.max(0, Math.floor(Number(ev.target.value) || 0)))}
        />
        <span className="ml-2 text-xs text-gray-400">$ each (rate in Settings)</span>
      </div>
    </div>
  );
}
