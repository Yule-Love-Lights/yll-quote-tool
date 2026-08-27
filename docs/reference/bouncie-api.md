# Bouncie API reference (read from the vendor spec, 2026-08-25)

Source of truth: `https://docs.bouncie.dev/openapi.json` (OpenAPI 3.1, ~117 KB). The docs
site at `https://docs.bouncie.dev/` is a Stoplight Elements single-page app, so fetching
the HTML gives you a page title and nothing else. Fetch the JSON directly. A copy of the
spec as read on 2026-08-25 is committed next to this file.

Ledger row 403 said the vendor facts were search-sourced and had to be confirmed against
the real reference before anything was built. This file is that confirmation. Where the
row guessed wrong, it is called out below.

## Base URLs

| Purpose | URL |
| --- | --- |
| REST API | `https://api.bouncie.dev/v1/` |
| Authorize (browser redirect) | `https://auth.bouncie.com/dialog/authorize` |
| Token exchange and refresh | `https://auth.bouncie.com/oauth/token` |
| Developer portal (register the app) | `https://www.bouncie.dev/` |

HTTPS only. Plain HTTP calls fail.

## Authentication: OAuth 2.0 authorization code, per user

Row 403 said "api_key + authorization_code". There is no API key. It is OAuth 2.0
authorization code, and the token is scoped to the Bouncie USER who granted access, not
to our application in general.

1. Register the app on the developer portal. That yields a `client_id`, a
   `client_secret`, and the list of allowed redirect URIs.
2. Send the user to
   `https://auth.bouncie.com/dialog/authorize?client_id=…&response_type=code&redirect_uri=…&state=…`.
   `redirect_uri` must match a registered URI exactly, including case and trailing slash.
   PKCE is supported and optional: `code_challenge` plus `code_challenge_method=S256`.
   An optional `resource` parameter (RFC 8707) is echoed as the token's `aud` claim.
3. The user is redirected back with `?code=…&state=…`. The authorization code does not
   expire on a timer, but running the flow again invalidates the previous code.
4. POST JSON to `https://auth.bouncie.com/oauth/token` with `client_id`, `client_secret`,
   `grant_type=authorization_code`, `code`, `redirect_uri`, and `code_verifier` if PKCE
   was used. Client credentials may instead go in an
   `Authorization: Basic base64(client_id:client_secret)` header.
5. Response: `access_token`, `refresh_token`, `expires_in` (seconds), `token_type`
   (always `"Bearer"`).

### Two traps worth a test each

- **Do not send `Bearer`.** REST calls use `Authorization: <access_token>` with no prefix,
  despite `token_type` saying `Bearer`. Bouncie's own FAQ lists the `Bearer` prefix as a
  leading cause of 401.
- **Refresh tokens rotate and expire.** Refreshing consumes the old refresh token and
  returns a new one, and an unused refresh token expires on its own. Tokens therefore
  need durable storage with a write-back on every refresh. An env var will not work.

Once a user has granted access at step 3, registered webhooks start firing for that user
immediately, before any token exchange has happened.

## `GET /v1/vehicles` — carries a current location

Query parameters: `vin`, `imei`, `limit`, `skip`. Returns an array.

Per vehicle: `vin`, `imei`, `nickName`, `model { make, name, year }`, `standardEngine`,
and `stats`.

`stats` (required members): `localTimeZone`, `odometer`, `lastUpdated`, `fuelLevel`,
`isRunning`, `speed`, `mil`.

`stats.location` is **optional** — the spec describes it as "if available" and leaves it
out of the required list. When present it is
`{ lat, lon, heading, address }`, where `address` is a reverse-geocoded street address
Bouncie supplies for free.

Consequences for the build:

- Every read of `stats.location` must handle its absence. Absent location is the "no
  signal" case from row 403 constraint (c), and it must never render as "not at the job".
- `stats.lastUpdated` is required, so staleness is always computable even when location
  is missing. Use it as the freshness clock.
- The field is `lon`, not `lng`. Our `properties` table uses `lng`. Convert at the seam
  and do it in exactly one place.

## Webhooks

Registered either through the developer portal or via `POST /v1/webhooks`:

```json
{ "name": "…", "url": "https://…", "authKey": "…", "events": ["tripStart"], "active": true }
```

`name`, `url`, `authKey` and a non-empty `events` array are required. Maximum 100
webhooks per application. `GET /v1/webhooks` lists them; `PUT` and
`DELETE /v1/webhooks/{webhookId}` edit and remove.

Event names accepted by the registration call: `tripStart`, `tripData`, `tripEnd`,
`tripMetrics`, `mil`, `battery`, `connect`, `disconnect`, `vinChange`, `userGeozone`,
`applicationGeozone`. Note that the registration enum says `connect` and `disconnect`
while the event payloads are documented as `deviceConnect` and `deviceDisconnect`.

### How Bouncie proves a webhook is from Bouncie

A static shared secret that we choose, echoed back on every delivery. We set `authKey` at
registration; Bouncie sends that exact value in **both** of these headers on every POST:

```
Authorization: <authKey>
X-Bouncie-Authorization: <authKey>
```

The second header exists for platforms that strip `Authorization`. Read either, prefer
checking both.

This is the same shape as the Telegram webhook's `x-telegram-bot-api-secret-token`, so
row 403 constraint (b) stands as written: a shared-secret header check inside the route,
constant-time compare, plus the route's path in `PUBLIC_API_EXACT` and a signed-out
verification.

What it is **not**: an HMAC over the request body. It proves the caller knows the secret
and nothing more. There is no payload binding and no replay protection. Compensate with
HTTPS only, a constant-time compare, and idempotency keyed on `transactionId`.

**Key rotation is a footgun.** Bouncie rotates the key when our endpoint returns a **new
value in an `Authorization` response header**. If our route ever sets that response header
for any reason, Bouncie silently adopts the new value and every later delivery fails our
check. The receiver must never set an `Authorization` response header.

### Delivery, retries, and silent death

- Respond `2xx` to acknowledge.
- Bouncie retries on timeout, non-2xx, or invalid JSON, with exponential backoff, up to a
  maximum attempt count.
- **A webhook that keeps failing is automatically deactivated** and stays off until
  someone re-enables it. Nothing tells us. This needs a staleness alarm on our side:
  if no event has arrived for a vehicle in N hours during working hours, say so on the
  map rather than showing a stale dot.
- Duplicates are expected by design, not an edge case. Bouncie runs a real-time stream and
  a periodic stream that overlap, and a device that loses cell signal buffers its trip and
  dumps it in a burst on reconnect. Deduplicate on `transactionId` plus point timestamp.

### Event payloads

All trip and geozone events carry `eventType`, `imei`, `vin`, and `transactionId`
(the trip's unique id, e.g. `123456789012345-1735920000-202501`).

| Event | Extra payload | Carries a position? |
| --- | --- | --- |
| `tripStart` | `start { timestamp, timeZone, odometer }` | **No** |
| `tripEnd` | `end { timestamp, timeZone, odometer, fuelConsumed }` | **No** |
| `tripData` | `data[] { timestamp, speed, gps { lat, lon, heading }, fuelLevelInput }` | Yes, a batch of points |
| `tripMetrics` | per-trip metrics, once at trip conclusion | — |
| `applicationGeozone` | `geozone { id, name, event: ENTER\|EXIT, timestamp, location { lat, lon, heading } }` | Yes |
| `userGeozone` | same shape, owner-created zones | Yes |
| `mil`, `battery`, `deviceConnect`, `deviceDisconnect`, `vinChange` | diagnostics | — |

**`tripStart` and `tripEnd` do not include a location.** This is the single most
plan-relevant correction to row 403, which assumed trip start/end events carried
location. Position comes from `tripData` (high volume: continuous through a trip, and the
documented bulk of webhook traffic), from a geozone event, or from polling
`GET /v1/vehicles`.

## Application Geo-Zones — server-side geofencing we would otherwise build

Bouncie can run the geofence for us. Two kinds exist:

- **User Geo-Zones** are created by the vehicle owner in the Bouncie app. They notify the
  owner and cannot be modified through the API. Not ours to use.
- **Application Geo-Zones** are created through the API, are **invisible in the owner's
  Bouncie app**, and never notify the owner. These are the ones for us.

Setup, in order:

1. `POST /v1/locations` — the geographic area, as coordinates plus a radius, or a polygon.
2. `POST /v1/schedules` — optional active time windows.
3. `POST /v1/application-geozones` — ties the location id (and schedule id) together.

Each has `GET`, `PUT` where applicable, and `DELETE` at `/{id}`.

Two things follow. First, the optional schedule is a direct answer to the after-hours
question: a zone that is only active during working hours limits what the system sees.
Second, the ENTER/EXIT event is only as good as the coordinate we register, which is
exactly why the phase-1 backfill refuses anything short of a rooftop-grade hit. A town
centroid registered as a geofence would fire ENTER for every van passing through town.

## Rate limits

**None stated.** The spec contains no mention of a rate limit, throttle, quota, or 429
anywhere. Documented status codes are 200, 201, 400, 401, 404, and 50x. The only stated
cap is 100 webhooks per application.

Treat this as undocumented rather than absent. Back off on 429 anyway, and keep the
backfill-style serial pacing on any bulk call.

## Corrections to ledger row 403

| Row 403 said | Actually |
| --- | --- |
| "auth is api_key + authorization_code" | OAuth 2.0 authorization code only. No API key exists. Tokens are per granting user, and refresh tokens rotate on every use. |
| "webhook push (trip start/end, location)" | `tripStart` and `tripEnd` carry no location. Position comes from `tripData`, a geozone event, or polling `/v1/vehicles`. |
| Constraint (b) assumed a shared-secret header check like Telegram's | Correct as written. Bouncie echoes our chosen `authKey` in `Authorization` and `X-Bouncie-Authorization`. No design change needed. |
| "docs.bouncie.dev is blocked, confirm at signup" | Confirmed from the vendor spec on 2026-08-25 from a local session. The block was the web container's egress proxy, not the vendor. |
