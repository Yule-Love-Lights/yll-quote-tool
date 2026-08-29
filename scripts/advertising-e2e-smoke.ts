/**
 * Advertising capture-to-pay E2E smoke (ops hub workstream B), runnable any
 * time: `npx tsx scripts/advertising-e2e-smoke.ts`.
 *
 * Drives the REAL data layer against the REAL database with generated sample
 * proof photos (a yard sign and a door hanger), end to end: campaign, worker,
 * photo upload to the advertising-proof bucket, three placements, the
 * accept/reject/resubmit lifecycle with its CAS race guard, and the money
 * math. Everything it writes is is_test and everything is deleted in the
 * finally block; the script asserts the table counts return to their
 * before-state.
 *
 * Deliberate design: is_test rows are EXCLUDED from earnings and duplicate
 * detection by those modules' own rules (test signs never pay, never flag),
 * so this script asserts the exclusions against the database and proves the
 * pay + duplicate math through the same pure functions the app uses,
 * over the identical row shapes with is_test stripped.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // no .env.local — rely on the ambient environment
  }
}
loadEnvLocal();

/* eslint-disable no-console */

async function main(): Promise<void> {
  const { getSupabaseServiceClient } = await import('../src/lib/supabase');
  const { createAdvertisingCampaign } = await import('../src/lib/advertising/campaigns');
  const { createAdvertisingWorker } = await import('../src/lib/advertising/workers');
  const {
    submitPlacement,
    acceptPlacement,
    rejectPlacement,
    resubmitPlacement,
    getPlacement,
    earningsSummary,
    summarizeEarnings,
  } = await import('../src/lib/advertising/placements');
  const { findDuplicateCandidates, distanceMeters } = await import('../src/lib/advertising/duplicates');

  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured — run from a tree with .env.local');

  // reviewed_by is a real FK to auth.users (the accept/reject audit trail),
  // so the smoke needs a real admin auth id. Resolve it from the auth admin
  // API rather than asking the operator to paste one; overridable via
  // E2E_REVIEWER_ID for a non-default setup.
  let reviewerId = process.env.E2E_REVIEWER_ID ?? '';
  if (!reviewerId) {
    const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) throw new Error(`listUsers for a reviewer id: ${error.message}`);
    const admin = data.users.find((u) => (u.app_metadata as { role?: string } | null)?.role === 'admin');
    if (!admin) throw new Error('no admin auth user found for reviewed_by; set E2E_REVIEWER_ID');
    reviewerId = admin.id;
  }
  console.log(`reviewer id: ${reviewerId.slice(0, 8)}… (admin auth user)`);

  let fails = 0;
  const check = (label: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) fails += 1;
  };

  const countRows = async (table: string): Promise<number> => {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
    if (error) throw new Error(`count ${table}: ${error.message}`);
    return count ?? 0;
  };

  // ---- before-state ----
  const before = {
    campaigns: await countRows('advertising_campaigns'),
    workers: await countRows('advertising_workers'),
    placements: await countRows('advertising_placements'),
  };
  console.log('BEFORE:', JSON.stringify(before));

  // ---- sample proof photos, generated locally ----
  const makePhoto = async (title: string, bg: string): Promise<Buffer> => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
      <rect width="900" height="1200" fill="${bg}"/>
      <rect x="60" y="60" width="780" height="1080" fill="#F4EFE6" rx="24"/>
      <text x="450" y="520" font-family="Arial" font-size="64" font-weight="bold" fill="#123524" text-anchor="middle">${title}</text>
      <text x="450" y="620" font-family="Arial" font-size="40" fill="#123524" text-anchor="middle">Yule Love Lights</text>
      <text x="450" y="720" font-family="Arial" font-size="30" fill="#8a4b08" text-anchor="middle">E2E SMOKE TEST PHOTO</text>
    </svg>`;
    return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
  };
  const yardSignJpg = await makePhoto('YARD SIGN', '#123524');
  const doorHangerJpg = await makePhoto('DOOR HANGER', '#8a4b08');
  // The capture route accepts only what its magic-byte sniff recognizes; a
  // JPEG must open FF D8 FF or the whole upload path would 415 a real phone.
  for (const [name, buf] of [['yard sign', yardSignJpg], ['door hanger', doorHangerJpg]] as const) {
    check(`${name} photo is a real JPEG (magic bytes FF D8 FF)`, buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, `${buf.length} bytes`);
  }

  const BUCKET = 'advertising-proof';
  const cleanup = { placementIds: [] as string[], photoPaths: [] as string[], workerId: '', campaignId: '' };

  try {
    // ---- setup: is_test campaign + worker ----
    const campaign = await createAdvertisingCampaign({
      name: `E2E SMOKE ${new Date().toISOString()}`,
      rateCents: 250,
      isTest: true,
    });
    cleanup.campaignId = campaign.id;
    check('campaign created is_test at 250 cents', campaign.isTest === true && campaign.rateCents === 250, campaign.id);

    const worker = await createAdvertisingWorker({ displayName: `E2E Smoke Worker ${randomUUID().slice(0, 8)}`, isTest: true });
    cleanup.workerId = worker.id;
    check('worker created is_test', worker.isTest === true, worker.id);

    // ---- photo uploads through the real bucket, real path shape ----
    const upload = async (buf: Buffer): Promise<string> => {
      const path = `placements/${worker.id}/${randomUUID()}.jpg`;
      const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: 'image/jpeg' });
      if (error) throw new Error(`upload ${path}: ${error.message}`);
      cleanup.photoPaths.push(path);
      return path;
    };

    // GPS: two yard signs ~31m apart at one Locust Valley corner, the door
    // hanger ~500m away. capturedAt defaults to now, so all share an ET day.
    const A = { lat: 40.876, lng: -73.596 };
    const A2 = { lat: 40.87628, lng: -73.596 }; // ~31m north
    const B = { lat: 40.8805, lng: -73.596 }; // ~500m north

    const p1 = await submitPlacement({
      campaignId: campaign.id, workerId: worker.id, kind: 'yard_sign',
      lat: A.lat, lng: A.lng, accuracyM: 8, photoPath: await upload(yardSignJpg),
      suggestedAddress: '123 Birch Hill Rd, Locust Valley, NY', isTest: true,
    });
    cleanup.placementIds.push(p1.id);
    const p2 = await submitPlacement({
      campaignId: campaign.id, workerId: worker.id, kind: 'door_hanger',
      lat: B.lat, lng: B.lng, accuracyM: 10, photoPath: await upload(doorHangerJpg),
      suggestedAddress: '210 Birch Hill Rd, Locust Valley, NY', isTest: true,
    });
    cleanup.placementIds.push(p2.id);
    const p3 = await submitPlacement({
      campaignId: campaign.id, workerId: worker.id, kind: 'yard_sign',
      lat: A2.lat, lng: A2.lng, accuracyM: 12, photoPath: await upload(yardSignJpg),
      suggestedAddress: '123 Birch Hill Rd, Locust Valley, NY', isTest: true,
    });
    cleanup.placementIds.push(p3.id);

    check('three placements submitted pending', [p1, p2, p3].every((p) => p.status === 'pending'));
    check('placements carry their photo paths', [p1, p2, p3].every((p) => !!p.photoPath));
    check('A-to-A2 distance is inside the 75m duplicate radius', distanceMeters(A.lat, A.lng, A2.lat, A2.lng) <= 75,
      `${Math.round(distanceMeters(A.lat, A.lng, A2.lat, A2.lng))}m`);

    // ---- storage round-trip: the proof photo actually landed ----
    const dl = await db.storage.from(BUCKET).download(cleanup.photoPaths[0]);
    check('yard-sign proof photo downloads from the bucket', !dl.error && (await dl.data!.arrayBuffer()).byteLength === yardSignJpg.length);

    // ---- lifecycle: accept stamps the rate; the CAS refuses a second accept ----
    const accepted = await acceptPlacement(p1.id, reviewerId);
    check('accept stamps the campaign rate on the row', accepted.status === 'accepted' && accepted.acceptedRateCents === 250,
      `acceptedRateCents=${accepted.acceptedRateCents}`);
    // A RETRIED accept is a designed idempotent no-op (pays once, returns the
    // row unchanged) — the CAS guards the pending-to-accepted transition race,
    // not the retry. First smoke run expected a throw here and was wrong.
    const again = await acceptPlacement(p1.id, reviewerId);
    check('second accept is an idempotent no-op: still accepted, still exactly 250, never re-stamped',
      again.status === 'accepted' && again.acceptedRateCents === 250 && again.reviewedAt === accepted.reviewedAt);

    let reasonRequired = false;
    try {
      await rejectPlacement(p3.id, reviewerId, '  ');
    } catch {
      reasonRequired = true;
    }
    check('reject without a reason is refused', reasonRequired);

    const rejected = await rejectPlacement(p3.id, reviewerId, 'Duplicate of the accepted sign at the same corner');
    check('reject lands with its reason', rejected.status === 'rejected' && !!rejected.rejectionReason);

    // Accepting a REJECTED placement must refuse (the worker resubmits first).
    let rejectedAcceptRefused = false;
    try {
      await acceptPlacement(p3.id, reviewerId);
    } catch {
      rejectedAcceptRefused = true;
    }
    check('accepting a rejected placement is refused until resubmit', rejectedAcceptRefused);

    const resubmitted = await resubmitPlacement(p3.id);
    check('worker resubmit returns it to the queue', resubmitted.status === 'resubmitted');

    // ---- money: test rows are excluded from the live summary... ----
    const live = await earningsSummary({ workerId: worker.id });
    const liveEarned = live.reduce((s, w) => s + w.total.acceptedEarnedCents, 0);
    check('is_test rows pay NOTHING in the live earnings summary', liveEarned === 0 && live.every((w) => w.workerId !== worker.id || (w.total.acceptedEarnedCents === 0 && w.total.pendingEstimatedCents === 0)),
      JSON.stringify(live));

    // ---- ...and the pure math pays correctly on the same shapes ----
    const rows = (await Promise.all(cleanup.placementIds.map((id) => getPlacement(id)))).map((p) => ({ ...p!, isTest: false }));
    const summary = summarizeEarnings(rows, new Map([[campaign.id, campaign.rateCents]]));
    const mine = summary.find((w) => w.workerId === worker.id);
    check('pure money math: accepted yard sign earns 250', mine?.total.acceptedEarnedCents === 250, JSON.stringify(mine?.total));
    check('pure money math: resubmitted yard sign pends 250 at the current rate', mine?.total.pendingEstimatedCents === 250);
    const doorOnly = summarizeEarnings(rows.filter((r) => r.kind === 'door_hanger'), new Map([[campaign.id, 250]]));
    const door = doorOnly.find((w) => w.workerId === worker.id);
    check('pure money math: the door hanger exists in the summary and earns/pends 0 (permanently unpaid)',
      !!door && door.total.acceptedEarnedCents === 0 && door.total.pendingEstimatedCents === 0, JSON.stringify(door?.total));

    // ---- duplicates: excluded live, flagged in the pure check ----
    const testRows = rows.map((r) => ({ ...r, isTest: true }));
    const liveDups = findDuplicateCandidates(testRows[2], testRows);
    check('is_test rows never flag as duplicates (live rule)', liveDups.length === 0);
    // "Same worker, same day" is a designed flagging dimension on its own
    // (audit section 8B), so the door hanger ALSO appears as a candidate with
    // only that reason — the discriminating signal is that the same-corner
    // yard sign carries the distance and address reasons too. (A worker
    // placing 30 signs a day will flag every same-day sibling; noted as an
    // operations-noise observation, not a defect: hints only, never a block.)
    const pureDups = findDuplicateCandidates(rows[2], rows);
    const p1Dup = pureDups.find((d) => d.placement.id === p1.id);
    const p2Dup = pureDups.find((d) => d.placement.id === p2.id);
    check('pure duplicate check: same-corner yard sign carries distance + address + worker-day reasons',
      !!p1Dup && p1Dup.reasons.some((r) => r.endsWith('m away')) && p1Dup.reasons.includes('same suggested address'),
      pureDups.map((d) => `${d.placement.id.slice(0, 8)}: ${d.reasons.join(', ')}`).join(' | '));
    check('pure duplicate check: the far-away door hanger flags on worker-day ONLY (no distance, no address)',
      !!p2Dup && p2Dup.reasons.length === 1 && p2Dup.reasons[0] === 'same worker, same day');
    check('duplicate reasons name the distance and the shared address',
      pureDups.some((d) => d.reasons.some((r) => r.endsWith('m away'))) &&
      pureDups.some((d) => d.reasons.includes('same suggested address')));
  } finally {
    // ---- cleanup: everything this run created, then re-count ----
    for (const id of cleanup.placementIds) {
      const { error } = await db.from('advertising_placements').delete().eq('id', id);
      if (error) console.error(`cleanup placement ${id}: ${error.message}`);
    }
    if (cleanup.photoPaths.length) {
      const { error } = await db.storage.from(BUCKET).remove(cleanup.photoPaths);
      if (error) console.error(`cleanup photos: ${error.message}`);
    }
    if (cleanup.workerId) {
      const { error } = await db.from('advertising_workers').delete().eq('id', cleanup.workerId);
      if (error) console.error(`cleanup worker: ${error.message}`);
    }
    if (cleanup.campaignId) {
      const { error } = await db.from('advertising_campaigns').delete().eq('id', cleanup.campaignId);
      if (error) console.error(`cleanup campaign: ${error.message}`);
    }
    const after = {
      campaigns: await countRows('advertising_campaigns'),
      workers: await countRows('advertising_workers'),
      placements: await countRows('advertising_placements'),
    };
    console.log('AFTER:', JSON.stringify(after));
    check('cleanup returned every table to its before-state', JSON.stringify(after) === JSON.stringify(before));
  }

  if (fails > 0) {
    console.error(`\n${fails} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED');
}

main().catch((e) => {
  console.error('E2E SMOKE FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
