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
  listPipelineMapEntries,
} from './ghlPipelineMap';

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
      declined: '5a5f2e27-6dde-452c-8619-df1871908c8c', // Abandoned (no real Declined stage)
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
    });
    // Never the permanent pipeline (the v1 reuse this replaced).
    expect(stages.pipelineId).not.toBe(resolvePipelineStages('permanent').pipelineId);
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

describe('listPipelineMapEntries (WT-51 — Settings → HighLevel map diagnostics)', () => {
  it('returns one entry per service type, the raw map values (no env overrides)', () => {
    process.env.HIGHLEVEL_PIPELINE_ID = 'env-pipeline-should-not-apply';

    const entries = listPipelineMapEntries();
    expect(entries.map((e) => e.serviceType)).toEqual(['holiday', 'permanent', 'event', 'permanent_bistro']);

    const holiday = entries.find((e) => e.serviceType === 'holiday')!;
    expect(holiday.stages.pipelineId).toBe('sC6JEcxlGnNDasanlXDN'); // never the env override

    const bistro = entries.find((e) => e.serviceType === 'permanent_bistro')!;
    expect(bistro.stages.pipelineId).toBe('GTFURwOGzGLBl2zsdl0N');
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
});
