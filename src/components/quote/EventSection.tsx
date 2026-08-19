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
        enter the three dates below.
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
          {/* FIX D (#237 fix round, staff-lens MED): without this, a staffer
              who doesn't know the field syncs will either re-type it into
              HighLevel by hand (defeating the feature) or trust a value that
              may be stale. Honest about WHEN it syncs — send, and again if
              changed on a later save (#237 FIX B) — not just that it does.
              FIX C (#237 fix round 2, technical MED): the re-push gate
              (route.ts) only fires on a NEW real date — blanking this field
              formats to '' and is treated as nothing-to-push, so the CRM
              keeps whatever date it last had. This caption used to promise
              "and again if changed later" with no exception, which reads as
              "clearing it clears the CRM too" — false. Said plainly instead
              of silently pushing an empty value to "fix" it: GHL's actual
              handling of an empty custom-field write is unverified against a
              live location (see ghlEventDate.ts's own "only deviate after
              verifying" stance on this exact field), so guessing there
              risked storing something worse than a stale-but-known date. */}
          <p className="text-[11px] text-gray-400 mt-1">
            Synced to the CRM contact on send (and again if changed to a new date later) — clearing this field does
            not clear the CRM&apos;s copy.
          </p>
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
    </div>
  );
}
