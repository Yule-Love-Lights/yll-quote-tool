// Event Lighting (#96) — "Your Event Schedule". Shows the staff-entered
// install / event / takedown dates as a simple three-step timeline on the event
// portal. Rendered only for an event quote that has at least one date set.

type Schedule = { installDate?: string; eventDate?: string; takedownDate?: string };

// Format an ISO yyyy-mm-dd in LOCAL time (parsing the parts avoids the UTC-midnight
// off-by-one that `new Date('2026-07-18')` causes in negative-offset timezones).
function fmtDate(iso?: string): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function EventSchedule({ schedule }: { schedule: Schedule }) {
  const steps = [
    { label: 'We install', date: fmtDate(schedule.installDate) },
    { label: 'Your event', date: fmtDate(schedule.eventDate) },
    { label: 'We take down', date: fmtDate(schedule.takedownDate) },
  ].filter((s) => s.date);

  if (steps.length === 0) return null;

  return (
    <section className="w-full bg-slate-950 px-6 py-14 text-slate-100 sm:py-20">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.20em] text-[#FFB744]">
          Your event schedule
        </p>
        <h2 className="font-display text-2xl font-semibold text-[#F4ECD8] sm:text-3xl">
          Everything, timed around your day.
        </h2>

        <ol className="mt-8 grid gap-4 sm:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.label}
              className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-5"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#FFB744]">
                {s.label}
              </p>
              <p className="mt-1.5 text-lg font-medium text-[#F4ECD8]">{s.date}</p>
            </li>
          ))}
        </ol>

        <p className="mx-auto mt-6 max-w-xl text-sm text-slate-400">
          We&apos;re on standby the day of, and everything comes down cleanly after — no ladders, no
          cleanup, nothing left behind.
        </p>
      </div>
    </section>
  );
}
