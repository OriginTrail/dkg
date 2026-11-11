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
implicit demo/customer transport fallback. `serve.mjs` and
`setup-components-local.mjs` call `loadStudioContext()` once. That context owns
the session, profile, registry and compiler; the bridge passes the same compiler
to its provider and Studio/MCP services. Importing the registry never reads
operator configuration. Programmatic callers use `createStudioContext({ profile,
session })`; omitted profiles remain disabled, regardless of process environment.

A profile module exports either its default profile object or `createProfile({
session })`. The authenticated JPB module uses the factory so the explicit session
owns its connection pins. Profile revision hashing still covers its policy,
transport and session implementation. Changes to those implementations require
new profile pins; existing approvals are never silently rebound.

For the existing demo, opt in to `examples/n8n-capability/profiles/jpb.mjs`.
That profile owns its existing `NOS_JPB_READ_ENABLED`, `NOS_JPB_PROGRAM_ENABLED`,
`NOS_JPB_WRITE_ENABLED` and `NOS_JPB_WORKBOOK_INPUT_FILE` settings and references
its existing `jpb-*.py`, `jpb-programs.json` and `jpb-output.mjs` demo artifacts.
These artifacts retain their deliberately restrictive host, graph, order,
workbook and evidence checks. Importing a profile makes no network calls.
The workbook is validated and snapshotted at profile load. `loadInputs()` returns
copies of that snapshot; changing the file or its environment setting does not
change a running profile. Its revision includes a digest of the complete normalized
rows, including quantities and mappings. Whitespace, object-key order and the file
path do not affect that digest. The authenticated JPB profile inherits this pin.

The module path is operator configuration, not a browser parameter. Treat a
profile as trusted executable server code: never accept module paths, endpoints,
script names or credentials from a workflow request. Public parameter descriptors
must contain selectors only, never secrets or private connection details.

## Profile contract

The default export is validated by `dkg-profile.mjs` and contains:

- Common identity: `id`, SHA-256 `revision` and public `node`. Account-bound profiles
  also declare `requiresNosActor`, `accountId` and `authorize(actor)`.
- `operations`: only the supported keys from `dkg-read`, `invoke-dkg-program` and
  `dkg-write`. The registry advertises only those components; missing operations
  are rejected before dispatch, including when reopening a saved workflow.

Every declared operation owns public `parameters`, optional `sampleItems`,
`enabled()`, `validateInput(definition, input, approvedInputs)`,
`validateNode(node, rows, input)` and `transport(payload, { actor })`. Optional
`loadInputs()` supplies a pinned input snapshot; omission means no approved input
fixture. Admission validates each selected operation once, and callbacks recheck
its enable switch and node/input policy before cached responses or effects.
Transport is selected by the declared operation, never by workflow input.
`dkgComponentStore(db, profile)` accepts no separate transport or input overrides.
Tests also supply those dependencies through `operation.transport` and
`operation.loadInputs`; each distinct loader is snapshotted once per journal.

Additional fields belong only to the operation that uses them:

- Read: `readRequest(node, rows, input)` and `readItems(inputRows, response, node)`;
  `readItems` must verify source scope and return the bounded normalized records.
- Invoke: `programs` and `catalogRevision`, with the existing reviewed node,
  graph, operation, source hash, binding digest and version format.
- Write: `targetGraph` and `evidence(rows, context, readResponse, input, programContext)` returning
  `{ payload: { name, digest, quads }, recordCount, summary }`. It validates domain
  provenance and constructs the domain-specific output. `summary` cannot override
  the core write receipt fields.
  The write transport payload includes `allowCreate`; false means reconcile the
  existing identity, never create another asset.

A read-only profile needs no Program catalog, destination graph, evidence hook,
Write/Invoke parameters or throwing transport placeholders. See
`test-support/agent-read-profile.mjs` for a fictional account-bound example used
through the native MCP callback path.

Existing profiles with the original flat three-operation contract are translated
once at context/store construction into a validated runtime operation model by
`dkg-profile-legacy.mjs`. Subsequent operation lookups reuse that model and the same
shared input loader. That translation preserves their revisions, descriptor
parameter order, generated guest source and native hashes. Their original
`enabled(componentId)` switches and shared `transport(payload, operation, context)`
continue to apply. New profiles should use `operations` directly.

Completed manual Studio replays also reauthorize account-bound profile access
before disclosing output or traces. Workflow approval, component policy and
profile pins are rechecked after that asynchronous authorization, even when the
Program invocation returns its retained receipt without native callbacks.

The transport remains responsible for verification at the actual node and for
remote idempotency; dependency injection alone does not establish those guarantees.
The shared nOS writer creates/reconciles the named asset, compares exact RDF values
and requires `wm-sealed`. Each trusted profile owns its evidence vocabulary and
digest interpretation. The JPB profile validates its payload digest before calling
the writer; exact readback then confirms the same validated payload was stored.
Readback comparison decodes RDF literal escapes and preserves lexical values,
datatypes and language tags. Typed and language-tagged evidence can reconcile an
uncertain write without creating another asset; changed types or tags are refused.
The generic runtime verifies Program invocation/source/binding receipts and write
scope/digest/sealed status/readback. Its journal is written before dispatch.
After a verified Program response, the journal retains `rawOutputs` separately
from the workflow's mapped `items`. Only mapped items are returned to n8n.
The pinned incoming block selects whether a Write consumes Program provenance.
For Invoke-to-Write, the callback's presentation items must match the completed
upstream journal. The evidence hook receives those items in `rows` and a separate
`programContext: { blockId, receipt, rawOutputs }` from that journal. An ordinary
record field named `programExecution` cannot select this path. Profiles derive
attested values from `programContext.rawOutputs` and check their presentation mapping.
JPB requires the mapped assessment and records to match the single verified raw
result and its output digest. Literal substitutions are rejected before Write;
presentation fields outside the assessment and records do not become evidence.

The registry declares `requiresExportAuthorization` separately from `writes`.
Google exporters require the operator export proof; DKG Write uses the configured
profile and current account-owner authority. Installer, compiler, catalog and
Studio consumers resolve this policy through the registry. Host authorization
metadata is excluded from persisted guest descriptors to preserve source identities.

Each DKG callback verifies the native execution's recorded Receive input body
against the granted effect ID and exact input. The first authorized callback
durably binds that invocation to one effect, workflow and native execution across
all blocks. Both the initial webhook execution stack and completed Receive input
data are supported; missing, conflicting or duplicate evidence is rejected.
Retries and write reconciliation retain this binding after restart. Existing
journals with calls but no native execution binding require operator reconciliation;
they cannot acquire a new execution identity on replay.

Completed Read, Invoke and Write calls journal their exact native response
separately from operation evidence. All three replay through the same path after
current authority, profile, request and native-execution checks. Operation handlers
prepare durable requests before dispatch; evidence and response commit atomically.
Callbacks recheck the journalled request hash after asynchronous authorization,
before sharing another callback's active response. Only identical requests may
join that pending result.
Older completed rows acquire responses without transport calls, using the original
Write receipt where present. A completed legacy Write without its receipt requires
operator reconciliation. Uncertain writes retain their exact payload and reconcile
with `allowCreate: false`, including across a response-schema upgrade.

`test-support/measurement-profile.mjs` exercises another data shape, node, graph,
Program and output without changing the runtime. It uses an injected test
transport and is **not** a live DKG connector or live end-to-end proof.

## Revision and recovery boundary

The execution profile revision is included in each public component's parameters,
so installation/source hashes and saved workflow parameters pin it. Change the
revision whenever connections, permitted graphs, policy implementation, pinned
inputs or Program bindings change. The demo computes it from its policy and
transport artifacts and approved workbook snapshot. New profiles must provide the
same revision discipline.

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
Mapped-only Program journals lack the proof needed for a new calculated JPB write.
They are rejected rather than treating their mapped assessment as a verified result.
The updated JPB evidence policy changes the profile revision, so installation and
saved workflows must explicitly adopt the new revision as described above.

This remains one operator-selected profile per companion. Existing account/owner
checks remain unchanged. Multi-account routing, automatic node discovery and new
transports are separate work; this patch does not claim to provide them.

## Local verification

Run `node --test examples/n8n-capability/*.test.mjs` from a built source checkout.
Tests select the demo profile explicitly where needed and inject transports; they
do not use the partner node. Coverage includes alternate-schema Read/Invoke/Write,
profile defaults, revision changes, provenance, receipts, ambiguous retries and
journal reopen. Account tests select the profile/session before importing the real
bridge, then verify role/account fences and the actor stored by the invocation
grant. Installer tests run the real installer against a fixture CLI and SQLite,
including partial upgrades and preservation of the existing manifest on failure.
No partner service startup or external write is part of these tests.

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

## Authenticated nOS development transport

`profiles/jpb-nos.mjs` keeps the reviewed JPB/HOLOS mapping but runs Read, Invoke
and sealed WM Write through nOS's existing `NodeClient` and node-runner proxy.
It has no SSH execution fallback. The original `jpb.mjs` remains an explicitly
selected legacy demo transport; an authenticated companion refuses that profile.

Set `NOS_STUDIO_SESSION_FILE` to an absolute operator-owned JSON file:

```json
{
  "accountId": "account-example",
  "controlPlaneUrl": "http://127.0.0.1:4610",
  "runnerBindingRevision": "jpb-runner-v1",
  "secretFile": "/private/studio.secret"
}
```

Configure the same account and service secret in nOS's development `--studio-file`
option. The console sends its real dev bearer only to nOS. The companion accepts
trusted nOS account/principal/role headers, rejects fixture bearers in this mode,
and records the authenticated owner with each invocation. Every component call,
including a cached retry, rechecks owner membership through nOS. Neither the
workflow document nor n8n can supply the approving identity.

The JPB nOS profile requires an explicit `runnerBindingRevision`. Change this
operator-owned revision whenever the runner/node binding behind the control plane
changes, even if its URL stays the same. The account, normalized control-plane URL
and binding revision are pinned with the shared business policy and the nOS
transport implementation. A changed connection requires newly installed component
revisions and workflow approval; existing invocations cannot reuse their cached
reads or resume pending writes through that connection. Credential rotation alone
does not change the connection identity. SSH scripts contribute only to the SSH
profile revision; both transports compose their policy from `jpb-policy.mjs`.
The nOS transport now uses the shared bounded-response reader with its existing
2 MiB ceiling. This source change intentionally creates a new JPB nOS profile
revision: reinstall the components and explicitly reselect/save/approve affected
workflows before using it. The SSH revision is unchanged; existing invocation
identities are not rebound to the new nOS revision.
Their reviewed read selection, assertion partitions, snapshot, field mapping and
provenance labels live in `profiles/jpb-read-spec.json`. `jpb-read-policy.mjs`
constructs the query once; nOS uses it directly and the SSH bundle embeds the
same compiled specification. Python retains host/authentication checks and RDF
decoding, with domain checks driven by that specification. Both profile revisions
include the captured specification and common policy bytes. Changes require new
component/workflow pins as described above; running profiles retain their snapshot.

Each companion state belongs to one account. A persisted `nos-account.json`
prevents rebinding or reopening it as a kit-only service. To deliberately migrate
an existing operator-owned demo state, set `adoptExistingState: true` once; legacy
active schedules must first be deactivated. Do not use this flag to move tenant
state between accounts. This integration exposes manual execution only.
The account marker is committed only after startup eligibility checks succeed.
Rejected adoption leaves an unbound legacy state reopenable for deactivation;
existing account markers are checked before opening its database and remain fenced.

Install the current native component profile and explicitly save a new workflow
revision after switching transports. Old invocations cannot be rebound to a new
account, principal or profile. The JPB nOS example exposes the reviewed mapped
PLCA demo calculator; its assumptions remain explicit and are not measured LCA
factors or a certified impact assessment.

The invocation journal stores profile ID/revision and owner alongside the run.
Startup migrates existing profile/actor records into that row in one transaction;
missing metadata remains null and cannot be supplied by a retry. Existing scoped
runs retain their cached component responses, pending writes and native execution
binding. Complete the upgrade with the companion stopped; older binaries use the
superseded metadata tables. Keep the database backup for a binary rollback.

For managed nodes nOS checks the existing job/account/ready state. An existing
external demo node uses an explicit development runner binding, not an inferred
permission from fleet monitoring. Its node-host credential remains held by the
runner. An SSH tunnel may carry HTTP to the loopback runner, but no workflow step
executes scripts over SSH or exports the node credential. See nOS
`docs/l1/STUDIO-DKG-ACCESS.md` for configuration and the standalone bundle.

The Write transport requests private WM creation/finalization, verifies exact
quads and digest, and requires `wm-sealed`. It never requests VM publication or
SWM sharing. After an uncertain creation, retry reads/reconciles the existing
name and refuses another create. This differs intentionally from the existing
Workflows release publisher's `saved` draft contract; `nos-publish-adapter.mjs`
continues to expose that contract and is not used to manufacture a sealed receipt.

A Write journals its original callback, exact evidence payload and confirmed
receipt in the companion SQLite database. If both native HTTP attempts fail,
**Run with the same invocation ID** can reconcile that journal even after the
native adapter has persisted a terminal failed execution. Reconciliation repeats
the current owner, workflow/source, profile and native-execution checks and uses
`allowCreate: false`; it does not dispatch another workflow. While a write is
unconfirmed, a new invocation of that saved workflow is refused.

The Run API returns `DKG_WRITE_PENDING` with the original `invocationId` while
readback is unavailable. Retain that identity and the original inputs for retry.
After confirmation, `dkgRecovery.status: "confirmed"` and its `receipt` describe
the recovered write. The original `output` and step trace still describe the
native failure; recovery does not claim that n8n completed successfully or alter
the persisted Graph Computer receipt. The write receipt is stored in the
companion journal and identifies the sealed asset whose contents were read back.
An unresolved legacy write without a saved request remains blocked for operator
reconciliation; it is never reconstructed from new inputs or silently recreated.

Local integration verification (fictional HTTP node, no JPB data or connection):

```sh
node --import /path/to/tl-nos/node_modules/tsx/dist/loader.mjs \
  examples/n8n-capability/verify-nos-runner.mjs /path/to/tl-nos
node --test examples/n8n-capability/*test.mjs
```

The verifier traverses nOS identity/role checks, trusted companion headers,
service callbacks, the real NodeClient and the real HTTP node proxy, then checks
Program execution, sealed readback, stable retries, source-pin refusal and owner
revocation. Live JPB activation and results must be reported separately.
