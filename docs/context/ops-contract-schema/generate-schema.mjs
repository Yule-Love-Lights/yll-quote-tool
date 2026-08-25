import { readFile, writeFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const openApiPath = resolve(directory, 'common.openapi.json');
const schemaPath = resolve(directory, 'common.schema.json');
const manifestPath = resolve(directory, 'manifest.json');
const contractPath = resolve(directory, '..', 'OPERATIONS_HUB_CONTRACT.md');

const [openApiText, manifestText, contractText] = await Promise.all([
  readFile(openApiPath, 'utf8'),
  readFile(manifestPath, 'utf8'),
  readFile(contractPath, 'utf8'),
]);

const openApi = JSON.parse(openApiText);
const manifest = JSON.parse(manifestText);

function rewriteComponentRefs(value) {
  if (Array.isArray(value)) {
    return value.map(rewriteComponentRefs);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        typeof child === 'string' && child.startsWith('#/components/schemas/')
          ? child.replace('#/components/schemas/', '#/$defs/')
          : rewriteComponentRefs(child),
      ]),
    );
  }

  return value;
}

function assertSchemaRefs(value, prefix, definitions, label) {
  if (Array.isArray(value)) {
    value.forEach((child) => assertSchemaRefs(child, prefix, definitions, label));
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref') {
      if (typeof child !== 'string' || !child.startsWith(prefix)) {
        throw new Error(`${label} contains unsupported schema reference: ${String(child)}`);
      }
      const definitionName = child.slice(prefix.length);
      if (!Object.hasOwn(definitions, definitionName)) {
        throw new Error(`${label} references missing schema: ${definitionName}`);
      }
    } else {
      assertSchemaRefs(child, prefix, definitions, label);
    }
  }
}

function assertOpenApiRefs(value, document) {
  if (Array.isArray(value)) {
    value.forEach((child) => assertOpenApiRefs(child, document));
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref') {
      const match = typeof child === 'string'
        ? child.match(/^#\/components\/(schemas|parameters)\/([^/]+)$/)
        : null;
      if (!match || !Object.hasOwn(document.components?.[match[1]] ?? {}, match[2])) {
        throw new Error(`OpenAPI contains unsupported or missing reference: ${String(child)}`);
      }
    } else {
      assertOpenApiRefs(child, document);
    }
  }
}

function assertHmacVectors(document) {
  const scheme = document.components?.securitySchemes?.YllHmac;
  const key = scheme?.['x-yll-test-key'];
  const vectors = scheme?.['x-yll-test-vectors'];
  if (key !== 'yll-contract-public-test-key-v1' || !Array.isArray(vectors)) {
    throw new Error('YllHmac must publish the approved public conformance key and vectors');
  }
  const requiredHeaders = new Set(scheme?.['x-yll-required-headers'] ?? []);
  for (const header of [
    'X-YLL-Key-Id',
    'X-YLL-Timestamp',
    'X-YLL-Nonce',
    'X-YLL-Contract-Version',
    'X-YLL-Schema-Version',
    'X-YLL-Client-Version',
    'X-YLL-Signature',
  ]) {
    if (!requiredHeaders.has(header)) {
      throw new Error(`YllHmac required headers are missing ${header}`);
    }
  }
  const canonicalFields = scheme?.['x-yll-canonical-fields'];
  if (
    !Array.isArray(canonicalFields)
    || canonicalFields.join('\n') !== [
      'v1',
      'uppercase_http_method',
      'canonical_path_and_query',
      'unix_timestamp_seconds',
      'nonce',
      'contract_version',
      'schema_version',
      'client_version',
      'lowercase_sha256_hex_of_exact_body',
    ].join('\n')
  ) {
    throw new Error('YllHmac canonical fields must sign all three version identifiers');
  }

  const validVectors = vectors.filter((vector) => vector.valid === true);
  if (validVectors.length < 2) {
    throw new Error('YllHmac must publish at least two complete positive vectors');
  }

  for (const vector of validVectors) {
    for (const field of [
      'name',
      'method',
      'raw_target',
      'canonical_target',
      'timestamp',
      'nonce',
      'contract_version',
      'schema_version',
      'client_version',
      'body_utf8',
      'body_sha256',
      'canonical_input',
      'expected_signature',
    ]) {
      if (typeof vector[field] !== 'string') {
        throw new Error(`HMAC vector ${String(vector.name)} is missing ${field}`);
      }
    }
    if (vector.method !== vector.method.toUpperCase()) {
      throw new Error(`HMAC vector ${vector.name} method must be uppercase`);
    }
    if (vector.raw_target !== vector.canonical_target) {
      throw new Error(`HMAC vector ${vector.name} positive target must already be canonical`);
    }
    if (typeof vector.version_compatible !== 'boolean') {
      throw new Error(`HMAC vector ${vector.name} must declare version_compatible`);
    }

    const bodyDigest = createHash('sha256').update(vector.body_utf8, 'utf8').digest('hex');
    const canonicalInput = [
      'v1',
      vector.method,
      vector.canonical_target,
      vector.timestamp,
      vector.nonce,
      vector.contract_version,
      vector.schema_version,
      vector.client_version,
      bodyDigest,
    ].join('\n');
    const signature = `v1=${createHmac('sha256', key).update(canonicalInput, 'utf8').digest('hex')}`;
    if (
      vector.body_sha256 !== bodyDigest
      || vector.canonical_input !== canonicalInput
      || vector.expected_signature !== signature
    ) {
      throw new Error(`HMAC vector ${vector.name} digest, canonical input, or signature is stale`);
    }
  }

  const compatibleVectors = validVectors.filter((vector) => vector.version_compatible === true);
  if (
    compatibleVectors.length < 2
    || compatibleVectors.some(
      (vector) => vector.contract_version !== manifest.contract_version
        || vector.schema_version !== manifest.schema_version,
    )
  ) {
    throw new Error('Compatible HMAC vectors must use the manifest contract and schema versions');
  }
  const skewVectors = validVectors.filter((vector) => vector.version_compatible === false);
  const skewCodes = new Set(skewVectors.map((vector) => vector.expected_error_code));
  if (
    skewVectors.length !== 2
    || skewVectors.some((vector) => vector.expected_http_status !== 409)
    || !skewCodes.has('contract_version_unsupported')
    || !skewCodes.has('schema_version_unsupported')
  ) {
    throw new Error('HMAC vectors must cover typed 409 responses for contract and schema skew');
  }

  const invalidVectors = vectors.filter((vector) => vector.valid === false);
  for (const vector of invalidVectors) {
    if (
      typeof vector.name !== 'string'
      || typeof vector.raw_target !== 'string'
      || typeof vector.rejection_reason !== 'string'
      || vector.canonical_target !== null
    ) {
      throw new Error('Every invalid HMAC vector requires name, raw_target, rejection_reason, and null canonical_target');
    }
  }
  const invalidReasons = new Set(invalidVectors.map((vector) => vector.rejection_reason));
  for (const reason of [
    'query_not_sorted',
    'literal_plus',
    'lowercase_percent_hex',
    'encoded_unreserved_byte',
    'missing_query_equals',
    'dot_segment',
    'empty_path_segment',
    'trailing_empty_path_segment',
    'fragment',
    'backslash',
    'malformed_percent_escape',
    'non_utf8_escape',
    'decoded_slash',
    'decoded_control',
    'decoded_backslash',
    'empty_query_pair',
    'raw_control',
    'missing_leading_slash',
    'bare_query',
  ]) {
    if (!invalidReasons.has(reason)) {
      throw new Error(`YllHmac conformance vectors are missing rejection case ${reason}`);
    }
  }
}

function assertCommitmentFeedContract(document) {
  const operation = document.paths?.['/api/ops/v1/commitment-events']?.get;
  if (!operation) {
    throw new Error('OpenAPI must publish the Flow H commitment-events GET operation');
  }

  if (!operation.security?.some((entry) => Array.isArray(entry.YllHmac))) {
    throw new Error('Flow H GET must require YllHmac security');
  }

  const parameterRefs = new Set(
    (operation.parameters ?? []).map((parameter) => parameter.$ref).filter(Boolean),
  );
  for (const name of [
    'YllKeyId',
    'YllTimestamp',
    'YllNonce',
    'YllSignature',
    'YllContractVersion',
    'YllSchemaVersion',
    'YllClientVersion',
  ]) {
    if (!parameterRefs.has(`#/components/parameters/${name}`)) {
      throw new Error(`Flow H GET is missing required machine-auth parameter ${name}`);
    }
  }
  const parameters = document.components?.parameters ?? {};
  if (
    parameters.YllContractVersion?.schema?.$ref
      !== '#/components/schemas/RequestedContractVersion'
    || parameters.YllSchemaVersion?.schema?.$ref
      !== '#/components/schemas/RequestedSchemaVersion'
    || document.components?.schemas?.RequestedContractVersion?.const !== undefined
    || document.components?.schemas?.RequestedSchemaVersion?.const !== undefined
  ) {
    throw new Error('Request version headers must accept syntactically valid skew for typed 409 handling');
  }

  if (
    operation.responses?.['200']?.content?.['application/json']?.schema?.$ref
    !== '#/components/schemas/CommitmentEventsPage'
  ) {
    throw new Error('Flow H GET success response must use CommitmentEventsPage');
  }
  const errorResponses = {
    409: 'VersionUnsupportedReadErrorResponse',
    410: 'CursorExpiredReadErrorResponse',
    503: 'KillSwitchedReadErrorResponse',
  };
  for (const [status, schemaName] of Object.entries(errorResponses)) {
    if (
      operation.responses?.[status]?.content?.['application/json']?.schema?.$ref
      !== `#/components/schemas/${schemaName}`
    ) {
      throw new Error(`Flow H GET ${status} response must use ${schemaName}`);
    }
  }
  const readErrorCodes = document.components?.schemas?.MachineReadErrorCode?.enum;
  if (
    !Array.isArray(readErrorCodes)
    || readErrorCodes.length !== 4
    || ![
      'cursor_expired',
      'kill_switched',
      'contract_version_unsupported',
      'schema_version_unsupported',
    ].every((code) => readErrorCodes.includes(code))
  ) {
    throw new Error('Flow H read errors must use the four approved closed error codes');
  }

  const expectedEvents = {
    QuoteSent: {
      schemaName: 'QuoteSentEvent',
      aggregateField: 'quote_id',
      performerField: 'sending_rep_employee_id',
    },
    OutboundMessageSent: {
      schemaName: 'OutboundMessageSentEvent',
      aggregateField: 'outbound_delivery_id',
      performerField: 'performed_by',
    },
    CallAttempted: {
      schemaName: 'CallAttemptedEvent',
      aggregateField: 'call_attempt_id',
      performerField: 'performed_by',
    },
  };
  const schemas = document.components?.schemas ?? {};
  if (
    schemas.CanonicalUuid?.pattern
    !== '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    || schemas.ResolvedContactRef?.allOf?.[0]?.$ref
      !== '#/components/schemas/CanonicalUuid'
  ) {
    throw new Error('Resolved contact references must use canonical Quote Tool UUIDs');
  }
  const page = schemas.CommitmentEventsPage;
  const cursorGate = page?.allOf?.find(
    (entry) => entry?.if?.properties?.has_more?.const === true,
  );
  if (cursorGate?.then?.properties?.next_cursor?.type !== 'string') {
    throw new Error('CommitmentEventsPage must require a cursor when has_more is true');
  }

  for (const [eventType, fields] of Object.entries(expectedEvents)) {
    const { schemaName, aggregateField, performerField } = fields;
    const schema = schemas[schemaName];
    const payload = schema?.allOf?.find((entry) => entry?.properties?.event_type);
    if (
      payload?.properties?.event_type?.const !== eventType
      || !payload?.required?.includes('contact_identity')
      || !payload?.required?.includes(aggregateField)
      || !payload?.required?.includes(performerField)
      || payload?.properties?.aggregate_id?.$ref
        !== '#/components/schemas/CanonicalUuid'
      || payload?.properties?.entity_version?.minimum !== 1
      || schema?.unevaluatedProperties !== false
    ) {
      throw new Error(`${schemaName} must pin event, contact, performer, aggregate, and version fields`);
    }
  }
}

function assertQuoteLifecycleContract(document) {
  const quoteEvents = document.paths?.['/api/ops/v1/quote-events']?.get;
  const paidContext = document.paths?.['/api/ops/v1/paid-contexts/current']?.get;
  const authorizationSnapshots = document.paths?.['/api/ops/v1/employee-authorization-snapshots']?.post;
  const schemas = document.components?.schemas ?? {};

  for (const [name, operation] of Object.entries({
    quoteEvents,
    paidContext,
    authorizationSnapshots,
  })) {
    if (!operation?.security?.some((entry) => Array.isArray(entry.YllHmac))) {
      throw new Error(`Flow Q ${name} must require YllHmac security`);
    }
    const parameterRefs = new Set(
      (operation.parameters ?? []).map((parameter) => parameter.$ref).filter(Boolean),
    );
    for (const parameter of [
      'YllKeyId', 'YllTimestamp', 'YllNonce', 'YllSignature',
      'YllContractVersion', 'YllSchemaVersion', 'YllClientVersion',
    ]) {
      if (!parameterRefs.has(`#/components/parameters/${parameter}`)) {
        throw new Error(`Flow Q ${name} is missing required machine-auth parameter ${parameter}`);
      }
    }
  }

  if (
    quoteEvents?.responses?.['200']?.content?.['application/json']?.schema?.$ref
      !== '#/components/schemas/QuoteEventsPage'
    || paidContext?.responses?.['200']?.content?.['application/json']?.schema?.$ref
      !== '#/components/schemas/CurrentPaidContextRead'
    || authorizationSnapshots?.requestBody?.content?.['application/json']?.schema?.$ref
      !== '#/components/schemas/EmployeeAuthorizationSnapshot'
  ) {
    throw new Error('Flow Q endpoint schemas must stay pinned to their canonical response and request shapes');
  }

  const eventTypes = schemas.QuoteLifecycleEventType?.enum;
  for (const eventType of [
    'QuoteRequestLinked', 'QuoteAssigned', 'QuoteUnassigned', 'QuoteSentRecorded',
    'QuoteRevisionSaved', 'QuotePromiseRecorded', 'QuotePromiseSuperseded',
    'QuotePromiseCancelled', 'QuotePromiseFulfilled',
  ]) {
    if (!Array.isArray(eventTypes) || !eventTypes.includes(eventType)) {
      throw new Error(`Flow Q event union is missing ${eventType}`);
    }
  }
  const lifecycle = schemas.QuoteLifecycleEvent;
  const lifecyclePayload = lifecycle?.allOf?.[1];
  const linkedRequestRule = lifecycle?.allOf?.[2];
  if (
    schemas.QuoteEventsPage?.properties?.source_watermark?.minLength !== 1
    || eventTypes.includes('QuoteRequestReceived')
    || !lifecycle?.['x-yll-cross-field-invariants']?.includes('aggregate_id_equals_quote_id')
    || !lifecyclePayload?.required?.includes('quote_id')
    || lifecyclePayload?.properties?.aggregate_id?.$ref !== '#/components/schemas/CanonicalUuid'
    || lifecyclePayload?.properties?.entity_version?.minimum !== 1
    || lifecyclePayload?.properties?.customer_ref !== undefined
    || lifecyclePayload?.properties?.customer_ref_hash?.oneOf?.[0]?.minLength !== 1
    || lifecyclePayload?.properties?.source_outbox_sequence?.minimum !== 1
    || linkedRequestRule?.then?.required?.join(',')
      !== 'request_id,request_source_system,request_source_record_id'
    || schemas.EmployeeAuthorizationSnapshot?.properties?.authorization_policy_version?.minLength !== 1
    || schemas.CurrentPaidContextRead?.oneOf?.length !== 2
  ) {
    throw new Error('Flow Q must keep quote-scoped events, linked-request source IDs, opaque customer references, outbox order, policy version, and explicit unavailable paid context');
  }
}

if (openApi.openapi !== '3.1.0') {
  throw new Error('common.openapi.json must use OpenAPI 3.1.0');
}

if (openApi.info?.version !== manifest.schema_version) {
  throw new Error('OpenAPI info.version must match manifest.schema_version');
}

if (
  manifest.openapi_file !== 'common.openapi.json' ||
  manifest.json_schema_file !== 'common.schema.json' ||
  manifest.canonical_contract !== '../OPERATIONS_HUB_CONTRACT.md'
) {
  throw new Error('manifest artifact paths do not match the canonical layout');
}

if (!contractText.startsWith(`# Operations Hub <-> Quote Tool contract, v${manifest.contract_version}\n`)) {
  throw new Error('Contract heading does not match manifest.contract_version');
}

if (!contractText.includes(`\`schema_version\` is \`${manifest.schema_version}\``)) {
  throw new Error('Contract does not declare manifest.schema_version');
}

const openApiSchemas = openApi.components?.schemas ?? {};
assertOpenApiRefs(openApi, openApi);
assertHmacVectors(openApi);
assertCommitmentFeedContract(openApi);
assertQuoteLifecycleContract(openApi);

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ops.yulelovelights.com/schemas/operations-hub/common.schema.json',
  title: 'Yule Love Lights Operations Hub shared contract schemas',
  schema_version: manifest.schema_version,
  contract_version: manifest.contract_version,
  $defs: rewriteComponentRefs(openApiSchemas),
  oneOf: [
    { $ref: '#/$defs/CommandRequest' },
    { $ref: '#/$defs/CommandResponse' },
    { $ref: '#/$defs/CommitmentEvent' },
    { $ref: '#/$defs/CommitmentEventsPage' },
    { $ref: '#/$defs/QuoteLifecycleEvent' },
    { $ref: '#/$defs/QuoteEventsPage' },
    { $ref: '#/$defs/CurrentPaidContextRead' },
    { $ref: '#/$defs/EmployeeAuthorizationSnapshot' },
    { $ref: '#/$defs/AuthorizationSnapshotReceipt' },
    { $ref: '#/$defs/AuthorizationSnapshotError' },
    { $ref: '#/$defs/MachineReadErrorResponse' },
  ],
};

assertSchemaRefs(schema, '#/$defs/', schema.$defs, 'JSON Schema');

const generated = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(schemaPath, 'utf8');
  if (current !== generated) {
    throw new Error('common.schema.json is stale; run generate-schema.mjs');
  }
  console.log(
    `OPS_CONTRACT_SCHEMA_OK schema_version=${manifest.schema_version} contract_version=${manifest.contract_version}`,
  );
} else {
  await writeFile(schemaPath, generated, 'utf8');
  console.log(`Generated ${schemaPath}`);
}
