# Time-aware scheduling: the design, and what the GPS data makes possible

Written S68, 2026-08-27, from Naldo's decisions during the fleet-GPS build.
Audience: whoever builds the scheduling system, most likely Jason.

This is not a plan to build now. It is the design captured while the reasoning
was fresh, so that when scheduling gets built it starts from decisions already
made rather than re-litigating them.

## The one-paragraph version

The schedule today knows WHO is on WHICH job on WHAT DAY. It knows nothing about
time. That single gap blocks arrival windows for customers, job-duration
learning, and any honest answer to "how long does this kind of job actually
take". The GPS tracker closes it from the other end: it measures how long a van
actually sits at an address, without anyone typing anything. So the sequence is
measure first, learn second, schedule third.

## What exists today

Verified against master on 2026-08-27.

| Piece | Where | What it does |
| --- | --- | --- |
| Assignment | `job_assignments` (job_id, crew_member_id, assigned_date) | Who is on a job, on a calendar date |
| Schedule page | `src/app/admin/schedule/page.tsx` | Day view, assign and unassign |
| Logic | `src/lib/scheduling.ts` | `getSchedule`, `assignCrewToJob`, `unassignCrewFromJob`, `listUnscheduledJobs`, `computeDayCapacity` |
| Job lifecycle | `jobs.status` | `to_schedule` → `scheduled` → `installed` |

`assigned_date` is a DATE, not a timestamp, and deliberately so: "who is on this
job on the 22nd" is a calendar question, and storing an instant would reintroduce
the UTC-versus-Eastern drift this repo has already been bitten by. Keep that.

**What is missing: order, start time, and duration.** There is no way to say this
job comes before that one, no expected start, and no expected length.

## What the GPS side provides

From ledger row 403. The tracker writes a second, independent record of the day.

- `vehicle_events` — the raw Bouncie feed, already live.
- `vehicle_visits` (phase 3b) — arrivals and departures per vehicle per job,
  **multiple visits per job**, so a crew doubling back shows as two visits rather
  than overwriting the first. Plus day-start (left the depot at 6 Birch Road,
  Amityville) and day-end (left the last job).

**The hard rule, and it does not bend: GPS never writes payroll.** The crew clock
in and out manually exactly as they do today, and that stays the payroll record.
The GPS timeline is a parallel second clock used for measurement and
verification. The two are compared, never merged. Row 403 constraint (a), and
Naldo reaffirmed it on 2026-08-27 when he asked for the second clock: *"they'll
have two clocks, their main one, and our double check."*

Structurally this is enforced by `vehicle_visits` having no foreign key into
`shifts` or `job_segments`. Keep it that way. `closeOpenSegmentForShift` in
`src/lib/jobSegments.ts` is an existing unauthenticated writer to `job_segments`
and is the obvious wrong place a future geofence would get wired in — row 403
constraint (g) names it for exactly this reason.

## What scheduling needs to add

### 1. Order within a day

Naldo's decision, 2026-08-27: **the office drags jobs into order.** Not inferred
from GPS (we would only learn the next job after they arrive, which is too late
to text anyone) and not auto-routed (it can be wrong about what the crew intends,
and being wrong about the next address means texting the wrong customer).

Minimum shape: a `sequence` integer on `job_assignments`, unique per
(assigned_date, crew or vehicle). The schedule page gets drag ordering.

### 2. Expected duration per job

Two numbers, from two different sources, tracked separately. This was a
deliberate choice: independent sources keep the scheduling side honest even when
timekeeping is messy, and a disagreement between them is information rather than
a bug.

- **On-site minutes** — from the GPS timeline. What an arrival window is built
  from. Measurable with no crew input.
- **Labour hours** — from the manual clock. On-site time multiplied by crew size,
  plus travel. What job costing and profit are built from.

Store both the predicted and the actual for every job. Without the prediction
stored at the time it was made, there is no way to measure whether the model is
getting better.

### 3. Expected start time

Derived, not typed: day start, plus travel between consecutive addresses, plus
predicted duration of each preceding job. Which means it falls out of (1) and (2)
rather than being its own feature.

## The duration model

**Do not build this until there is data.** It needs weeks of real visits. Anything
shipped before that is a guess wearing a model's clothes.

**Target:** on-site minutes for a job.

**Inputs, all already in the quote:** service type (holiday, permanent, bistro),
linear footage, number of stories or peaks, roof versus ground versus tree,
material and package chosen, whether it is an install or a takedown, crew size,
and whether the property has been serviced before (a repeat is faster).

**Naldo's starting priors, given 2026-08-27.** These are the owner's own
estimates, not measured data, and they matter for two reasons: they are the
baseline any model has to beat, and they tell us immediately whether the GPS
visit detection is producing sane numbers.

| Service | On-site duration | Crew | Implied labour hours |
| --- | --- | --- | --- |
| Holiday lighting | up to about 1.5 hours | — | — |
| Permanent lighting | about 4 to 5 hours | 2 to 3 people | roughly 10 to 12 |

Two things fall out of this straight away. First, the two service types are not
variations of one number — they differ by roughly 3x, so they should never share
a prediction. Second, the permanent figure is on-site time with several people on
site, which is exactly why on-site minutes and labour hours have to be tracked
separately: 4.5 hours of van-at-the-address is about 11 hours of paid crew time,
and quoting either number as if it were the other would be badly wrong.

Use these as the seed values so the system is useful on day one, and replace each
with the measured median as soon as there are enough real visits to beat it.

**Method:** start with the median actual duration per service type. That single
number will beat a guess immediately and is trivial to compute. Only move to a
real regression once there is enough data to beat it, and measure against the
median as the baseline. A model that cannot beat "the median of this service
type" is not worth its complexity.

**Honesty requirement:** show the office the prediction AND the spread, not a
single confident number. "Usually 2 to 3 hours" is useful; "2h14m" is a lie
dressed as precision.

## Customer arrival messages

Decided 2026-08-27.

- **One message per visit**, sent when the van leaves the PREVIOUS job. Not on
  arrival — the point is warning, not announcement.
- **Padding: 25% of travel time, with a 10-minute floor.** Twenty minutes becomes
  thirty; an hour becomes seventy-five. Naldo's rule: *"we'd rather tell the
  customer we're coming later and then come faster so we look more
  professional."*
- **Round up to the bracket, never down**, so rounding can only make us early.
  Five-minute brackets under thirty minutes, fifteen-minute brackets above.
- **Channel: GHL**, reusing the existing customer messaging path and whatever
  consent and STOP handling already lives there. Do not add a second sender.
- **Travel time** from Google Distance Matrix, using the stored rooftop
  coordinates from the phase-1 backfill.

The first wrong "we're on the way" text costs more than a week of waiting, so it
ships behind a switch and gets turned on after real arrivals have been checked
against reality.

## Sequencing

1. GPS visits recorded (phase 3b). No scheduling changes needed.
2. Compare view: manual clock beside GPS clock. Answers "how long did that job
   take" with no model at all, and is the first genuinely useful output.
3. Order within a day. Small, and unblocks everything after it.
4. ETA texts. Needs 3 plus travel time.
5. Median-per-service-type duration. Needs a few weeks of 1.
6. A real model, only if it beats the median.

Steps 1 and 2 are worth having on their own even if nothing after them is ever
built. That is deliberate: each step should pay for itself.

## Open questions

- **Crew or vehicle?** Ordering could hang off the crew member or the vehicle.
  Vehicle is what the GPS actually observes; crew is what `job_assignments`
  records. A crew splitting across two vehicles breaks the simple version.
- **What counts as a visit?** A van idling outside for two minutes while someone
  checks an address is not a job. There needs to be a minimum dwell time, and
  nobody has picked it yet. Naldo's holiday figure bounds it usefully: if a real
  holiday job can be done in well under 1.5 hours, the threshold has to be small
  enough not to discard short genuine jobs, which rules out anything like a
  30-minute floor. Look at real data before picking a number.
- **Takedown season.** Durations for takedowns and installs are different jobs
  wearing the same customer. They should probably never share a prediction.
- **Multi-day jobs.** Nothing here handles a job spanning two days.
