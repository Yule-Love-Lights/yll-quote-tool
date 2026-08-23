'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Dispatch / day view (P4P Phase 3).
 *
 * Pick a day, see what is booked, who is on it, and each person's hours for that
 * day. Assign and unassign inline.
 *
 * This is the day view, not the drag-drop week/month calendar — that is a
 * separate slice. The capacity numbers shown here are the same ones the calendar
 * will use, so the derivation only has to be right once.
 */

type ScheduledJob = {
  jobId: string;
  jobNumber: number | null;
  status: string;
  budgetedHours: number | null;
  hoursArePlaceholder: boolean;
  crewMemberIds: string[];
};
type DayCapacity = {
  date: string;
  perCrew: Record<string, number>;
  unassignedHours: number;
  jobsWithoutEstimate: number;
  anyPlaceholderHours: boolean;
};
type CrewMember = { id: string; displayName: string; active: boolean };

const today = () => new Date().toISOString().slice(0, 10);
const hours = (n: number) => `${Math.round(n * 10) / 10}h`;

export function ScheduleDay({ crew }: { crew: CrewMember[] }) {
  const [date, setDate] = useState(today());
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [capacity, setCapacity] = useState<DayCapacity | null>(null);
  const [unscheduled, setUnscheduled] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  // Row 346 fix round: the date this component's CURRENT jobs/capacity/
  // unscheduled state actually belongs to — set only on a successful load,
  // separately from `loading`/`date`. Lets the render below tell "no data
  // yet" (never loaded — show the skeleton) apart from "have data, refetching"
  // (keep the stale content on screen with a busy note instead of blanking
  // it), and — since it can lag `date` during a date change — lets that note
  // say explicitly which day is on screen so stale content is never mistaken
  // for the newly-picked day's data.
  const [loadedDate, setLoadedDate] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setToken((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [dayRes, unschedRes] = await Promise.all([
          fetch(`/api/ops/schedule?from=${date}&to=${date}`),
          fetch(`/api/ops/schedule?unscheduled=${date}`),
        ]);
        if (!dayRes.ok) throw new Error('Could not load the schedule');
        const day = (await dayRes.json()) as {
          days: DayCapacity[];
          jobsByDate: Record<string, ScheduledJob[]>;
        };
        const unsched = unschedRes.ok
          ? ((await unschedRes.json()) as { jobs: ScheduledJob[] })
          : { jobs: [] };
        if (cancelled) return;
        setJobs(day.jobsByDate[date] ?? []);
        setCapacity(day.days[0] ?? null);
        setUnscheduled(unsched.jobs ?? []);
        setError(null);
        setLoadedDate(date);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [date, token]);

  async function mutate(method: 'POST' | 'DELETE', jobId: string, crewMemberId: string) {
    try {
      const res = await fetch('/api/ops/schedule', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, crewMemberId, date }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'That did not save');
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not save');
    }
  }

  const nameOf = (id: string) => crew.find((c) => c.id === id)?.displayName ?? id.slice(0, 8);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <label htmlFor="schedule-date" className="text-sm text-gray-700">
          Day
        </label>
        <input
          id="schedule-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
        />
      </div>

      {capacity?.anyPlaceholderHours && (
        <p className="mb-4 text-sm rounded-md px-3 py-2 bg-amber-50 text-amber-900 border border-amber-200">
          These hours come from placeholder production rates, not measured ones. Use them for
          shape, not for promises.
        </p>
      )}

      {loading && !loadedDate ? (
        // row 346: was a bare "Loading…" line on FIRST load (nothing to show
        // yet) — placeholder rows matching the three sections below
        // (load-for-day, booked, unscheduled) so first mount doesn't show a
        // single sparse line before the real layout appears.
        <div role="status" aria-busy="true" className="space-y-6">
          <div className="h-24 animate-pulse rounded-md bg-black/10" />
          <div className="h-24 animate-pulse rounded-md bg-black/10" />
          <div className="h-24 animate-pulse rounded-md bg-black/10" />
        </div>
      ) : (
        <>
          {/* Row 346 fix round: this view reloads on every date change AND
              after every assign/unassign (mutate() -> refresh()), so a
              lens caught the FIRST version of this fix replacing already-good
              on-screen content with a big pulsing skeleton on every one of
              those — louder than the bare "Loading…" text it replaced.
              Stale-while-revalidate instead: the sections below keep
              rendering whatever loadedDate's data already fetched, and this
              is the only thing that changes while a refetch is in flight — a
              small status line, never the big placeholder blocks. When the
              date being fetched differs from loadedDate (a date-change
              refetch, not a mutate() refresh), it names both days explicitly
              so the still-visible content is never mistaken for the
              newly-picked day's data. */}
          {loading && (
            <p role="status" aria-busy="true" className="mb-4 text-xs text-gray-500">
              {loadedDate && loadedDate !== date
                ? `Loading ${date}… (showing ${loadedDate} below)`
                : 'Refreshing…'}
            </p>
          )}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Load for the day</h3>
            {capacity && Object.keys(capacity.perCrew).length > 0 ? (
              <ul className="text-sm divide-y divide-gray-100 border border-gray-200 rounded-md">
                {Object.entries(capacity.perCrew).map(([id, h]) => (
                  <li key={id} className="flex justify-between px-3 py-1.5">
                    <span>{nameOf(id)}</span>
                    <span className="text-gray-600">{hours(h)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">Nobody assigned yet.</p>
            )}
            {capacity && capacity.unassignedHours > 0 && (
              <p className="text-sm text-amber-800 mt-2">
                {hours(capacity.unassignedHours)} booked with nobody assigned.
              </p>
            )}
            {capacity && capacity.jobsWithoutEstimate > 0 && (
              <p className="text-sm text-gray-500 mt-1">
                {capacity.jobsWithoutEstimate} job(s) have no hours estimate, so they are not in
                the totals.
              </p>
            )}
          </section>

          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Booked this day</h3>
            {jobs.length === 0 ? (
              <p className="text-sm text-gray-500">Nothing booked.</p>
            ) : (
              <ul className="space-y-3">
                {jobs.map((j) => (
                  <li key={j.jobId} className="border border-gray-200 rounded-md p-3">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium">
                        Job {j.jobNumber !== null ? `#${j.jobNumber}` : j.jobId.slice(0, 8)}
                      </span>
                      <span className="text-gray-500">
                        {j.budgetedHours === null ? 'no estimate' : hours(j.budgetedHours)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {j.crewMemberIds.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => mutate('DELETE', j.jobId, id)}
                          className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
                          title="Remove from this job"
                        >
                          {nameOf(id)} ×
                        </button>
                      ))}
                      <select
                        className="text-xs border border-gray-300 rounded px-2 py-1"
                        value=""
                        onChange={(e) => {
                          if (e.target.value) mutate('POST', j.jobId, e.target.value);
                        }}
                      >
                        <option value="">Add crew…</option>
                        {crew
                          .filter((c) => c.active && !j.crewMemberIds.includes(c.id))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.displayName}
                            </option>
                          ))}
                      </select>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">
              Not scheduled yet ({unscheduled.length})
            </h3>
            {unscheduled.length === 0 ? (
              <p className="text-sm text-gray-500">Everything open is on the calendar.</p>
            ) : (
              <ul className="text-sm divide-y divide-gray-100 border border-gray-200 rounded-md">
                {unscheduled.slice(0, 25).map((j) => (
                  <li key={j.jobId} className="flex justify-between items-center px-3 py-1.5">
                    <span>
                      Job {j.jobNumber !== null ? `#${j.jobNumber}` : j.jobId.slice(0, 8)}
                      <span className="ml-2 text-xs text-gray-400">{j.status}</span>
                    </span>
                    <select
                      className="text-xs border border-gray-300 rounded px-2 py-1"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) mutate('POST', j.jobId, e.target.value);
                      }}
                    >
                      <option value="">Book for this day…</option>
                      {crew
                        .filter((c) => c.active)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.displayName}
                          </option>
                        ))}
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </div>
  );
}
