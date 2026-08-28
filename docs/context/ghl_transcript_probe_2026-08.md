# HighLevel transcript probe: findings and Deepgram verdict

> Read-only probe run 2026-08-28 per the calls-merge plan in
> `ops_hub_audit_2026-08.md` (workstream D). One real completed YLL call was
> probed against HighLevel's get-transcription endpoint and compared with the
> stored Deepgram transcript for the same call. No writes were made to
> HighLevel, either database, or either app. This file is the input to the
> calls merge-plan session.

## What was probed

One outbound call from 2026-08-07, 287 seconds, HighLevel message id
`ETSIkO4xkyJgwPIsl1w5`, chosen from the copilot database because it has both a
message id and a full Deepgram transcript with speaker diarization to compare
against. Endpoint:

    GET https://services.leadconnectorhq.com/conversations/locations/{locationId}/messages/{messageId}/transcription

Auth: the copilot's existing `HIGHLEVEL_API_KEY` bearer token and
`HIGHLEVEL_LOCATION_ID`. The probe was attempted with four different `Version`
headers: `2023-02-21`, `v3`, `2021-04-15`, and `2021-07-28` (the copilot's
pinned version).

## The three questions, answered

**1. Does the endpoint return YLL's calls? YES.** HTTP 200 with an 18,257-byte
transcript, 115 sentences covering the full 286-second call. And the version
question dissolves: all four Version headers returned byte-identical
responses, including the copilot's already-pinned `2021-07-28`. No version
bump is needed anywhere.

**2. Does the media channel separate the rep from the customer? YES.** Every
sentence carries `mediaChannel` (1 or 2) and a matching `speaker` field (0 or
1), perfectly consistent with each other across all 115 sentences. Checked
against the stored Deepgram diarization of the same call:

| Measure | GHL channel 1 | Deepgram speaker A | GHL channel 2 | Deepgram speaker B |
|---|---|---|---|---|
| Words | 247 | 235 | 783 | 798 |
| Speaking seconds | 54.1 | 55 | 223.2 | 215 |

Channel 1 is the customer, channel 2 is the rep (this was an outbound call and
the rep did most of the talking). The derived metrics the grading pipeline
needs all compute cleanly from sentence-level start/end times (seconds):
talk ratio 80.5 percent rep, dead air 8.9 seconds, cross-channel overlap 0
seconds on this call (interruptions are computable the same way when overlap
exists, because the channels are recorded separately).

**3. Does the newer API version break the existing sync? MOOT.** The pinned
`2021-07-28` header works on the transcription endpoint and returns identical
content to every newer version tried. Nothing needs to change version.

## Caveats for the merge plan

- **No confidence field in practice.** The docs promise a per-sentence
  confidence score; the real response has none, and the `words` arrays come
  back empty (sentence granularity only). Talk ratio, dead air, interruptions,
  question counts, and all text-based grading survive; anything that wanted
  per-word timestamps or confidence does not. Nothing in the copilot's shipped
  metrics needs word-level data.
- **One call sampled.** The channel-to-person mapping (channel 2 = rep on an
  outbound call) should be spot-checked on a handful of calls, including an
  inbound one, during the merge build before Deepgram is actually removed.
  Whether the mapping flips on inbound calls is the one open sub-question.
- **Office network quirk, not a product issue.** This machine's router/ISP DNS
  poisons `services.leadconnectorhq.com` to a filter address
  (`167.206.37.145`, an Optimum range) while resolving every other HighLevel
  host correctly. The probe worked by pinning the real Cloudflare address.
  Production (Vercel) is unaffected; local development on this network needs a
  public DNS resolver (1.1.1.1 or 8.8.8.8) or a hosts entry for that one
  host. Worth fixing on the office network at some point; not a blocker.

## Verdict

**Deepgram can be dropped.** The HighLevel transcription endpoint returns
YLL's real calls with reliable rep-vs-customer channel separation on the
already-pinned API version, and every metric the grading pipeline actually
uses computes from what it returns. The merge plan should route transcription
through this endpoint, keep a per-call fallback path in mind for calls where
HighLevel has no transcript (285 of the copilot's 450 synced recordings were
skipped as too short or junk before transcription; that filter logic stays),
and verify the inbound-call channel mapping during the build.
