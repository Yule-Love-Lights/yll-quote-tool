// Tests for resolvePipelineStages + quoteLinkFieldId (#GHL pipeline sync).
//
//   - holiday: legacy env vars override the map when set (prod back-compat);
//     `installed`/`declined` always come from the map (no legacy env exists
//     for either).
//   - permanent / event: always the map, env vars never apply.
//   - unknown/missing service_type falls back to holiday.
//   - quoteLinkFieldId: one contact custom field id PER service_type, so a
//     send never overwrites another pipeline's drip-automation field.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolvePipelineStages,
  quoteLinkFieldId,
  quoteLinkFieldEnvVar,
  allPipelineStages,
  checkNeighborsSuppression,
  NEIGHBORS_PIPELINE_ID,
  NEIGHBORS_DECLINED_STAGE_ID,
  NEIGHBORS_DO_NOT_CALL_STAGE_NAME,
} from './ghlPipelineMap';
import type { Pipeline } from './highlevelPipelines';

const ENV_KEYS = [
  'HIGHLEVEL_PIPELINE_ID',
  'HIGHLEVEL_STAGE_QUOTE_CREATED',
  'HIGHLEVEL_STAGE_QUOTE_SENT',
  'HIGHLEVEL_STAGE_QUOTE_APPROVED',
  'HIGHLEVEL_STAGE_QUOTE_SIGNED',
  'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY',
  'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT',
  'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_EVENT',
  'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_BISTRO',
  'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR',
  'HIGHLEVEL_PIPELINE_ID_NEIGHBORS',
  'HIGHLEVEL_STAGE_NEIGHBORS_SENT',
  'HIGHLEVEL_STAGE_NEIGHBORS_DEPOSIT_PAID',
  'HIGHLEVEL_STAGE_NEIGHBORS_INSTALLED',
  'HIGHLEVEL_STAGE_NEIGHBORS_DECLINED',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('resolvePipelineStages', () => {
  it('holiday with NO env vars set falls back to the hardcoded map', () => {
    const stages = resolvePipelineStages('holiday');
    expect(stages).toEqual({
      pipelineId: 'sC6JEcxlGnNDasanlXDN',
      entry: '478396dd-a052-41ad-ae73-d528909cd5f4',
      sent: 'd15bc673-2b97-48a6-8a5c-bdf3b6e4d076',
      depositPaid: '90e7a535-689c-441e-b759-d16742bbd5a9',
      installed: 'aa6263d6-20bb-4b65-bd8c-23b75831716b',
      declined: '92090ef4-b8d6-4d68-b0f6-b4462e60d658',
      abandoned: 'eb127233-055b-44fb-a942-cefd7d6bef1f',
    });
  });

  it('holiday with legacy env vars set OVERRIDES entry/sent/pipelineId/depositPaid (prod back-compat)', () => {
    process.env.HIGHLEVEL_PIPELINE_ID = 'env-pipeline';
    process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = 'env-created';
    process.env.HIGHLEVEL_STAGE_QUOTE_SENT = 'env-sent';
    process.env.HIGHLEVEL_STAGE_QUOTE_APPROVED = 'env-approved';

    const stages = resolvePipelineStages('holiday');
    expect(stages.pipelineId).toBe('env-pipeline');
    expect(stages.entry).toBe('env-created');
    expect(stages.sent).toBe('env-sent');
    expect(stages.depositPaid).toBe('env-approved');
    // No legacy env var exists for these — always the map, even with other
    // holiday env vars set.
    expect(stages.installed).toBe('aa6263d6-20bb-4b65-bd8c-23b75831716b');
    expect(stages.declined).toBe('92090ef4-b8d6-4d68-b0f6-b4462e60d658');
    expect(stages.abandoned).toBe('eb127233-055b-44fb-a942-cefd7d6bef1f');
  });

  it('holiday depositPaid falls back to HIGHLEVEL_STAGE_QUOTE_SIGNED when APPROVED is unset', () => {
    process.env.HIGHLEVEL_STAGE_QUOTE_SIGNED = 'env-signed';
    const stages = resolvePipelineStages('holiday');
    expect(stages.depositPaid).toBe('env-signed');
  });

  it('holiday depositPaid prefers APPROVED over SIGNED when both are set', () => {
    process.env.HIGHLEVEL_STAGE_QUOTE_APPROVED = 'env-approved';
    process.env.HIGHLEVEL_STAGE_QUOTE_SIGNED = 'env-signed';
    const stages = resolvePipelineStages('holiday');
    expect(stages.depositPaid).toBe('env-approved');
  });

  it('permanent always uses the map — legacy env vars never apply', () => {
    process.env.HIGHLEVEL_PIPELINE_ID = 'env-pipeline';
    process.env.HIGHLEVEL_STAGE_QUOTE_SENT = 'env-sent';

    const stages = resolvePipelineStages('permanent');
    expect(stages).toEqual({
      pipelineId: 'OqpjVflTdgmjmUQmbcSF',
      entry: 'c052d345-8e95-4716-a7e7-62e63937b5ea',
      sent: '4e507d3d-a939-44c3-a448-250a4b0ed353',
      depositPaid: 'f4bfe29f-5d5a-4725-a6d2-1f5f19ec4010',
      installed: 'b2192f2e-eee9-4a1b-9749-4f458f007c55',
      // #235: repointed to the real Declined stage (the old note claiming
      // permanent has no dedicated Declined stage went stale — it does now).
      declined: '2714e48e-b486-457e-9da2-59893196d404', // Declined
      abandoned: '5a5f2e27-6dde-452c-8619-df1871908c8c', // Abandoned
    });
  });

  it('event always uses the map — legacy env vars never apply', () => {
    process.env.HIGHLEVEL_PIPELINE_ID = 'env-pipeline';

    const stages = resolvePipelineStages('event');
    expect(stages).toEqual({
      pipelineId: 'YfCi5jy8Alc3oD5AfXmV',
      entry: 'c6e089f5-c458-47a0-a7ae-25385df6a53f',
      sent: 'b2262023-6986-4727-98e6-638ce45aedfe',
      depositPaid: '4f6a7739-9bc9-4c27-a140-1ca9f58798fd',
      installed: '3375d0d6-0c1d-4e22-a40e-1430a771afc3',
      declined: '239ec700-bd21-49ba-9691-f0a9b44637b0',
      abandoned: 'b133090d-9890-405f-a075-16c8ee9c73e7',
    });
  });

  it('holiday with opts.envOverrides:false returns the raw map even when legacy env vars are set (F5 — website lead-capture path)', () => {
    process.env.HIGHLEVEL_PIPELINE_ID = 'env-pipeline';
    process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = 'env-created';
    process.env.HIGHLEVEL_STAGE_QUOTE_SENT = 'env-sent';
    process.env.HIGHLEVEL_STAGE_QUOTE_APPROVED = 'env-approved';

    const stages = resolvePipelineStages('holiday', { envOverrides: false });
    expect(stages).toEqual({
      pipelineId: 'sC6JEcxlGnNDasanlXDN',
      entry: '478396dd-a052-41ad-ae73-d528909cd5f4',
      sent: 'd15bc673-2b97-48a6-8a5c-bdf3b6e4d076',
      depositPaid: '90e7a535-689c-441e-b759-d16742bbd5a9',
      installed: 'aa6263d6-20bb-4b65-bd8c-23b75831716b',
      declined: '92090ef4-b8d6-4d68-b0f6-b4462e60d658',
      abandoned: 'eb127233-055b-44fb-a942-cefd7d6bef1f',
    });
  });

  it('holiday with no opts (default) still honors env overrides — existing quote-flow behavior untouched (F5)', () => {
    process.env.HIGHLEVEL_PIPELINE_ID = 'env-pipeline';
    const stages = resolvePipelineStages('holiday');
    expect(stages.pipelineId).toBe('env-pipeline');
  });

  it('permanent_bistro rides the Landscape Lighting pipeline (#117, Naldo 2026-07-11) — legacy env vars never apply', () => {
    process.env.HIGHLEVEL_PIPELINE_ID = 'env-pipeline';
    process.env.HIGHLEVEL_STAGE_QUOTE_SENT = 'env-sent';

    const stages = resolvePipelineStages('permanent_bistro');
    expect(stages).toEqual({
      pipelineId: 'GTFURwOGzGLBl2zsdl0N', // Landscape Lighting
      entry: '7e821733-a431-4545-bc65-5e14c5f02877', // New Lead
      sent: '18205538-0225-451b-aae5-5093de433004', // Bid Sent
      depositPaid: '8c7765b3-a2ba-4928-8618-5ec5a1182cb2', // Booked
      installed: 'bf068cce-4d71-480f-9bbc-bab144114e6c', // Installed
      declined: 'ad2127e1-692f-4d42-aecf-3f381793dfeb', // Declined
      abandoned: 'd9d1ebea-8b31-4651-a687-db80a7482a6a', // Abandoned
    });
    // Never the permanent pipeline (the v1 reuse this replaced).
    expect(stages.pipelineId).not.toBe(resolvePipelineStages('permanent').pipelineId);
  });

  it('legacy_rebook (#156): legacyRebook=true routes to the Neighbors pipeline for service_type holiday', () => {
    const stages = resolvePipelineStages('holiday', { legacyRebook: true });
    expect(stages).toEqual({
      pipelineId: 'TIYqklVJ349F5heaSkCs',
      entry: '9ada8238-1e95-4242-b567-7edf3bef6c2c', // Bid Sent (entry === sent for legacy rebooks)
      sent: '9ada8238-1e95-4242-b567-7edf3bef6c2c',
      depositPaid: 'da6521b1-b945-4484-8251-6c6dc487c860',
      installed: 'eb773949-401d-4e61-959c-3d5b1d92f77e',
      declined: 'abe1ed98-1091-4b70-bc6f-ae786cbea333',
      // #235: Neighbors has no dedicated Abandoned stage — reuses Declined.
      abandoned: 'abe1ed98-1091-4b70-bc6f-ae786cbea333',
    });
    // Never the Christmas Lights pipeline — the whole point of #156.
    expect(stages.pipelineId).not.toBe(resolvePipelineStages('holiday').pipelineId);
  });

  it('legacy_rebook (#156): legacyRebook=true wins regardless of service_type (positive gate checked before service-type dispatch)', () => {
    const holidayStages = resolvePipelineStages('holiday', { legacyRebook: true });
    const eventStages = resolvePipelineStages('event', { legacyRebook: true });
    const permanentStages = resolvePipelineStages('permanent', { legacyRebook: true });
    expect(eventStages).toEqual(holidayStages);
    expect(permanentStages).toEqual(holidayStages);
  });

  it('legacy_rebook (#156): legacyRebook=false or absent returns the OLD maps byte-identical (no regression)', () => {
    expect(resolvePipelineStages('holiday', { legacyRebook: false })).toEqual(resolvePipelineStages('holiday'));
    expect(resolvePipelineStages('holiday')).toEqual({
      pipelineId: 'sC6JEcxlGnNDasanlXDN',
      entry: '478396dd-a052-41ad-ae73-d528909cd5f4',
      sent: 'd15bc673-2b97-48a6-8a5c-bdf3b6e4d076',
      depositPaid: '90e7a535-689c-441e-b759-d16742bbd5a9',
      installed: 'aa6263d6-20bb-4b65-bd8c-23b75831716b',
      declined: '92090ef4-b8d6-4d68-b0f6-b4462e60d658',
      abandoned: 'eb127233-055b-44fb-a942-cefd7d6bef1f',
    });
  });

  it('legacy_rebook (#156): env overrides win over the hardcoded Neighbors ids', () => {
    process.env.HIGHLEVEL_PIPELINE_ID_NEIGHBORS = 'env-neighbors-pipeline';
    process.env.HIGHLEVEL_STAGE_NEIGHBORS_SENT = 'env-neighbors-sent';
    process.env.HIGHLEVEL_STAGE_NEIGHBORS_DEPOSIT_PAID = 'env-neighbors-deposit';
    process.env.HIGHLEVEL_STAGE_NEIGHBORS_INSTALLED = 'env-neighbors-installed';
    process.env.HIGHLEVEL_STAGE_NEIGHBORS_DECLINED = 'env-neighbors-declined';

    const stages = resolvePipelineStages('holiday', { legacyRebook: true });
    expect(stages).toEqual({
      pipelineId: 'env-neighbors-pipeline',
      entry: 'env-neighbors-sent',
      sent: 'env-neighbors-sent',
      depositPaid: 'env-neighbors-deposit',
      installed: 'env-neighbors-installed',
      declined: 'env-neighbors-declined',
      // #235: no per-env override exists for abandoned — always the hardcoded
      // Neighbors id, even with every other Neighbors env var set.
      abandoned: 'abe1ed98-1091-4b70-bc6f-ae786cbea333',
    });
  });

  it('legacy_rebook (#156): envOverrides:false returns the raw hardcoded Neighbors ids even when env vars are set', () => {
    process.env.HIGHLEVEL_PIPELINE_ID_NEIGHBORS = 'env-neighbors-pipeline';

    const stages = resolvePipelineStages('holiday', { legacyRebook: true, envOverrides: false });
    expect(stages.pipelineId).toBe('TIYqklVJ349F5heaSkCs');
  });

  it('unknown service_type falls back to holiday (the default)', () => {
    const stages = resolvePipelineStages('not-a-real-type');
    expect(stages.pipelineId).toBe('sC6JEcxlGnNDasanlXDN');
  });

  it('missing (null/undefined) service_type falls back to holiday (the default)', () => {
    expect(resolvePipelineStages(null).pipelineId).toBe('sC6JEcxlGnNDasanlXDN');
    expect(resolvePipelineStages(undefined).pipelineId).toBe('sC6JEcxlGnNDasanlXDN');
    expect(resolvePipelineStages().pipelineId).toBe('sC6JEcxlGnNDasanlXDN');
  });
});

describe('quoteLinkFieldId', () => {
  it('resolves the per-type env var for each service_type', () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_holiday';
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT = 'field_permanent';
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_EVENT = 'field_event';

    expect(quoteLinkFieldId('holiday')).toBe('field_holiday');
    expect(quoteLinkFieldId('permanent')).toBe('field_permanent');
    expect(quoteLinkFieldId('event')).toBe('field_event');
  });

  it('permanent_bistro uses its OWN Bistro field, never the Permanent one (#117, 2026-07-11)', () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_BISTRO = 'field_bistro';
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT = 'field_permanent';
    expect(quoteLinkFieldId('permanent_bistro')).toBe('field_bistro');
    expect(quoteLinkFieldEnvVar('permanent_bistro')).toBe('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_BISTRO');
    // Never Permanent's field — a bistro send/decline must not touch a
    // permanent quote's link value for a dual-quote customer.
    expect(quoteLinkFieldId('permanent_bistro')).not.toBe(quoteLinkFieldId('permanent'));
  });

  it('returns undefined when the type\'s env var is unset', () => {
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT;
    expect(quoteLinkFieldId('permanent')).toBeUndefined();
  });

  it('returns undefined when the type\'s env var is set but empty', () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_EVENT = '';
    expect(quoteLinkFieldId('event')).toBeUndefined();
  });

  it('default/unknown service_type resolves to the HOLIDAY var', () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_holiday';
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT;

    expect(quoteLinkFieldId(null)).toBe('field_holiday');
    expect(quoteLinkFieldId(undefined)).toBe('field_holiday');
    expect(quoteLinkFieldId('not-a-real-type')).toBe('field_holiday');
  });

  it('never reads the legacy shared HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK var', () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK = 'legacy_shared_field';
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;

    expect(quoteLinkFieldId('holiday')).toBeUndefined();
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK;
  });

  it('legacy_rebook (#156): legacyRebook=true resolves the NEIGHBOR field, regardless of service_type', () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR = 'field_neighbor';
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_holiday';

    expect(quoteLinkFieldId('holiday', { legacyRebook: true })).toBe('field_neighbor');
    expect(quoteLinkFieldId('holiday', { legacyRebook: true })).not.toBe(quoteLinkFieldId('holiday'));
  });

  it('legacy_rebook (#156): CRITICAL — legacyRebook=true with the neighbor field UNSET returns undefined, NEVER falls back to the holiday field', () => {
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR;
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_holiday';

    expect(quoteLinkFieldId('holiday', { legacyRebook: true })).toBeUndefined();
  });
});

describe('quoteLinkFieldEnvVar', () => {
  it('names the exact per-type env var for each service_type', () => {
    expect(quoteLinkFieldEnvVar('holiday')).toBe('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY');
    expect(quoteLinkFieldEnvVar('permanent')).toBe('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT');
    expect(quoteLinkFieldEnvVar('event')).toBe('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_EVENT');
  });

  it('default/unknown service_type names the HOLIDAY var', () => {
    expect(quoteLinkFieldEnvVar(null)).toBe('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY');
    expect(quoteLinkFieldEnvVar('not-a-real-type')).toBe('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY');
  });

  it('legacy_rebook (#156): legacyRebook=true names the NEIGHBOR var regardless of service_type', () => {
    expect(quoteLinkFieldEnvVar('holiday', { legacyRebook: true })).toBe('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR');
    expect(quoteLinkFieldEnvVar('permanent', { legacyRebook: true })).toBe('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR');
  });
});

describe('allPipelineStages (referral sweep)', () => {
  it('returns all four service-type pipelines plus Neighbors: five total', () => {
    const all = allPipelineStages();
    expect(all).toHaveLength(5);
    const pipelineIds = all.map((p) => p.pipelineId);
    expect(pipelineIds).toContain(NEIGHBORS_PIPELINE_ID);
    // Each service-type pipeline resolved WITHOUT env overrides (holiday
    // included): the four hardcoded map ids, not the legacy env vars.
    expect(pipelineIds).toContain('sC6JEcxlGnNDasanlXDN'); // Christmas Lights
    expect(pipelineIds).toContain('YfCi5jy8Alc3oD5AfXmV'); // Event Lighting
    expect(pipelineIds).toContain('OqpjVflTdgmjmUQmbcSF'); // Permanent Lighting
    expect(pipelineIds).toContain('GTFURwOGzGLBl2zsdl0N'); // Landscape (bistro)
  });

  it('every entry carries a depositPaid and installed stage id (the referral sweep\'s only two signals)', () => {
    for (const stages of allPipelineStages()) {
      expect(stages.depositPaid).toBeTruthy();
      expect(stages.installed).toBeTruthy();
    }
  });
});

describe('checkNeighborsSuppression: fail-loud suppression check (referral sweep)', () => {
  // "Declined for 2026" is a verified hardcoded id (NEIGHBORS_DECLINED_STAGE_ID);
  // "Do Not Call" has none, so its fixture stage is named NEIGHBORS_DO_NOT_CALL_STAGE_NAME
  // and gets its OWN id, distinct from the hardcoded one: resolution must find it by
  // name, not by coincidentally reusing NEIGHBORS_DECLINED_STAGE_ID.
  const DNC_LIVE_ID = 'live-do-not-call-stage-id';

  const liveNeighborsFixture = (
    stages: { id: string; name: string }[],
    pipelineId: string = NEIGHBORS_PIPELINE_ID,
  ): Pipeline[] => [{ id: pipelineId, name: 'Yule Love Lights Neighbors', stages }];

  const bothPresentStages = [
    { id: NEIGHBORS_DECLINED_STAGE_ID, name: 'Declined for 2026' },
    { id: DNC_LIVE_ID, name: NEIGHBORS_DO_NOT_CALL_STAGE_NAME },
  ];

  it('resolves both stages when present live: no missing hardcoded ids, Do Not Call id found by name', () => {
    const live = liveNeighborsFixture([...bothPresentStages, { id: 'x', name: 'some-other-stage' }]);
    const result = checkNeighborsSuppression(live);
    expect(result.missingHardcodedIds).toEqual([]);
    expect(result.doNotCallStageId).toBe(DNC_LIVE_ID);
  });

  it('matches the Do Not Call stage name case-insensitively and with whitespace trimmed', () => {
    const live = liveNeighborsFixture([
      { id: NEIGHBORS_DECLINED_STAGE_ID, name: 'Declined for 2026' },
      { id: DNC_LIVE_ID, name: '  Do Not Call  ' }, // re-cased + padded, as a live edit might leave it
    ]);
    const result = checkNeighborsSuppression(live);
    expect(result.doNotCallStageId).toBe(DNC_LIVE_ID);
  });

  it('resolves NOTHING (null) when no stage in the Neighbors pipeline matches the Do Not Call name, and names what it found', () => {
    const live = liveNeighborsFixture([
      { id: NEIGHBORS_DECLINED_STAGE_ID, name: 'Declined for 2026' },
      { id: 'some-id', name: 'Some Unrelated Stage' },
    ]);
    const result = checkNeighborsSuppression(live);
    expect(result.doNotCallStageId).toBeNull();
    expect(result.liveNeighborsStageNames).toEqual(['Declined for 2026', 'Some Unrelated Stage']);
  });

  it('never matches a same-named "Do Not Call" stage sitting in a DIFFERENT pipeline', () => {
    const live: Pipeline[] = [
      { id: NEIGHBORS_PIPELINE_ID, name: 'Yule Love Lights Neighbors', stages: [{ id: NEIGHBORS_DECLINED_STAGE_ID, name: 'Declined for 2026' }] },
      { id: 'some-other-pipeline-id', name: 'Some Other Pipeline', stages: [{ id: 'imposter-id', name: NEIGHBORS_DO_NOT_CALL_STAGE_NAME }] },
    ];
    const result = checkNeighborsSuppression(live);
    expect(result.doNotCallStageId).toBeNull();
  });

  it('reports NEIGHBORS_DECLINED_STAGE_ID as missing when it is renamed/removed from the live pipeline, even while Do Not Call still resolves', () => {
    const live = liveNeighborsFixture([{ id: DNC_LIVE_ID, name: NEIGHBORS_DO_NOT_CALL_STAGE_NAME }]);
    const result = checkNeighborsSuppression(live);
    expect(result.missingHardcodedIds).toEqual([NEIGHBORS_DECLINED_STAGE_ID]);
    expect(result.doNotCallStageId).toBe(DNC_LIVE_ID);
  });

  it('reports the hardcoded id missing AND doNotCallStageId null when the Neighbors pipeline itself is not found live', () => {
    const live: Pipeline[] = [{ id: 'some-other-pipeline', name: 'Unrelated', stages: [{ id: 'x', name: 'x' }] }];
    const result = checkNeighborsSuppression(live);
    expect(result.missingHardcodedIds).toEqual([NEIGHBORS_DECLINED_STAGE_ID]);
    expect(result.doNotCallStageId).toBeNull();
    expect(result.liveNeighborsStageNames).toEqual([]);
  });

  it('handles an empty live pipelines list the same way (everything missing/unresolved)', () => {
    const result = checkNeighborsSuppression([]);
    expect(result.missingHardcodedIds).toEqual([NEIGHBORS_DECLINED_STAGE_ID]);
    expect(result.doNotCallStageId).toBeNull();
  });
});
