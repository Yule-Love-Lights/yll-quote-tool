import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const schemaDirectory = fileURLToPath(new URL('.', import.meta.url));

type EventRule = {
  if?: { properties?: { event_type?: { const?: string; enum?: string[] } } };
  then?: { required?: string[] };
  required?: string[];
  properties?: Record<string, unknown>;
};

type OpenApiDocument = {
  schema_version?: string;
  contract_version?: string;
  components?: {
    schemas?: {
      QuoteLifecycleEvent?: EventRule & {
        allOf?: EventRule[];
        'x-yll-cross-field-invariants'?: string[];
      };
      QuoteLifecycleEventType?: { enum?: string[] };
    };
  };
};

async function readJson(name: string) {
  // `file://${schemaDirectory}` only works where an absolute path starts with
  // "/". On Windows schemaDirectory is `C:\Users\...`, so the template
  // produced `file://C:\Users\...` and `.pathname` came back as
  // `/C:/Users/...`, which readFile resolved against the drive root as
  // `C:\C:\Users\...` — ENOENT. CI runs on Linux, so the whole suite stayed
  // green there while every Windows checkout (both devs') had three red tests.
  // schemaDirectory is already a real filesystem path; just join to it.
  return JSON.parse(await readFile(join(schemaDirectory, name), 'utf8')) as OpenApiDocument;
}

function quoteLifecyclePayload(openApi: Awaited<ReturnType<typeof readJson>>) {
  return openApi.components?.schemas?.QuoteLifecycleEvent?.allOf?.[1];
}

function conditionalRule(openApi: Awaited<ReturnType<typeof readJson>>, eventType: string) {
  return openApi.components?.schemas?.QuoteLifecycleEvent?.allOf?.find(
    (rule) => {
      const eventRule = rule.if?.properties?.event_type;
      return eventRule?.const === eventType || eventRule?.enum?.includes(eventType);
    },
  );
}

function requiredFields(rule: EventRule | undefined) {
  if (!rule?.then?.required) throw new Error('Flow Q event rule is missing required fields');
  return rule.then.required;
}

describe('Flow Q v1.6 contract', () => {
  it('keeps every feed event quote-scoped and removes pre-quote request events', async () => {
    const [manifest, openApi] = await Promise.all([
      readJson('manifest.json'),
      readJson('common.openapi.json'),
    ]);
    const payload = quoteLifecyclePayload(openApi);
    const eventTypes = openApi.components?.schemas?.QuoteLifecycleEventType?.enum;
    if (!payload?.properties || !payload.required) throw new Error('Flow Q lifecycle payload is missing');

    expect(manifest.contract_version).toBe('1.6.0-draft');
    expect(manifest.schema_version).toBe('1.2.0-draft');
    expect(eventTypes).not.toContain('QuoteRequestReceived');
    expect(payload.required).toEqual(expect.arrayContaining([
      'quote_id',
      'event_type',
      'source_outbox_sequence',
    ]));
    expect(payload.properties.aggregate_id).toEqual({
      $ref: '#/components/schemas/CanonicalUuid',
    });
    expect(payload.properties.entity_version).toEqual({ type: 'integer', minimum: 1 });
    expect(openApi.components?.schemas?.QuoteLifecycleEvent?.['x-yll-cross-field-invariants'])
      .toContain('aggregate_id_equals_quote_id');
  });

  it('requires source identifiers for linked requests and forbids raw customer identifiers', async () => {
    const openApi = await readJson('common.openapi.json');
    const payload = quoteLifecyclePayload(openApi);
    const linkedRequestRule = conditionalRule(openApi, 'QuoteRequestLinked');
    if (!payload?.properties) throw new Error('Flow Q lifecycle payload is missing');

    expect(payload.properties.customer_ref).toBeUndefined();
    expect(payload.properties.customer_ref_hash).toBeDefined();
    expect(requiredFields(linkedRequestRule)).toEqual(expect.arrayContaining([
      'request_id',
      'request_source_system',
      'request_source_record_id',
    ]));
  });

  it('requires the source evidence needed by waits, sends, delivery, and promises', async () => {
    const openApi = await readJson('common.openapi.json');

    expect(requiredFields(conditionalRule(openApi, 'QuoteWorkWaitStarted')))
      .toEqual(['work_wait_reason']);
    expect(requiredFields(conditionalRule(openApi, 'QuoteSentRecorded')))
      .toEqual(['first_sent_at', 'first_send', 'delivery_mode', 'total_cents']);
    expect(requiredFields(conditionalRule(openApi, 'QuoteDeliveryAttempted')))
      .toEqual(['delivery_attempt_id', 'delivery_channel', 'delivery_attempted_at']);
    expect(requiredFields(conditionalRule(openApi, 'QuoteDeliveryOutcomeRecorded')))
      .toEqual(['delivery_attempt_id', 'delivery_outcome', 'delivery_resolved_at']);
    expect(requiredFields(conditionalRule(openApi, 'QuotePromiseRecorded')))
      .toEqual(['promise_id', 'promise_type', 'promise_due_at']);
  });
});
