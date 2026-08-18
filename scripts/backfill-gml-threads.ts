// scripts/backfill-gml-threads.ts — ONE-TIME backfill for ledger row 288's
// buried GML lead-forward customers (S40, PR #787's phase 2).
//
// WHAT IT DOES. For each of the 13 known GML-coalesced Gmail threads: build one
// NormalizedTouch per buried customer and run it through the REAL shipped write
// path (`ingestTouch` → planIngest → find-or-create contact → upsert + activity
// row) — then, where the bare-threadId row's linked contact mismatches the
// EARLIEST parsed forward's customer (4 known rows, an S39-backfill artifact),
// repoint contact_id with a direct UPDATE (planIngest's keep-existing-contact
// semantics structurally cannot repoint — #787's admin lens proved this) and
// write a dashboard_activity audit row naming old → new.
//
// TWO SOURCE MODES. STORED-RAW is the unconditional DEFAULT (#288 fix round,
// MED: auto-selecting LIVE-FETCH whenever GMAIL_* creds simply HAPPENED to be
// present was a footgun — a re-run in an environment that later grew creds
// would silently switch modes and mint 20 NEW msgId-keyed rows duplicating
// this run's bf-<epochMs> rows, a different key scheme for the SAME
// historical customers). Pass --mode=live-fetch to opt in explicitly:
//   • STORED-RAW (default): parse each row's own stored raw.messages with the
//     REAL #268 parser (parseLeadForward; the stored thread-level `from` is
//     the platform sender, so the domain+name gate still applies). Stored raw
//     predates #787 and has no per-message ids, so non-earliest customers get
//     a synthetic `${threadId}:bf-<epochMs>` external_id — provenance-marked,
//     deterministic, collision-free with real `${threadId}:<msgId>` keys.
//     ACCEPTED RESIDUAL: if one of these old threads ever receives a NEW
//     message, the poll's #787 code will mint msgId-keyed rows for the same
//     historical customers → a duplicate ROW per customer (same contact —
//     identity matches by phone), an operator-visible dup, not a
//     data-integrity break. Old threads only regain messages if Gmail
//     coalesces a future forward into them; bounded.
//   • LIVE-FETCH (--mode=live-fetch): re-fetch each thread from Gmail and run
//     the exact #787 pipeline (mapGmailThread → normalizeGmailThreadTouches) —
//     real message ids, canonical composite keys. ONLY for a from-scratch
//     environment that never ran the STORED-RAW pass: running it AFTER a
//     stored-raw run (like this one, S40) mints DIFFERENT msgId-keyed
//     external_ids for the SAME historical customers — a duplicate row per
//     customer, same operator-visible-dup class as the residual above, not a
//     data-integrity break, but pointless churn against rows that already
//     exist.
//
// IDEMPOTENT / RESUMABLE. Deterministic external_ids both modes; re-runs noop
// via planIngest (steady-state) and skip repoints already done.
//
// SAFETY: writes NOTHING without --live, and --live REFUSES unless
// BACKFILL_CONSENT names today's UTC date (the named-consent gate for a prod
// data op). The dry run prints every touch + planned repoint; READ IT.
//
// KNOWN CONSEQUENCES (consented, S40): ~20 new unresponded rows carrying real
// historical timestamps → immediately RED; the next 10-min escalate tick sends
// ONE batched team email listing them at their true ages. Buried customers under
// DISMISSED threads surface as open rows while the dismissed sibling stays
// dismissed. Serial ingest (same contact-race posture as runGmailPoll).
//
// ACCEPTED DIVERGENCE (STORED-RAW vs the shipped #787 hybrid; found, and
// verified post-run against the 13 threads, by the #288 fix round wrap
// review): touchesFromStoredRaw hardcodes direction 'inbound' and a
// PER-MESSAGE lastMessageAt even for a single-forward thread — the shipped
// hybrid (gmail.ts's normalizeGmailThreadTouches, 1-parsed shape) derives
// both THREAD-WIDE instead (isAnsweredByOutbound over every message + the
// thread's latest inbound time). The review's finding: inert for status —
// all 13 bare-threadId rows kept the statuses they had before the backfill —
// with ONE side effect: a single-forward thread that already had a staff
// reply (pre-answered) had its last_message_at/last_inbound_at regressed to
// the forward's own (earlier) time by the write-through — a cosmetic ordering
// + response-time-metric skew on that one row, not a status change. Self-
// corrects the next time that thread's poll re-ingests (the thread-wide
// derivation takes over again once a real #787 touch lands on it). (A later
// spot-check found current state consistent with this — all 13 rows show
// coherent statuses today — but couldn't independently re-isolate the
// specific regressed row: the routine reconcile cron logs hundreds of
// same-shaped 'ingested' activity rows per thread per day with no marker
// distinguishing a backfill touch from a routine poll, burying the signal by
// the time of any later check.)
//
// Usage:
//   npx tsx scripts/backfill-gml-threads.ts            # dry run (STORED-RAW)
//   BACKFILL_CONSENT=YYYY-MM-DD npx tsx scripts/backfill-gml-threads.ts --live
//   npx tsx scripts/backfill-gml-threads.ts --mode=live-fetch  # dry run, LIVE-FETCH (from-scratch envs only)
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local). GMAIL_* +
// --mode=live-fetch TOGETHER enable live-fetch mode — creds alone no longer do.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

import { getAccessToken, getThread } from '../src/lib/integrations/gmail';
import { mapGmailThread, normalizeGmailThreadTouches } from '../src/lib/dashboard/inbox/gmail';
import { ingestTouch } from '../src/lib/dashboard/inbox/store';
import { getSuppressedSenders } from '../src/lib/dashboard/inbox/suppression';
import { getSupabaseServiceClient } from '../src/lib/supabase';
import { parseLeadForward } from '../src/lib/dashboard/inbox/leadForward';
import { normalizeEmail, normalizePhone } from '../src/lib/dashboard/inbox/normalize';
import type { NormalizedTouch } from '../src/lib/dashboard/inbox/types';

// The 13 GML thread ids from the S40 prod census (2026-08-17). Comments name
// operational shape only (fwd count · prior status · linked position ·
// repoint expectation) — NEVER a customer name (repo convention, #745/#253:
// customer names never live in CODE, only in prose/ledger docs).
const THREAD_IDS = [
  '19feec226859f24c', // 6 fwds · handled · linked 4th-of-6 → repoint to earliest expected
  '19fe7e35fc05656e', // 5 fwds · handled · linked 2nd-of-5 → repoint to earliest expected
  '19fd602fd0838a7f', // 4 fwds · dismissed · linked 4th-of-4 → repoint to earliest expected
  '19fe0eae0360d0d8', // 4 fwds · handled · linked 3rd-of-4 → repoint to earliest expected
  '1a000fb33a4077b2', // 3 fwds · dismissed · linked 1st ✓ no repoint
  '1a009ff3f87344d4', // 3 fwds · dismissed · linked 1st ✓ no repoint
  '1a005cfba9315e40', // 2 fwds · dismissed · linked 1st ✓ no repoint
  '1a010398d11314c0', // 1 fwd · noop expected
  '19ff1b61d362a0f3', // 1 fwd · noop expected
  '19ff74bdf657751f', // 1 fwd · noop expected
  '19ff89f7d1d4928a', // 1 fwd · noop expected
  '1a002fb4caf23466', // 1 fwd · noop expected
  '1a008003d3985285', // 1 fwd · noop expected
];

const LIVE = process.argv.includes('--live');
// #288 fix round (MED, mode pin): STORED-RAW is the unconditional default —
// see the header doc's "TWO SOURCE MODES" note for why auto-selecting on
// isGmailConfigured() was a footgun. Only this explicit flag opts into
// LIVE-FETCH; Gmail creds being present is no longer sufficient on its own.
const LIVE_FETCH_MODE = process.argv.includes('--mode=live-fetch');

// Standalone type (#288 fix round, TS2367) — deliberately NOT `GmailThreadLite
// & {...}`. GmailThreadLite.messages is GmailMessageLite[], whose `fromMe` is
// plain `boolean`; intersecting that with `{ fromMe: boolean | string }[]`
// collapses the property back to plain `boolean` (compiler-proven — jsonb
// round-trips booleans as booleans, so the runtime coercion below was always
// dead code, `tsc --noEmit` correctly flagged the `=== 'true'` branch as
// unreachable). This type describes the STORED raw.messages shape on its own
// terms instead of inheriting a shape that doesn't match it.
type StoredRawThread = {
  subject?: string;
  from?: { email?: string; name?: string };
  messages?: { fromMe?: boolean; at: string; snippet?: string }[];
};

/** STORED-RAW mode: rebuild per-customer touches from a row's own raw payload.
 *  Mirrors #787's split semantics (earliest keeps the bare threadId; always
 *  inbound; identity/preview per message) using the REAL #268 parser. The
 *  stored thread-level `from` is the latest-inbound sender — for a GML thread
 *  that is the platform, so matchLeadForwardPlatform's domain+name gate still
 *  genuinely applies per parse. */
function touchesFromStoredRaw(threadId: string, raw: StoredRawThread): NormalizedTouch[] {
  const msgs = (raw.messages ?? [])
    .map((m) => ({
      fromMe: m.fromMe === true,
      at: new Date(m.at),
      snippet: m.snippet ?? '',
    }))
    .filter((m) => !m.fromMe);
  const parsed = msgs
    .map((m) => ({
      m,
      lead: parseLeadForward({
        fromAddress: raw.from?.email ?? null,
        displayName: raw.from?.name ?? null,
        body: m.snippet,
      }),
    }))
    .filter((c): c is { m: (typeof msgs)[number]; lead: NonNullable<ReturnType<typeof parseLeadForward>> } => c.lead !== null)
    .sort((a, b) => a.m.at.getTime() - b.m.at.getTime());
  return parsed.map(({ m, lead }, index) => ({
    source: 'gmail' as const,
    externalId: index === 0 ? threadId : `${threadId}:bf-${m.at.getTime()}`,
    sourceMessageId: null, // stored raw predates #787 — no message ids exist
    direction: 'inbound' as const,
    channel: 'email' as const,
    lastMessageAt: m.at,
    preview: m.snippet || null,
    subject: raw.subject ?? null,
    identity: {
      ghlContactId: null,
      emails: lead.email ? [lead.email] : [],
      phones: lead.phone ? [lead.phone] : [],
      displayName: lead.name,
    },
    raw,
    leadKind: 'lead' as const,
  }));
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  if (LIVE && process.env.BACKFILL_CONSENT !== today) {
    console.error(`REFUSED: --live requires BACKFILL_CONSENT=${today} (named consent, dated today).`);
    process.exit(1);
  }
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service client not configured (.env.local)');
  const liveFetch = LIVE_FETCH_MODE;
  console.log(`mode: ${liveFetch ? 'LIVE-FETCH (--mode=live-fetch)' : 'STORED-RAW (default)'} · ${LIVE ? 'LIVE WRITES' : 'dry run'}`);

  const suppressed = liveFetch ? await getSuppressedSenders() : undefined;
  const token = liveFetch ? await getAccessToken() : null;
  const ourEmail = process.env.GMAIL_USER || 'me';
  const ourDomain = ourEmail.includes('@') ? ourEmail.split('@')[1] : null;
  const internalAddrs = [process.env.HIGHLEVEL_EMAIL_FROM]
    .map((v) => (v && v.includes('<') ? v.match(/<([^>]+)>/)?.[1] : v))
    .filter((v): v is string => !!v && v.includes('@'));
  const identity = { ourEmail, ourDomain, internalAddrs };
  const now = new Date();
  let ingested = 0;
  let skipped = 0;
  let repointed = 0;

  for (const threadId of THREAD_IDS) {
    let touches: NormalizedTouch[];
    if (liveFetch && token) {
      const raw = await getThread(token, threadId);
      touches = normalizeGmailThreadTouches(mapGmailThread(raw, identity), suppressed);
    } else {
      const { data: rowWithRaw, error: rawErr } = await sb
        .from('inbox_items')
        .select('raw')
        .eq('source', 'gmail')
        .eq('external_id', threadId)
        .maybeSingle();
      if (rawErr || !rowWithRaw) {
        console.log(`thread ${threadId}: NO stored row/raw (${rawErr?.message ?? 'missing'}) — skipped`);
        continue;
      }
      touches = touchesFromStoredRaw(threadId, (rowWithRaw as { raw: StoredRawThread }).raw);
    }
    console.log(`thread ${threadId}: ${touches.length} touch(es)`);

    // #288 fix round (MED, collision guard): STORED-RAW's non-earliest key
    // (`${threadId}:bf-<epochMs>`) has no tiebreak — two non-earliest touches
    // sharing the exact millisecond would silently overwrite each other via
    // ingestTouch's find-or-create-by-external_id. Didn't fire this run (20
    // distinct contacts landed — proof by absence, not proof it can't), but
    // guard reuse: assert every touch's external_id is unique BEFORE ingesting
    // anything from this thread, and refuse the WHOLE thread on a collision
    // rather than partially ingest it. Deliberately NOT a key-scheme change —
    // the already-written bf- rows must stay byte-stable for idempotency.
    const seenExternalIds = new Set<string>();
    const collidedExternalIds = new Set<string>();
    for (const t of touches) {
      if (seenExternalIds.has(t.externalId)) collidedExternalIds.add(t.externalId);
      seenExternalIds.add(t.externalId);
    }
    if (collidedExternalIds.size > 0) {
      console.error(
        `  REFUSED thread ${threadId}: colliding external_id(s) [${[...collidedExternalIds].join(', ')}] — non-earliest timestamps tie, investigate before re-running. Thread skipped entirely.`,
      );
      continue;
    }

    for (const t of touches) {
      console.log(
        `  ${t.externalId} → ${t.identity.displayName ?? '(no name)'} ${t.identity.phones?.[0] ?? ''} [${t.direction}]`,
      );
      if (!LIVE) continue;
      // Serial on purpose — same contact find-or-create race posture as runGmailPoll.
      const res = await ingestTouch(t, now);
      if (!res.ok) {
        console.log(`    ingest FAILED: ${res.error}`);
        continue;
      }
      if (res.skipped) skipped++;
      else ingested++;
      console.log(`    ingest ok (skipped=${res.skipped}, item=${res.itemId ?? '-'}, contact=${res.contactId ?? '-'})`);
    }

    // Repoint pass: the bare-threadId row must link the EARLIEST parsed
    // forward's customer. Phone is the comparison key (every GML forward
    // carries one; contacts store E.164).
    const earliest = touches.find((t) => t.externalId === threadId);
    const earliestPhone = earliest?.identity.phones?.[0];
    if (!earliest || !earliestPhone) continue;
    const { data: row } = await sb
      .from('inbox_items')
      .select('id, contact_id, dashboard_contacts ( id, primary_phone, phones, display_name )')
      .eq('source', 'gmail')
      .eq('external_id', threadId)
      .maybeSingle();
    if (!row) {
      console.log(`  (no bare-threadId row — unexpected)`);
      continue;
    }
    // #288 fix round, TS2352: cast through unknown (this file's untyped
    // getSupabaseServiceClient() can't resolve the nested-relation
    // cardinality from the select string alone, so it infers an array shape
    // here — same "cast through unknown" idiom as store.ts's other nested
    // dashboard_contacts selects, e.g. `(data ?? []) as unknown as
    // Record<string, unknown>[]`).
    const linked = (
      row as unknown as {
        dashboard_contacts: { id: string; primary_phone: string | null; phones: string[]; display_name: string | null } | null;
      }
    ).dashboard_contacts;
    // #288 fix round (LOW): array-contains against the full `phones` list,
    // not just `primary_phone` — a phone sitting in a secondary slot (e.g. a
    // household member's own number added later) previously read as a
    // mismatch and triggered a redundant repoint even though the link was
    // already correct.
    if (linked?.phones?.includes(earliestPhone)) {
      console.log(`  link OK (${linked?.display_name})`);
      continue;
    }
    const { data: targets, error: tErr } = await sb
      .from('dashboard_contacts')
      .select('id, display_name')
      .contains('phones', [earliestPhone]);
    if (tErr || !targets || targets.length > 1) {
      console.log(`  REPOINT target lookup: ${tErr?.message ?? `${targets?.length ?? 0} matches`} — SKIPPED, investigate`);
      continue;
    }
    let target: { id: string; display_name: string | null };
    if (targets.length === 1) {
      target = targets[0] as { id: string; display_name: string | null };
    } else {
      // The earliest customer of a MISMATCH thread never gets a contact from
      // the ingest pass: their touch hits the existing bare-threadId row, and
      // planIngest keeps that row's (wrong) contact. Create theirs here from
      // the parsed identity — same shape as store.ts's contactInsertRow.
      console.log(`  REPOINT target missing — ${LIVE ? 'creating contact from parsed identity' : 'would create contact (dry run)'}`);
      if (!LIVE) continue;
      // #288 fix round (LOW, normalize parity): run through the same
      // normalizeEmail/normalizePhone pass store.ts's contactInsertRow uses —
      // idempotent on already-normalized values (parseLeadForward's output
      // already is, both source modes), kills the drift risk if that ever
      // changes upstream.
      const emails = (earliest.identity.emails ?? []).map(normalizeEmail).filter((v): v is string => v !== null);
      const phones = (earliest.identity.phones ?? []).map(normalizePhone).filter((v): v is string => v !== null);
      const { data: created, error: cErr } = await sb
        .from('dashboard_contacts')
        .insert({
          display_name: earliest.identity.displayName ?? null,
          primary_email: emails[0] ?? null,
          primary_phone: phones[0] ?? null,
          emails,
          phones,
          ghl_contact_id: null,
        })
        .select('id, display_name')
        .single();
      if (cErr || !created) {
        console.log(`  contact create FAILED: ${cErr?.message ?? 'no row'}`);
        continue;
      }
      target = created as { id: string; display_name: string | null };
    }
    console.log(`  REPOINT ${linked?.display_name ?? '(unlinked)'} → ${target.display_name}`);
    if (!LIVE) continue;
    const { error: updErr } = await sb.from('inbox_items').update({ contact_id: target.id }).eq('id', (row as { id: string }).id);
    if (updErr) {
      console.log(`  repoint FAILED: ${updErr.message}`);
      continue;
    }
    repointed++;
    // #288 fix round (MED, audit action): 'ingested' is listActivity's own
    // system-firehose exclusion (`.not('action', 'in', '(ingested,escalated)')`,
    // store.ts) — logging the repoint under that action permanently hid it
    // from /inbox/activity, undercutting the whole audit purpose of this
    // pass. 'repointed' isn't excluded (verified: dashboard_activity.action
    // is a free-text column, no CHECK constraint — migrations/2026-06-28-
    // dashboard-tables.sql; listActivity's filter is exclude-based, so a new
    // string renders) and isn't validated against any allowlist.
    await sb.from('dashboard_activity').insert({
      actor: 'system',
      action: 'repointed',
      inbox_item_id: (row as { id: string }).id,
      contact_id: target.id,
      detail: {
        backfill: '288',
        repointedFrom: (row as { contact_id: string | null }).contact_id,
        reason: 'bare-threadId row realigned to earliest forward customer (S40 named-consent backfill)',
      },
    });
  }
  console.log(LIVE ? `LIVE run complete: ${ingested} ingested, ${skipped} noop, ${repointed} repointed.` : 'Dry run complete — nothing written.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
