# Native output authority and helper pinning — 2026-11-09

Addresses the two P1 findings in review 5827912965 of #3446 at b850561e78.

## Output authority

The operator installation now pins a canonical digest of the result selection
and output schema. Tenant-selected nodes, ports, sinks, trace and observation
policy must match before approval or execution; missing pins fail closed.
Installation changes also fence inspection of an acknowledged execution. The
companion installs only its operator-owned manifest/generated grant projections.

The signed-handler/TypeScript/Wasm/SQLite regression covers direct webhook input,
a header-copying node, sink/trace redirection, missing pins, and safe node/sink/trace
outputs. Unauthorized new approvals and invocation under a tightened installation
are refused before any provider call. Synthetic credentials are absent from
returned results, traces, receipt output queries and errors.

## Embedded helpers

The current template embeds helper JSON without a database ID. A parent digest
therefore covers helper output and effects. Both runtime adapters recursively
reject database, URL, file, expression-selected and ID-bearing embedded helpers
before webhook dispatch. Legacy templates/source serialization remain unchanged;
their unpinned executions require a newly installed component and Studio revision.
Compiler contract 5 applies only to Studio graphs containing the helper component.

## Real n8n check

An isolated n8n 2.43.8 (Node 24.22.0) executed the generated standalone and Studio
embedded-helper workflows through the actual native adapter. Executions 14 and 16
returned the approved record and expected trace. A separate published database
helper was changed to return different output and to POST to a local counted
endpoint. Current embedded definitions retained their reviewed behavior. Both
legacy standalone and legacy Studio parents, pointing at that changed helper,
were refused by adapter preflight. The local effect counter remained zero.

This used synthetic records, a disposable operator credential and a loopback
n8n fixture. It did not use Google, a customer node, partner data or production.
The real engine check is separate from the signed-runtime regression above.

## Checks

Run with Node 26.12.1 and the locked workspace dependencies:

```sh
node --test scripts/lib/__tests__/n8n-components.test.mjs scripts/lib/__tests__/n8n-studio.test.mjs scripts/lib/__tests__/n8n-studio-retired.test.mjs examples/n8n-capability/*.test.mjs
cd packages/cli
pnpm exec vitest run --config vitest.unit.config.ts test/semantic-runtime-n8n-native.test.ts test/semantic-runtime-n8n-adapter.test.ts test/semantic-runtime-configuration-api.test.ts -t 'native|n8n|operator authority|mutable helper'
pnpm run build:compile
pnpm run test:types
```

Root lint and whitespace checks are also required. Hosted CI and independent
review must validate the pushed revision before merge; this is not a deployment.
