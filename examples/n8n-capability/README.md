> DKG components now require an explicit operator-selected execution profile.
> See [DKG execution profiles](./DKG-PROFILES.md) before installing or running them.
> The JPB sections below describe the opt-in demo policy, not generic component defaults.

# Invoke an n8n capability as a Program KA

An agent invokes `urn:demo:n8n:normalize-text:1` through the ordinary signed Graph
Computer API. The approved TypeScript Program calls `urn:dkg:tool:n8n`; the host
executes a pinned n8n workflow and returns its actual output and execution ID.
The usual KA lifecycle persists the execution record in private Working Memory.

The example uses n8n's built-in Edit Fields node to trim and uppercase a text
input, between an authenticated Webhook and Respond to Webhook. Its definition,
input/output schemas and exact workflow digest are stored with the Program.
The caller supplies the KA reference and input; it never supplies an n8n URL,
workflow ID, credential or executor.

## Local prerequisites

- This Graph Computer branch, with locked workspace dependencies and runtime
  packages built (`pnpm install --frozen-lockfile`, `pnpm build:runtime:packages`).
- Node 26.8.2 for the DKG/Wasm host. Use the repository's Node baseline for other
  packages when appropriate.
- A separate n8n 2.43.8 installation using Node 24.22.0. Install it outside the
  DKG/nOS workspaces, for example `npm install --prefix /tmp/n8n-ka-runtime n8n@2.43.8`.
- A new private state directory and unused loopback ports 45679 and 4631.

Run n8n in its own terminal, with its Node 24.22 executable selected:

```sh
N8N_USER_FOLDER=/tmp/n8n-ka-state/n8n N8N_LISTEN_ADDRESS=127.0.0.1 \
N8N_HOST=127.0.0.1 N8N_PORT=45679 N8N_PROTOCOL=http N8N_SECURE_COOKIE=false \
N8N_DIAGNOSTICS_ENABLED=false N8N_VERSION_NOTIFICATIONS_ENABLED=false \
N8N_SSRF_PROTECTION_ENABLED=true \
/tmp/n8n-ka-runtime/node_modules/.bin/n8n start
```

From this checkout, using Node 26.8.2:

```sh
node examples/n8n-capability/setup-n8n.mjs /tmp/n8n-ka-state http://127.0.0.1:45679
node examples/n8n-capability/serve.mjs /tmp/n8n-ka-state
```

Setup applies only to a fresh, owned instance. It creates a disposable owner,
private credential files, the workflow and a private 24-hour API key for this isolated instance.
The optional fixture-mutation check uses the same existing local key.
Do not commit the state directory.

The server starts a real DKGAgent, persistent Oxigraph store, standard KA-number
allocator, signed HTTP authentication/nonce store and Graph Computer runtime.
It uses `MockChainAdapter` for local chain identity; it makes no public-chain
transactions. Its startup proof calls the actual n8n workflow, reads the DKG
receipt back and retries the same invocation. The proof is `evidence.json`.

In another terminal:

```sh
node examples/n8n-capability/invoke.mjs /tmp/n8n-ka-state/client.json '  hello dkg  '
node examples/n8n-capability/verify.mjs /tmp/n8n-ka-state --check-workflow-change
node examples/n8n-capability/compose.mjs /tmp/n8n-ka-state
```

The invocation prints `HELLO DKG`, the n8n execution identity and a persisted DKG
execution reference. An optional fourth argument to `invoke.mjs` supplies a UUID
for a completed retry. Keep the UUID and input together.

`compose.mjs` stores an approved parent Program KA, invokes the child KA through
`invoke_program`, and records parent/child execution references plus the actual
n8n result `COMPOSED DKG`. Its completed retry returns the same receipt.

## Three CSV component KAs

To extend this same owned instance, stop the example DKG server and run:

```sh
node examples/n8n-capability/setup-csv.mjs /tmp/n8n-ka-state
node examples/n8n-capability/serve.mjs /tmp/n8n-ka-state
```

This installs three independent Program KAs with pinned n8n workflow definitions:

| KA | Real n8n nodes | Input and output |
| --- | --- | --- |
| Parse CSV | Convert to File → Extract From File | UTF-8 CSV → ordered columns and rows |
| Map fields | Edit Fields | Table plus source indexes/output names → selected, renamed table |
| Export to Google Sheets | Google Sheets (create) → Split Out → Edit Fields → Google Sheets (append) | Mapped table/title → new spreadsheet ID and URL |

The parser accepts quoted fields, embedded newlines and BOM. This PoC limits CSV
input to 2 KiB, 8 columns, 20 data rows and 128 characters per cell. Invalid CSV
returns a confirmed `ok: false` result, so the user can correct it. Mapping rejects
duplicate/unsafe output names and mismatched row widths before dispatch. Google
Sheets values use `RAW` so text is not interpreted as formulas.

In nOS, select **CSV pipeline** under **Invoke a KA**. Upload or paste CSV, parse
it, select/rename columns, apply the mapping, preview the rows and download the
mapped CSV. Each step has its own KA reference, revision and execution receipt.

```sh
node examples/n8n-capability/verify-csv.mjs /tmp/n8n-ka-state
node examples/n8n-capability/compose-csv.mjs /tmp/n8n-ka-state
```

Verification uses actual n8n execution data and private DKG receipt readback. It
checks quoted multiline CSV/BOM, column mapping, malformed input, duplicate names
and completed retries without another n8n execution. The composition example
invokes the parser and mapper KAs from an approved parent Program using
`invoke_program`. Prepared invocation identities are saved before dispatch;
retain them for reconciliation if a call fails.

### Connect Google Sheets

Until Google is connected, its workflow remains an inactive draft and its KA is
listed as unavailable. In the local n8n editor, connect an operator-owned **Google
Sheets OAuth2 API** credential. A Google connection in ChatGPT cannot be reused
as an n8n credential.

For self-hosted n8n, enable the Google Sheets and Drive APIs in your Google Cloud
project. Create a web OAuth client using the exact callback URL displayed by n8n,
then enter its client ID and secret in the credential editor. Enable custom
scopes with `https://www.googleapis.com/auth/drive.file`; it allows this PoC to
create and write its own spreadsheet. Add your account as a test user if the
OAuth app is in Testing, then use **Sign in with Google** and confirm that n8n
shows **Account connected**.

Stop the example DKG server, then run setup with that existing credential's ID
and restart the server:

```sh
node examples/n8n-capability/setup-csv.mjs /tmp/n8n-ka-state EXISTING_CREDENTIAL_ID
node examples/n8n-capability/serve.mjs /tmp/n8n-ka-state
```

Setup publishes a new pinned Google export workflow and creates a private
`google-export-token` file in the state directory. Enter its value only into the
operator export key field in the console. The public kit login cannot authorize
Google writes. The key is sent as a header; it is excluded from KA inputs,
receipts and browser storage. n8n retains the Google OAuth token itself.

To intentionally create one new Google Sheet and verify its completed replay:

```sh
node examples/n8n-capability/verify-csv.mjs /tmp/n8n-ka-state --export
```

This verification reuses its saved export invocation; it does not blindly create
a second Sheet on rerun. A lost or partial Google response needs inspection: the
create and append nodes are separate external effects inside one n8n workflow.
Google creation and writes are only proven after running against a connected
account; saving the workflow alone does not prove them.

Verification checks replay without an additional n8n execution, invalid input,
unauthorized signed callers, viewer/foreign-account refusal and stale KA pins.
`--check-workflow-change` temporarily edits the owned fixture, proves dispatch is
blocked, and restores its exact definition in `finally`.

Stop the DKG server and n8n with Ctrl+C in their own terminals. Retain state for
inspection; only the processes started for this example should be stopped.

## nOS canvas

Use the companion nOS branch based on Ziga's PR #934. Start its normal L1 local
kit, then enable `VITE_NOS_N8N_SPIKE=1 VITE_NOS_KA_POC=1 NOS_KA_POC_PROXY=1` for
the console development server. Network → Workflows → Invoke a KA queries this
DKG node, places the capability on the existing canvas and invokes the same
Program path. The bridge is a loopback-only account-A fixture, using public kit
selectors; production identity integration is separate work.

The **CSV KA builder** tab keeps the original four-component editor. It lets the account owner drag installed KA blocks,
connect compatible ports and configure mapping or a Google Sheet title. Save
creates a private, finalized Program KA whose source includes the graph/layout
and whose explicit child grants pin the selected capability versions. Open reads
saved versions back from DKG; edits create another immutable revision. Run invokes
the parent Program through `invoke_program`, verifies parent/child receipts and
returns each actual n8n execution reference. This PoC supports a single path of
one to eight blocks. CSV/text data is supplied at run time, outside saved source.

Google-containing workflows require the private operator export key for both
save and run. Invalid CSV, missing mapped columns or incompatible Google headers
stop before downstream calls with a confirmed result the user can correct.
Uncertain outcomes retain the original invocation for reconciliation.

## Native components and nOS Studio

The **Workflow builder** tab now opens **n8n KA Studio**, with thirty-one separately
registered component Programs. Every leaf KA declares its exact native workflow
ID, definition hash, bounded input/output schemas and selected result nodes in
its owner-approved n8n grant. Credentials stay in the local n8n installation.

| Group | Components |
| --- | --- |
| Data | Edit Fields, Filter, Sort, Limit, Remove Duplicates, Split Out, Aggregate, Summarize, Rename Keys, Date & Time |
| Files | Extract From File, Convert to File, XML, HTML, Markdown, Crypto, Compression |
| Integrations | HTTP Request, Google Sheets, Google Drive |
| Flow | IF, Switch, Merge, Merge by fields, Compare Datasets, Loop Over Items, Execute Sub-workflow, Stop And Error |
| Events | Webhook, Schedule Trigger, Wait |

**Merge by fields** is a separate component revision; existing append-only Merge workflows
keep their original pins and behavior. Select the exact field in input A and input B and choose
`keepEverything` (full outer join), `keepMatches`, or `keepNonMatches`. Matching is case-sensitive
with fuzzy comparison disabled. All matches are retained, including one-to-many/many-to-many
results, within the existing twenty-record/8 KiB result bound. Overlapping properties prefer
input A; map independent provenance into separate named fields before joining to preserve both.
With `keepNonMatches`, native n8n adds `_source: input1` or `_source: input2` to identify
the unmatched input (and overwrites any existing `_source` property).
This exposes n8n's native Merge v3.2 settings; no new join engine or domain-specific mapping is added.

Provision the installed local n8n runtime with its official CLI while that owned
instance is stopped. The installer resolves credential references (never tokens),
takes a SQLite backup, imports native templates and publishes action flows.
Schedule components remain inactive until a saved workflow is activated.

Installation and companion startup use the authenticated webhook credential from
the bootstrap workflow pinned by `n8n.json`. A missing, edited or ambiguous bootstrap
workflow stops setup before import. Other workflows cannot select this credential.
For Studio Google connections, put the operator-selected references in
`/tmp/n8n-ka-state/studio-connections.json` before installation and restart:

```json
{
  "googleSheetsOAuth2Api": { "id": "EXISTING_SHEETS_ID", "name": "My Sheets connection" },
  "googleDriveOAuth2Api": { "id": "EXISTING_DRIVE_ID", "name": "My Drive connection" }
}
```

Omit connections you do not want to enable; `{}` disables both for new Studio
templates. IDs must exist in this n8n instance with the matching credential type.
When this file is absent, the Sheets ID explicitly selected through `setup-csv.mjs`
is reused; conflicting CSV selections are rejected. Drive always requires an
explicit reference. Credential references in unrelated workflows are never used,
and existing saved workflow pins are retained.

```sh
node examples/n8n-capability/setup-components-local.mjs /tmp/n8n-ka-state --install \
  --node /path/to/node24 --n8n-cli /path/to/n8n/bin/n8n
node examples/n8n-capability/serve.mjs /tmp/n8n-ka-state
```

Reinstalling unchanged components preserves their native workflow and published
version IDs, including the shared echo workflow. Only missing definitions are
imported; a retry after interrupted publication publishes the existing imported
version. The installer verifies current and published definitions against the
pins before changing n8n or replacing the manifest. A changed definition under an
existing identity is rejected; changed templates must use a new revision identity.
Pending acknowledgements can therefore recover their original executions without
relaxing the runtime's exact version check or sending another webhook request.

In nOS choose **HTTP → temperature**, **Data + branching**, **CSV → Google Sheet**, **Loop example** or
**Schedule example**, or drag your own blocks. Click a block to edit its fields.
Connect named outputs to inputs A/B; the Connections panel offers the same
controls with select menus. A loop needs a `loop` path returning from its body,
and a `done` path for subsequent steps. Uploading a CSV supplies a file record
to the real Extract From File node. **Save workflow KA** pins the graph and
selected child grants; **Run workflow** executes that saved revision. **Invoke
this KA** exercises a selected action independently. **View KA in DKG** reads
its exact source from this node's private Working Memory.

Advanced graphs compile to native n8n connections, so n8n owns branches, joins,
loops and waits. The parent Program's declared children retain the selected KA
approval pins and caller checks. A graph run produces one DKG receipt with the
verified n8n execution ID and native per-block trace. Those native steps are not
separate child Program receipts. The retained CSV KA builder still composes
individual `invoke_program` calls and returns separate child DKG receipts.

The native adapter journals an early acknowledgement before polling results.
An interrupted invocation resumes inspection of that same provider execution;
it never re-posts a webhook after a recorded acknowledgement. Missing
acknowledgements remain uncertain and retain their request identity. Native
errors, empty branches and oversized outputs are explicit results.
Inspection waits up to 55 seconds after acknowledgement, covering Studio's
50-second native execution limit and 45-second Program callback timeout within
the 60-second parent budget. Each HTTP request remains limited to 15 seconds;
authority is rechecked while polling and before callbacks commit their results.

Both n8n adapters report v2 implementation fingerprints generated from their
bundled import graphs, including workspace source dependencies and the host
dependency lockfile. `pnpm --dir packages/cli build:compile` regenerates the pins;
the native fingerprint regression rejects stale generated pins in CI. For a
direct `tsc` build after editing those sources, first run
`node packages/cli/scripts/n8n-implementation-fingerprints.mjs --write`.
Historical v1 receipt versions and hashes remain immutable evidence and are
never relabelled as v2. The `n8n-native-v1` acknowledgement format and effect
identity stay compatible: recovery inspects the recorded provider execution
under current authority without a second webhook POST.

**Activate events** enables a Webhook or Schedule root for 30 minutes or five
events. Native Schedule executions only emit scoped timer events. The local
worker invokes the DKG Program with a deterministic event identity, checking
current parent/child approvals before any downstream native actions. Webhook
callers POST `{ "invocationId": "<fresh UUID>", "items": [{...}] }` to the
activation endpoint shown in the UI. Retrying that event identity reconciles
the same invocation. Deactivation immediately persists local revocation and removes
event access before asking n8n to unpublish a timer. Failed or unconfirmed
unpublication remains pending in the Studio repository and is retried by polling
or an explicit deactivation retry, including after restart. Changed native pins
keep cleanup pending until the pinned revision is restored; they never restore
local event authority. Revocation uses the locally saved mode and source pin, so
unavailable Program source or approval reads cannot block it. Its response is a
local acknowledgement (`kaRef`, known `sourceHash`/`mode`, `activation.active=false`),
without claiming a fresh approval readback. Legacy saved native workflows without
mode metadata conservatively retain unpublication work as well. A new activation
must finish pending cleanup first.
Activation commits compare the durable lifecycle revision, so a request awaiting
inspection cannot overwrite a later revocation. Delegated webhook and timer events
recheck that same revision immediately before invocation and reconciliation.
Google event activation requires the operator export key; its fingerprint, not
the key, is persisted. Event inputs/results and native workflow IDs are journalled
in the private `studio.sqlite` database for recovery across service restarts.
Reservation and quota consumption commit in one transaction; reaching five events
still permits recovery of those reserved identities. Timer admission checks the
execution's published version, approved workflow digest, structure and trigger
scope while allowing n8n's normalized parameter snapshots.

PoC bounds: eight blocks, one loop, twenty input/output records, 8 KiB serialized
record sets, 4 KiB file uploads, three-second Wait, 24 saved graph revisions.
Each component currently offers a reviewed subset of its native operations.
HTTP Request accepts a public HTTPS API URL, GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS,
query parameters, headers and an arbitrary JSON body. n8n must run with
`N8N_SSRF_PROTECTION_ENABLED=true`; redirects remain disabled. The URL validator
rejects embedded credentials, local hostnames, IP literals and custom ports.
Query/header/body values can reference input data such as
`{{ $json.location.latitude }}`. Edit Fields maps nested paths and array indexes
(`{{ $json.current.temperature_2m }}`, `{{ $json.hourly.temperature_2m[0] }}`)
while preserving JSON types; choose whether to keep other input fields. The
field editor supports named rows and an advanced JSON view. References are
data paths, not arbitrary JavaScript. The **HTTP → temperature** example uses
the full Open-Meteo forecast URL and maps temperature, unit and observation time.
These component revisions have new immutable KA identities. Previous saved
Studio sources use their original compiler and child pins, and retired component
revisions remain available to their saved graphs; choose **Use current component
version** before editing an older component into a new graph. Historical local
HTTP demo calls are blocked when n8n's SSRF protection is enabled.

New native Studio saves use compiler contract 4: the wrapper invokes only its
pinned n8n tool and declares no child Programs. DKG-executed Program workflows
retain their child grants. Re-saving an existing native definition creates a new
Program revision and approval instead of reusing its older child-bearing grant.
Old sources and pending invocation identities remain unchanged; this is not a
migration or automatic reauthorization of historical executions.

A native invocation with a durable provider acknowledgement can reconcile the
same execution after inspection fails or the runtime restarts. Studio retries
that reconciliation once under the original invocation ID. The runtime still
requires the approved source, empty child grants, the original native effect and
current authority; it cannot dispatch another provider call during continuation.
Execute
Sub-workflow invokes the installed native echo example. Google Sheets creates
one spreadsheet per input batch and appends scalar rows using RAW cell input.
Google Drive uploads a small file and needs a separate Drive OAuth connection;
the catalog marks missing connections unavailable. No new Google export is
performed during service startup.

The preview gateway can serve a built development snapshot plus only the kit,
KA Studio and activated event routes. It preserves exact Host/Origin checks,
bounded request bodies and rate limits; n8n's editor/admin API stays local.

```sh
node examples/n8n-capability/cloudflare-preview.mjs /tmp/owned-preview-state
```

Credential-free native smoke checks use a separate fixture installation, never
the Google-connected state:

```sh
node examples/n8n-capability/setup-components-local.mjs /tmp/n8n-component-fixture --fixture --install \
  --node /path/to/node24 --n8n-cli /path/to/n8n/bin/n8n
# Start fixture n8n on 45780 with broker port 45781, then:
node examples/n8n-capability/verify-components-native.mjs /tmp/n8n-component-fixture http://127.0.0.1:45780 --n8n-package /path/to/n8n/package.json
node examples/n8n-capability/verify-studio-native.mjs /tmp/n8n-component-fixture --prepare
# Import/publish the four generated studio-fixtures with the official CLI and restart that fixture.
node examples/n8n-capability/verify-studio-native.mjs /tmp/n8n-component-fixture http://127.0.0.1:45780 --n8n-package /path/to/n8n/package.json
```

The component, Studio and HTTP-mapping native verifiers all require
`--n8n-package /path/to/n8n/package.json` when reading executions. They resolve
`flatted` from that installation; `--prepare` does not need the runtime package.

The field-join regression runs eight generated Merge cases on n8n 2.43.8 with
distinct left/right field names, all three join modes, duplicate matches and
append-only compatibility. It imports and executes through the native CLI in a
fresh temporary SQLite state, then removes that state; it needs no running
server, account credentials or partner data. Use a Node version supported by
that n8n installation:

```sh
node examples/n8n-capability/verify-field-join-native.mjs /path/to/node_modules/n8n /tmp/field-join-report.json
```

```sh
node examples/n8n-capability/verify-workflows.mjs /tmp/n8n-ka-state
```

This uses the owned local n8n SQLite history read-only to prove that completed
replay did not dispatch another execution. It also verifies source readback,
saved-version reopening and refusal of unauthorized parent workflows. **View in
DKG** reads live Program source and its exact revision from the local node's
private Working Memory. The example HTTP server exposes the fixture API rather
than a standalone node dashboard.
Google parent authorization evidence is `passed` only after the save-denial
and inventory assertions run. Without an available Google export capability it
is `skipped` with a reason, and `unprivilegedGoogleParentDenied` remains false.

## Execution boundaries

### Run Program KA

The Studio palette also offers **Programs → Run Program KA**. Select a Program
and a version, then pass input unchanged or configure typed field mappings
(`{{ $json.field }}`), nested JSON or a whole input reference. **Each item** calls
the Program with one mapped argument per record; **All items** calls it once,
with the complete input array available as `{{ $json }}`. Object outputs become
records, arrays become record batches and scalar outputs use a `value` field.
Connect the block's main output to another action block, save the workflow KA,
and run its saved version. The selected program is inspected with the same
**View KA in DKG** action.

The selector reads current, enabled local approvals for the original account
owner and exact private Working Memory source pins in this PoC's Context Graph.
It offers `typescript-v1` Programs, which accept the mapped runtime argument.
S-expression Programs are excluded because they do not accept runtime arguments.
Program IRI, approved operation, version and source hash are saved together.
It does not upload arbitrary editor code or grant additional tools. New versions
use new Program IRIs; versions with the same label and author share a selector
group, while the hash and IRI identify each selected revision. The PoC installs
two pure **Scale number** examples (1.0.0 and 2.0.0). Other compatible owner-approved Programs
in the same graph appear automatically. **Program KA example** demonstrates
Edit Fields → Run Program KA → Edit Fields and produces `answer: 42`.

Workflows containing this block currently support one linear path of up to eight
action blocks. Graph Computer invokes native n8n component KAs and selected
Programs as explicit children, pins their current approvals, retains the
original caller and records separate child execution receipts. Every child
result is read back before returning the result. No n8n execution ID is invented
for DKG computation. Native-only graphs continue to use the original n8n compiler
for branching, loops and events. The existing native-only safe-resume rules are
unchanged; an interrupted mixed workflow is retained for inspection and is never
automatically restarted with a new identity. Google authorization also applies
when a selected Program transitively calls a protected export capability.

Verification:

```sh
node --test examples/n8n-capability/program-workflow.test.mjs
# From packages/cli, using the unit config (no Hardhat):
pnpm exec vitest run --config vitest.unit.config.ts test/semantic-runtime-configuration-api.test.ts
```

### Native adapter verification

The tenant approval and the operator installation must agree on graph, executor,
workflow ID and digest. The adapter checks the published definition before
dispatch. Native receipts bind the execution's provider-reported version ID to
that exact published definition and durable acknowledgement; graph, node types,
settings and credential references must also match. Runtime parameter snapshots
are normalized by n8n (including removed inactive fields and expression prefixes)
and are not a second immutable source definition. This works for every native
node without URL, method or component-specific verification exceptions. The
operator's n8n API is the trusted source of published-version identity.

An interrupted native-only TypeScript invocation may retry the same identity to
inspect its durably acknowledged provider execution. Changed inputs or approvals
remain forbidden. Continuation cannot start a new tool or child invocation, and
all original effects must succeed before a DKG receipt is persisted. Other
interrupted TypeScript executions retain their non-retryable behavior.

Credentials stay outside KAs, browser payloads and receipts. Requests and results
have bounded sizes, schemas and deadlines. The common effect broker records an
exact per-call approval derived from the tenant grant. Consequential outcomes
that become ambiguous are blocked for inspection; they are never automatically
redispatched. A successful completed retry returns the persisted result after
current authorization checks. Private KA receipts establish provenance and
matching content, not independently verified execution of an external service.

### JPB DKG Read and DKG Write components

Select the same `NOS_DKG_PROFILE_MODULE` and approved `NOS_JPB_WORKBOOK_INPUT_FILE`
for installation and the companion. Install with
`setup-components-local.mjs <state> --install --only dkg-read,dkg-write --n8n-cli <cli>`
in the isolated local n8n instance, using the same `httpHeaderAuth` connection as the native bridge.
Partial installation verifies the selected components and preserves all unselected
manifest entries and pins. It does not advertise or require the unselected
`invoke-dkg-program` component. Install that component explicitly when needed.
Restart the local n8n instance after offline installation. The fixed callback is
`http://127.0.0.1:4631/spike/ka/internal/dkg-component`; allow loopback for this isolated n8n
instance with `N8N_SSRF_ALLOWED_IP_RANGES=127.0.0.1/32`, keeping SSRF protection enabled.
The general HTTP component still rejects arbitrary private destinations.

Configure the companion:

- `NOS_JPB_READ_ENABLED=1`
- `NOS_JPB_WRITE_ENABLED=1`
- `NOS_JPB_WORKBOOK_INPUT_FILE=/absolute/path/to/JPB-recorded-inputs.json`

The last file contains the reviewed original four workbook rows at `[0].workbook`. Input must
match them exactly before a workflow containing DKG Write can execute. The JPB connection uses
existing SSH access to `adminuser@100.113.215.1`; node credentials remain on that host.
No remote services are installed or restarted. These flags authorize only this fixed demo scope.

Use **DKG Read** as the first block. It accepts one `{workbook:[...]}` item and reads saved order
62633 (CUT, USILU, EBAVM) through the JPB DKG query API in `jpb-data`. The selected evidence
snapshot was captured on 2026-10-18. Four fixed assertion graphs bound the query; missing,
duplicate, oversized or unavailable source results fail the step. No fresh SQL extraction runs.

Connect ordinary native n8n mapping/split/join components, followed by terminal **DKG Write**.
Both DKG blocks compile to native HTTP Request nodes with explicit credential references and
native result unpacking. The transport validates the approved workflow digest and native execution,
then uses fixed JPB adapters. Mapping, joins, scheduling and step errors stay in n8n. DKG blocks
currently support bounded manual native workflows only, with at most one read and one write.
The standalone `/studio/jpb-output` action has been removed: Run executes the write component.

The write target is the existing private `jpb-plca-study` Context Graph. Output is non-calculated
PLCA input evidence with unconfirmed allocation. It retains both input provenances, source
snapshot and execution identity. The payload marks its execution `running-at-write`; the final
local workflow receipt records completion. Sharing and VM publishing are false. Readback checks
every RDF term, payload SHA-256 and `wm-sealed` status before reporting success.

The component journal binds invocation, native execution, block, input and workflow source hash.
Program-backed runs also retain the original approval digest and signed invocation identity.
Every callback checks that binding and its recursive child approval pins for the original caller,
the durable runtime effect and its capability (revocation,
expiry and policy epoch), including a synchronous check immediately before transport after
asynchronous authorization. Reapproving identical source cannot revive an older invocation.
Completed parents permit only cached results or readback of an already journalled write.
Legacy Program runs without the original authority snapshot remain closed to callbacks and
grant renewal; preserve their journal for operator reconciliation instead of assigning a new approval.
MCP runs retain their separate saved-workflow admission and withdrawal authority.
A pending write is persisted before dispatch. The native HTTP step retries at most once; retry
reconciles the same named asset, never recreates an ambiguous missing asset. Reads are reused
within one invocation. Completed workflow replay returns the same persisted receipt. A new Run
has a new identity and may create a new evidence asset. No EPCIS or calculated footprint is implied.

Validation: `node --test examples/n8n-capability/dkg-components.test.mjs
examples/n8n-capability/jpb-output.test.mjs examples/n8n-capability/program-workflow.test.mjs`.

### Studio presentation metadata

Studio blocks optionally carry `label` (up to 80 characters) and `groupId`. The definition may
include up to twelve `groups`, each with a unique `id`, a `name` and a `tone` selected from
`purple`, `teal`, `amber`, `neutral`. Membership must reference an existing group. These fields
persist in the immutable workflow source but never enter native node parameters or control flow.
Definitions without these fields retain their original normalization and source identity.
Renaming or regrouping creates a saved revision; it does not execute the workflow.

Run `node --test examples/n8n-capability/studio-presentation.test.mjs` to check old-source
compatibility, presentation readback, validation and unchanged native execution definitions.
# Invoke DKG Program (JPB local demo)

The DKG palette includes **Invoke DKG Program**. It remains a native n8n HTTP
step and can follow branches and a Merge by fields step. It does not switch to
the separate linear Program-workflow executor.

Select the execution node and a reviewed remote Program. **Program arguments**
is a JSON array of positional arguments; `$json` is the complete incoming batch.
For one argument containing all rows, use `["{{ $json }}"]`. For the first row,
use `["{{ $json[0] }}"]`. **Returned result** maps the remote output array using
the same references. The next step receives `result` and `programExecution`,
including the remote execution IRI, source hash, binding digest and output hash.

Programs are pinned in `jpb-programs.json`. The adapter checks the selected
node, current approval and stored source before invoking and checks approval
again afterward. Remote credentials remain on JPB. Calls require an owner-run,
approved saved workflow and a matching native execution. Retry uses the same
deterministic remote invocation ID; a changed request cannot reuse that ID.
The operator enables this adapter with `NOS_JPB_PROGRAM_ENABLED=1`.

The current reviewed Programs are **JPB PLCA - Run study pipeline v1.0.0** and
**JPB PLCA - Prepare inventory v1.0.0**. The former accepts a study request and
reads its stored snapshot; the latter accepts `[reader, request]`. They do not
yet accept arbitrary joined ERP/Excel rows as a calculated impact assessment.
That requires the mapped-input revision of the existing PLCA Program, followed
by a result-aware DKG Write. This component does not alter or deploy those
remote Programs. The existing evidence workflow remains available separately.

The candidate mapped calculator in `jpb-plca-mapped.ts` uses the pinned
`@noble/hashes` 2.2.0 SHA-256 implementation. Build its uploadable source with
`node examples/n8n-capability/jpb-plca-mapped-bundle.mjs > /tmp/jpb-plca-mapped.bundle.json`.
This creates a `dkg.typescript-source-bundle.v1` containing the calculator,
dependency sources and license, with per-file hashes and explicit import mappings.
The guest needs no package loader or host crypto access. Upload the bundle text as
a new Program revision and approve its new source hash separately; existing
deployed Program sources and `jpb-programs.json` pins remain immutable. The
canonical record serialization and `urn:nos:mapped:` snapshot digests are unchanged.

### Account access integration status

The JPB SSH adapter remains an explicit local-demo transport. It is not an account
or runner authorization contract. nOS already implements account/job node access,
runner-held node credentials and workflow publishing via its node-action journal
(`tl-nos` PR #1076 and the current `workflow-publish.ts` / `workflows-access.ts`).
Production integration must consume that path. It must not forward a customer's
session bearer to this companion, n8n or DKG, or replace account checks with an
SSH administrator credential.

Read and Write can reuse the existing query/publish foundations once trusted
account/principal context and a checked managed-node selector reach the component.
Program bindings/source/execute still need an agreed runner operation contract;
those routes are not currently on the nOS runner allowlist. JPB fleet visibility
alone does not establish a corresponding account-owned launched node. See
`tl-nos/docs/l1/STUDIO-DKG-ACCESS.md` for the specific reuse points and acceptance
criteria. This change does not expand runner permissions or deploy an adapter.

The demo transport now pins Python script bytes at profile load and hashes those
same bytes into the profile revision. Both Program invocation and Write require
the approved workbook input. Confirmed Write retries reuse their durable receipt;
only an unconfirmed write calls the transport again with `allowCreate: false`.
The transport owns actual DKG content readback; the generic component additionally
checks graph, asset name, content digest and sealed status before retaining it.


### Operator output authority and embedded helpers

Native installations must include `resultSha256`, computed by
`n8nResultSha256(reviewedGrant)` from the reviewed result selector and output schema.
The pin covers nodes, ports, sinks, trace nodes and observation policy. The companion
installs it from its operator-owned component manifest and generated Studio grants.
Tenants cannot change the projection by approving a different grant for the same
workflow digest. Missing pins deny native execution; an existing installation with
a different pin requires operator review instead of being silently widened.
Do not populate this field from an unreviewed tenant request.

Execute Sub-workflow now embeds the complete helper JSON without a database ID.
The parent digest covers the helper's output and effects. The runtime rejects
mutable database, URL/file and expression-selected helpers, recursively, before
native or legacy adapter dispatch. Historical templates remain readable but their
unpinned helper executions are refused. Install the current component and save a
new Studio revision to use it; helper-containing Studio graphs use compiler
contract 5, preserving older source serialization and invocation identities.


### Event URLs, cross-graph exports and oversized results

Studio history is readable without disclosing its event capability URL. Only an
owner can receive `eventPath`; protected workflows additionally require the current
`x-dkg-export-token` header on the history request. A deliberately shared event URL
still delegates bounded webhook invocation. Direct service history omits the URL
unless its caller explicitly supplies a disclosure authorization callback.
Account-bound nOS Studio remains manual-only, starts no event polling worker,
and never discloses an event URL. Program-only services without a native provider
also start no event worker; saved execution history remains readable.

Program export analysis resolves each child by both `contextGraphId` and
`operationIri`, including descendants in other graphs. Unreadable, missing,
mismatched or cyclic bindings conservatively require operator export authorization.
The catalog bounds traversal and requires an exact known native workflow digest.

A completed native result over the record limit produces `ok: false` and empty
record sets. Its receipt can be persisted and replayed without redispatch. Trace
counts remain accurate; when records were omitted to bound processing, the trace
marks `outputOmitted: "record-limit"` instead of claiming a hash of unprocessed data.

Terminal results accumulate in execution order across all runs of each selected
node and port. This includes terminal branches inside loops; the Loop Over Items
done port stays separate from its loop port. Trace counts cover all runs, and the
twenty-record / 8 KiB output limits apply to the aggregate result.

The preview gateway reserves one of its twenty write admissions per minute before
reading the request body, so concurrent or incomplete bodies cannot bypass the
limit. An admitted attempt keeps its reservation for that window. Owner history
requests forward the export key to the companion; viewer history and unrelated
read routes do not receive that header.

### Development Studio MCP adapter

See [STUDIO-MCP.md](./STUDIO-MCP.md) for the default-off native execution adapter,
exact pins, trusted agent attribution, durable run lookup and the proposed
#1227/#1247 gateway contract. This is separate from manual Studio's Program path;
standing authority is confirmed in principle; enforcement and live customer
qualification remain pending.
