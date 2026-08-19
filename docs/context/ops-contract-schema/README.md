# Operations Hub shared contract schema

This directory is the Quote Tool-owned canonical machine-readable companion to
`../OPERATIONS_HUB_CONTRACT.md`.

- `manifest.json` pins the independent schema and contract versions.
- `common.openapi.json` is the OpenAPI 3.1 source for the common command,
  response, event, enum, and machine-auth components. It includes the first
  complete operation, Flow H's commitment-event pull feed.
- `common.schema.json` is generated from the OpenAPI component schemas.
  Its root accepts only a command request, command response, typed commitment
  event, commitment-event page, or typed machine-read error; consumers may also
  validate a named `$defs` entry directly.

Generate or verify the JSON Schema with Node.js:

```sh
node docs/context/ops-contract-schema/generate-schema.mjs
node docs/context/ops-contract-schema/generate-schema.mjs --check
```

The Operations Hub vendors `manifest.json`, `common.openapi.json`, and
`common.schema.json` byte-for-byte. It does not vendor the generator or this
README. Endpoint PRs append their OpenAPI fragments and extend the generated
schema under the contract's section 10 process.
