# DKG execution profiles

DKG Read, Invoke DKG Program and DKG Write are native n8n HTTP components.
Their generic registry, Program adapter and execution journal contain no partner
node, graph, dataset/order, workbook revision, PLCA schema, or SSH destination.
An explicit **trusted server module** supplies those policies and a transport.
This is an extraction of the existing adapter, not a new execution engine or an
authentication implementation.

## Configuration and defaults

Set `NOS_DKG_PROFILE_MODULE` to an absolute module path **both when preparing the
native component installation and when starting its companion**. No setting
means no DKG components are advertised, and DKG effects fail closed. There is no
implicit demo/customer transport fallback. The profile is loaded once at startup.

For the existing demo, opt in to `examples/n8n-capability/profiles/jpb.mjs`.
That profile owns its existing `NOS_JPB_READ_ENABLED`, `NOS_JPB_PROGRAM_ENABLED`,
`NOS_JPB_WRITE_ENABLED` and `NOS_JPB_WORKBOOK_INPUT_FILE` settings and references
its existing `jpb-*.py`, `jpb-programs.json` and `jpb-output.mjs` demo artifacts.
These artifacts retain their deliberately restrictive host, graph, order,
workbook and evidence checks. Importing a profile makes no network calls.

The module path is operator configuration, not a browser parameter. Treat a
profile as trusted executable server code: never accept module paths, endpoints,
script names or credentials from a workflow request. Public parameter descriptors
must contain selectors only, never secrets or private connection details.

## Profile contract

The default export is validated by `dkg-profile.mjs` and contains:

- `id`, SHA-256 `revision`, public `node`, and `targetGraph`.
- Public `parameters` for all three DKG components and optional `sampleItems`.
- `programs` and `catalogRevision`: reviewed entries with node, graph, operation,
  source hash, binding digest and version, using the existing Program entry format.
- `enabled(componentId)` and `loadInputs()` for operator controls and pinned inputs.
- `validateInput(definition, input, approvedInputs)` before granting an invocation.
- `validateNode(node, rows, input)` for dataset, graph and input policy checks.
- `readRequest(node, rows, input)` and `readItems(inputRows, response, node)`;
  `readItems` must verify source scope and return the bounded normalized records.
- `evidence(rows, context, readResponse, input, programOutput)` returning
  `{ payload: { name, digest, quads }, recordCount, summary }`. It validates domain
  provenance and constructs the domain-specific output. `summary` cannot override
  the core write receipt fields.
- `transport(payload, operation)` for `read`, `invoke` or `write`. No script or
  destination is selected by the browser. The write payload includes `allowCreate`;
  false means reconcile the existing identity, never create another asset.

The transport remains responsible for verification at the actual node and for
remote idempotency; dependency injection alone does not establish those guarantees.
The generic runtime verifies Program invocation/source/binding receipts and write
scope/digest/sealed status/readback. Its journal is written before dispatch.

`test-support/measurement-profile.mjs` exercises another data shape, node, graph,
Program and output without changing the runtime. It uses an injected test
transport and is **not** a live DKG connector or live end-to-end proof.

## Revision and recovery boundary

The execution profile revision is included in each public component's parameters,
so installation/source hashes and saved workflow parameters pin it. Change the
revision whenever connections, permitted graphs, policy implementation, pinned
inputs or Program bindings change. The demo computes it from its policy and
transport artifacts. New profiles must provide the same revision discipline.

Installation and companion must use the same profile revision. Regenerate/import
components and explicitly reselect/save/approve workflow revisions when migrating.
Existing saved definitions without `profileRevision` are rejected, not silently
retargeted. The previous running demo and its stored data are not modified by this
patch. Do not delete old bindings/journals to force an upgrade.

The journal also binds each invocation to profile id and revision. Cached reads,
Program outputs and write retries cannot cross profiles. Legacy journal entries
without a profile binding fail closed. Reconcile any pending legacy execution with
its original runtime before switching; do not restart it under a new identity to
work around an ambiguous write.

This remains one operator-selected profile per companion. Existing account/owner
checks remain unchanged. Multi-account routing, automatic node discovery and new
transports are separate work; this patch does not claim to provide them.

## Local verification

Run `node --test examples/n8n-capability/*.test.mjs` from a built source checkout.
Tests select the demo profile explicitly where needed and inject transports; they
do not use the partner node. Coverage includes alternate-schema Read/Invoke/Write,
profile defaults, revision changes, provenance, receipts, ambiguous retries and
journal reopen. No service startup or external write is part of these tests.
