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

## Existing nOS publish adapter (server integration seam)

`nos-publish-adapter.mjs` exports `createNosPublishAdapter({ db, accountId,
publish })`. Its `publish(accountId, request)` dependency consumes the existing
nOS `createWorkflowPublishService(controller).publish` contract. A host using the
existing account-bound `createPublishClient` may inject
`(account, request) => clientFor(account)(request)` instead. It must select that
client from trusted account configuration, never a request-supplied URL.

The authenticated host calls `adapter.execute(actor, input)`. `actor` contains
`{ id, accountId, role }` resolved by the existing nOS identity/account boundary
for that request. **Never construct actor from workflow parameters, browser JSON,
kit selectors or unverified headers.** The adapter checks owner/account scope;
it does not authenticate actors and is not a replacement identity provider.

Input contains `invocationId` (UUID v4), `blockId`, `workflowRef`, `workflowHash`,
`profileRevision`, `layer`, `graphName`, `assetName`, and approved `nquads` (up to
64 KiB, also subject to the control plane's own limits). It cannot choose a node
URL, SSH host, credential, principal or account. nOS's publisher chooses the
account's supported node. This does not add support for selecting the JPB fleet
host as a managed account job.

The adapter commits the request before dispatch, derives a stable ID from
account/invocation/block, and refuses changed content, profile, workflow or
approving principal under that ID. Lost replies retry the same request through
nOS's existing idempotency path. Completed receipts are cached; an authenticated
host must still resolve the current actor/role before every replay. An uncertain
request must be reconciled through the existing publisher, not restarted with a
new invocation ID. The SQLite database and its lifecycle belong to the host.

The receipt preserves nOS's actual `running`, `saved`, `published` or `failed`
state, node/job, asset, action and content hash. **`saved` in Working Memory means
a draft, not a sealed assertion.** It does not manufacture `readbackVerified`,
`wm-sealed`, an assertion hash or a UAL. Consequently this adapter is not a drop-in
replacement for the current JPB `transport(payload, 'write')` sealed receipt.
A host integration must expose these distinct output semantics to its component.

This seam is tested but is **not mounted into the current demo HTTP bridge or
component registry**. The local demo must not receive the workflows service
credential. Trusted host mounting, UI/component receipt support and the
Read/Program runner contract remain outstanding. No new HTTP auth handlers or
runner permissions have been added.

For an offline cross-repository contract check against an nOS checkout:

```sh
node --import /path/to/tl-nos/node_modules/tsx/dist/loader.mjs \
  examples/n8n-capability/verify-nos-publish.mjs /path/to/tl-nos
```

This executes the real nOS publish client and workflows HTTP handler in process,
including service authentication and response handling, with a labelled publisher
fixture. It checks lost-response retry identity, cross-account/wrong-secret
refusal and no customer bearer forwarding. It starts no server and proves no live
DKG write. The nOS publisher's own regression suite covers its node-action path.
