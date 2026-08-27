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
