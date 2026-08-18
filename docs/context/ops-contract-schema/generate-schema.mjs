import { readFile, writeFile } from 'node:fs/promises';
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
        key === '$ref' && typeof child === 'string'
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
assertSchemaRefs(openApi, '#/components/schemas/', openApiSchemas, 'OpenAPI');

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ops.yulelovelights.com/schemas/operations-hub/common.schema.json',
  title: 'Yule Love Lights Operations Hub shared contract schemas',
  schema_version: manifest.schema_version,
  contract_version: manifest.contract_version,
  $defs: rewriteComponentRefs(openApiSchemas),
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
