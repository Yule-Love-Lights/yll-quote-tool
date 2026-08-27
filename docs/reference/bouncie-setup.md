# Bouncie fleet GPS: setup runbook

Ledger row 403, phase 2. Follow these in order. The order matters for step 2 and
step 5, and the reason is given at each.

Nothing in this runbook touches payroll. Row 403 constraint (a) is absolute: GPS
never writes payroll. A geofence may only suggest an arrive or depart to a crew
member's own device, and a human still affirmatively taps.

## Before you start

You need:

- Access to the Vercel project settings for the quote tool.
- Access to the Supabase SQL editor for the production project.
- A Bouncie account with the two devices activated.
- Access to the Bouncie developer portal at https://www.bouncie.dev/.

## Step 1: apply the migration

Open the Supabase SQL editor for the production project and paste the whole
contents of `migrations/2026-08-26-bouncie-vehicles.sql`, then run it.

It creates three new tables (`vehicles`, `vehicle_crew`, `vehicle_events`) and
alters nothing that already exists. Re-running it is harmless: every statement is
`if not exists`.

Confirm it worked by running this and seeing three rows:

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('vehicles', 'vehicle_crew', 'vehicle_events');
```

**Why this is step 1 and not step 7.** If the tables do not exist, the receiver
answers 503 to every event. Bouncie retries a 503 with backoff and then
auto-deactivates the webhook, exactly as it would for a bad secret, and tells
nobody. So an unapplied migration and a wrong secret fail the same silent way.
Both have to be in place before step 5.

## Step 2: set the webhook secret in Vercel, BEFORE registering anything

This step comes first for a real reason. The receiver fails closed: with no
secret configured it answers 401 to everything. Bouncie retries a failing webhook
with backoff and then **auto-deactivates it** until a human re-enables it. If you
register the webhook before the secret exists, Bouncie will hammer a 401 and
switch itself off, and nothing will tell you.

Generate a long random secret. In PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Add it in Vercel under Project Settings, Environment Variables:

- Name: `BOUNCIE_WEBHOOK_SECRET`
- Value: the string you just generated
- Environments: Production (and Preview if you want to test there)

Then redeploy, because an environment variable added after a build is not visible
to the running deployment.

Keep that value somewhere you can paste it again in step 5. Do not put it in the
repo, a commit, a PR, or a chat message.

## Step 3: confirm the endpoint is alive

Once the deploy finishes:

```powershell
curl.exe -i https://<your-domain>/api/integrations/bouncie/webhook
```

Expect `200 OK` and the body `OK`. That is the reachability check, and it is the
only thing the endpoint answers without a secret.

Then confirm it rejects an unauthenticated POST:

```powershell
curl.exe -i -X POST https://<your-domain>/api/integrations/bouncie/webhook -d "{}"
```

Expect `401`. If you get anything else, stop and say so: a 200 here would mean the
endpoint is accepting unauthenticated writes.

## Step 4: register the application on the Bouncie developer portal

Go to https://www.bouncie.dev/ and create an application. You get a `client_id`
and a `client_secret`. You will also set the redirect URI list here.

This is the OAuth side, and it is separate from the webhook. It is what a later
phase needs to call `GET /v1/vehicles`. It is worth doing now because it is the
long pole: authentication is per Bouncie user, so someone with access to the
Bouncie account has to grant it, and that is not something the code can do on its
own.

Note for whoever builds the next phase: Bouncie's REST calls take
`Authorization: <access_token>` with **no** `Bearer` prefix, and refresh tokens
rotate on every use, so they need durable storage rather than an environment
variable.

## Step 5: register the webhook

In the developer portal, add the webhook:

- URL: `https://<your-domain>/api/integrations/bouncie/webhook`
- Auth key: the exact value you put in `BOUNCIE_WEBHOOK_SECRET` in step 2
- Events: start with `tripStart`, `tripEnd`, and `applicationGeozone`

**Deliberately leave `tripData` off for now.** Bouncie's own documentation says
`tripData` transmits continuously throughout a trip and "will make up the bulk of
your data volume if enabled". Subscribing to it on day one, before anyone has
looked at a single stored event, is how a storage bill turns into a surprise.
Turn it on once we know what the volume actually looks like.

## Step 6: plug in a device and confirm a real event landed

Plug a tracker into the OBD-II port, drive the vehicle far enough to complete a
trip, then run:

```sql
select received_at, event_type, imei, vin, transaction_id, occurred_at
from vehicle_events
order by received_at desc
limit 20;
```

What you are checking is not just "did anything arrive". Check specifically:

- `event_type` is populated. A NULL there means the payload did not match the
  published spec, which is exactly what this phase was built to catch. That is a
  useful result, not a failure. Look at the `payload` column for that row.
- `imei` matches the device you plugged in.
- `occurred_at` is populated and looks like the right time.

If `event_type` is NULL, or nothing arrived at all, say so before anyone builds
the next phase on top of it.

## Step 7: register the vehicles

Once you know the real IMEIs, record them so later phases can name a vehicle
instead of showing a bare device number:

```sql
insert into vehicles (label, imei, vin) values
  ('Truck + trailer', '<imei from step 6>', '<vin from step 6>'),
  ('Van',             '<imei from step 6>', '<vin from step 6>');
```

Constraint (c): one device per vehicle, never shared. The Bouncie subscription and
trip history belong to the DEVICE, so moving the truck's tracker into the van
would file the van's miles under the truck. The unique index on `imei` enforces
that a device is only ever claimed by one vehicle.

## Step 8: tell the crew, in writing, before the devices go in

This is not a code step and it is not optional. Tracking company vehicles during
work hours is legal in New York, but an OBD-II plug sits in plain sight and gets
found in week one. Finding it before being told about it is what turns a
scheduling tool into a trust problem.

Put in writing: what it is for, that it is on the vehicle rather than on a person,
and what happens after hours. The truck goes home with someone, so the after-hours
answer is the one that matters most, and it should be a real answer rather than a
reassurance.

## What is deliberately NOT here yet

- No live map. Position comes from `tripData` or a geozone event, and we have not
  seen real volume yet.
- No geofences and no arrive/depart suggestions.
- No customer messages.
- No staleness alarm. Bouncie silently auto-deactivates a failing webhook, so
  "no events" and "vans parked" currently look identical. Until that alarm
  exists, step 6's query is the manual version.

Each of those waits on a real event confirming the payload shape.

## Retention and hours: decided

**Naldo, 2026-08-27: keep all data, we are always open.**

`BUSINESS_HOURS` in `src/lib/integrations/bouncie.ts` spans the full day, so
`occurred_off_hours` is false on every row and nothing is deleted or redacted on
a schedule. The company runs at all hours in season, so there is no window during
which a vehicle's position is treated as out of scope.

The tagging mechanism stays even though it currently classifies nothing. It is
the one place that decision lives: if the policy ever narrows, that constant is
the only edit, and every row already carries the column a purge job would need.

Two things follow from this, and they are worth saying plainly rather than
leaving implicit:

- One vehicle goes home with a crew member, so every evening and weekend trip is
  stored indefinitely at rooftop precision.
- That makes step 8 below more important, not less. Tell the crew what is
  captured and that it runs after hours, in writing, before the devices go in.

---

# Phase 3a: connecting the API (OAuth)

The webhook only lets Bouncie push events TO us. Reading live position, and
creating geofences, both need an OAuth grant. This is that setup.

**The API key in the developer portal does not work for this.** It was tested
against `/v1/vehicles` on 2026-08-27 and returns 401, bare and with a `Bearer`
prefix. OAuth is the only way in. Do not spend time on the key.

## Step 1: generate the token encryption key

The Bouncie tokens are stored in the database, encrypted. Generate the key:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Add it in Vercel as `TOKEN_ENCRYPTION_KEY`.

**Use the SAME value in Preview and Production.** A token encrypted with one key
cannot be read with another. If they differ, the grant works in one environment
and silently fails in the other, and the error looks like a Bouncie problem
rather than a configuration one.

**If this key is ever lost or changed, the stored tokens are gone for good.**
There is no recovery and no way to re-derive them. That is not a bug, it is what
encryption means. The fix is not dangerous, just manual: delete the row from
`integration_tokens` where `provider = 'bouncie'`, then reconnect from Step 5.

## Step 2: the other three variables

From the Bouncie developer portal application page:

| Variable | Value |
| --- | --- |
| `BOUNCIE_CLIENT_ID` | `yll-hub` |
| `BOUNCIE_CLIENT_SECRET` | the client secret, revealed with SHOW |
| `BOUNCIE_REDIRECT_URI` | `https://quote.yulelovelights.com/api/integrations/bouncie/callback` |

## Step 3: apply the migration

`migrations/2026-08-27-bouncie-oauth-tokens.sql`. Read its header first: the
column additions are routine, the trigger needs a deliberate go.

## Step 4: update the redirect URL in Bouncie

On the application page, change REDIRECT URLS from the site root to:

```
https://quote.yulelovelights.com/api/integrations/bouncie/callback
```

It must match `BOUNCIE_REDIRECT_URI` exactly, including the scheme and any
trailing slash. Bouncie compares them character for character.

## Step 5: connect

Visit `/api/integrations/bouncie/start` while logged into the quote tool. That
mints a one-time value, sends you to Bouncie's approval screen, and brings you
back to Settings → Accounts with the result on screen.

**Start from that URL, not from Bouncie's own authorize link.** The callback
refuses a request that did not begin here, which is what stops someone else's
Bouncie account being connected in place of yours.

## What the outcomes mean

Settings → Accounts shows one of these after connecting:

| Message | What to do |
| --- | --- |
| Bouncie connected | Nothing. It worked. |
| access was not granted | You declined or closed the approval screen. Start again. |
| attempt was refused | The request did not match one started here, usually because it sat too long. Start again. If it repeats, say so rather than retrying. |
| not configured on the server | One of the three variables in Step 2 is missing. |
| token encryption key is missing | `TOKEN_ENCRYPTION_KEY` is not set. Nothing was wasted; set it, redeploy, retry. |
| Connecting failed | The approval code was used up and could not be exchanged. Start again; the server log has the reason. |

## When it breaks later

**The refresh token rotates on every use, and expires if unused.** If nothing
reads Bouncie data for a long stretch, the grant can die on its own. There is no
keep-alive job yet — that ships with the live map, which is the first thing that
will read it regularly.

**A dead grant is not dangerous, just manual.** Nothing is lost except the
connection. Reconnect from Step 5.

**The one thing to watch for:** if the map stops showing positions, check
Settings → Accounts before assuming the trackers are at fault. A revoked or
expired grant and a dead device look the same from the outside.

---

# Phase 3b: the visit timeline (the second clock)

## What this is

The crew clock in and out by hand, and that stays the payroll record. The visit
timeline is a SEPARATE record of the same day, built from where the vans actually
were, so the two can be compared. It answers "how long did that job really take"
and "did they double back".

The two are never merged. `vehicle_visits` has no link into `shifts` or
`job_segments`, so GPS cannot reach payroll even by accident.

## Apply the migration

`migrations/2026-08-27-vehicle-visits.sql`. Two new tables, `job_geozones` and
`vehicle_visits`. Nothing existing is altered, and unlike the OAuth migration
this one has no trigger, so it needs no separate decision.

Confirm with:

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('job_geozones', 'vehicle_visits');
```

## Nothing happens until geofences exist

The timeline only fills in once zones are armed, and arming needs the OAuth
connection from phase 3a. Until then these tables stay empty and that is correct,
not broken.

## Reading it

Every arrival is a row. A visit still in progress has `exited_at` empty, which is
normal during the day.

```sql
select v.entered_at, v.exited_at, veh.label, v.kind, v.job_id
from vehicle_visits v
join vehicles veh on veh.id = v.vehicle_id
order by v.entered_at desc
limit 50;
```

## What it does NOT tell you, and this matters

**The van is not the person.** A crew member can still be working after the van
leaves, and the van can sit somewhere while nobody is working. When the GPS
record and the manual clock disagree, the honest reading is "these two differ,
find out why", not "the crew got it wrong".

Legitimate reasons the two differ, none of them anyone's fault:

- Someone is dropped off and the van leaves.
- The crew finishes inside after the van is loaded and moved.
- Two crew in one van, one stays on after the other drives off.
- Signal loss in a driveway or behind a house.
- A van parked out of geofence range on a long street.

**Before this is ever used in a conversation about someone's hours, tell the crew
it exists, what it records, and that it is a cross-check rather than the clock
they are paid from.** Finding out afterwards that a second record has been kept
is how a scheduling tool turns into a trust problem.

## Known gaps, recorded rather than hidden

- **Nothing closes a stale visit.** A device unplugged mid-job leaves a visit
  open indefinitely. It will read as "still there" until someone notices.
- **An exit arriving before its own entry is dropped.** It happens after a device
  regains signal and dumps buffered events. The raw event is still stored, so it
  can be reprocessed later.
- **Silent skips.** An event for an unknown zone, an unregistered device, or an
  exit with no matching arrival is logged and dropped. If a job has no timeline,
  the server log says why.
- **No retention limit.** These tables grow forever, in line with the
  keep-everything decision. Tracked as ledger row 415.

---

# Phase 3c: the geofences

## What this does

For every job scheduled on a day, it draws a circle around the customer's house
in Bouncie's system and asks Bouncie to tell us when a van enters or leaves.
Those events feed the visit timeline. Zones are armed only for days that have
scheduled jobs, and retired afterwards.

## Apply the migration

`migrations/2026-08-27-job-geozones-vehicle.sql`. One added column and its
indexes. Apply it after the phase-3b migration.

## Something worth deciding, not just doing

**This sends your customers' home coordinates to Bouncie.** Rooftop-precision
locations of private homes, stored in a third-party vendor's account so their
system can watch for your vans.

That is a real change in what leaves the company, separate from the decision to
track company vehicles, and nobody has recorded a decision about it. It is
defensible and it is normal for this kind of integration, but it should be a
choice rather than a side effect. Worth a line in your privacy policy if
customers are told what happens to their address.

## It is not running yet

Nothing calls `armZonesForDate` on a schedule. It also cannot run at all until
the phase-3a OAuth variables are set. So no zones exist, no arrivals fire, and
the visit timeline stays empty. That is expected, not broken.

## The radius, and why it is a guess

`GEOFENCE_RADIUS_METRES = 120` in `src/lib/integrations/bouncieGeozones.ts`.

Too small and a van parked down the street never registers as arriving. Too
large and driving past on the road counts as a visit. **Nobody has measured
this.** It is the most consequential number in the feature and it needs tuning
from real arrivals compared against real jobs. Tracked as ledger row 432.

**The overlap problem, which matters for how you work.** You often do several
houses in one neighbourhood. At 120 metres those circles overlap, so a van
parked at one job can sit inside a neighbour's geofence at the same time and
produce two visits at once. Nothing currently resolves that, and it would make
"how long did this job take" wrong for both. Decide it before the durations are
used for anything.

## When arming fails

Every run logs a one-line summary. A run that armed nothing is reported as an
error, not as silence, which was a real gap: a night where everything failed
used to look exactly like a night with nothing scheduled.

**Orphaned zones.** A zone can be created on Bouncie and then fail to be recorded
here, at which point nothing will ever delete it. `findOrphanedZones()` lists
zones that exist on Bouncie but not in our table. It only reports; deleting is a
human decision, because another application on the same account could legitimately
own a zone we do not recognise.

## A job with no coordinate gets no geofence, permanently

About 15 of your ~215 properties were refused during the geocoding pass because
their address did not resolve to a specific house. Those jobs will never produce
a timeline.

**That matters for how the data reads.** A job with no geofence looks identical
to a job the crew never attended. Before anyone compares GPS against the manual
clock, they need to know which jobs are untrackable, or an address-quality
problem will look like a crew problem.

---

# DESIGN CHANGE, 2026-08-27: polling replaced geofences

Naldo asked the right question: why would the customers' home coordinates go to
Bouncie when the quote tool is the one doing the tracking? They should not, and
now they do not. Everything above about Bouncie geofences, arming, retiring and
orphaned zones is HISTORY — none of it runs.

**How it works now.** A cron polls Bouncie every 2 minutes for each van's
position (one API call for the whole fleet) and does the proximity maths inside
the quote tool, against coordinates that never leave our database. The schedule
is the watch list: the jobs assigned for the day, plus the depot at 6 Birch
Road. Nothing about any customer is ever sent to Bouncie.

**What this replaced, and why it is better.**
- No zones to create, retire, leak, or reconcile in a vendor account.
- The overlap rule (several houses on one street) is our code: nearest wins
  today, and the scheduler's day-order becomes the tie-break when that ships.
- The poll doubles as the OAuth keep-alive, so the grant cannot die of disuse.
- A van's "no signal" state is explicit: positions carry Bouncie's own
  timestamp, a stale one counts as no signal, and silence NEVER closes a visit,
  because a device that fell quiet at a job has not left the job.

**The 15-minute rule.** Naldo, 2026-08-27: a stop under 15 minutes is not a
real visit. Short stays are recorded and flagged `below_min_dwell` rather than
deleted, so drive-bys stay visible as the data that tunes the radius.

**Migrations.** Apply `2026-08-28-vehicle-visits-polling.sql`. Do NOT apply the
two superseded 2026-08-27 geofence migrations; their files say so at the top.

**To switch it on**: the phase-3a OAuth variables, the migration above, and the
new cron deploys with the code (`/api/ops/vehicle-poll`, every 2 minutes,
CRON_SECRET-guarded). Until the OAuth variables exist the cron is a dormant
no-op by design.
