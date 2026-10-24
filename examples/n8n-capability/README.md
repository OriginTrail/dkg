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

## Thirty native components and nOS Studio

The **Workflow builder** tab now opens **n8n KA Studio**, with thirty separately
registered component Programs. Every leaf KA declares its exact native workflow
ID, definition hash, bounded input/output schemas and selected result nodes in
its owner-approved n8n grant. Credentials stay in the local n8n installation.

| Group | Components |
| --- | --- |
| Data | Edit Fields, Filter, Sort, Limit, Remove Duplicates, Split Out, Aggregate, Summarize, Rename Keys, Date & Time |
| Files | Extract From File, Convert to File, XML, HTML, Markdown, Crypto, Compression |
| Integrations | HTTP Request, Google Sheets, Google Drive |
| Flow | IF, Switch, Merge, Compare Datasets, Loop Over Items, Execute Sub-workflow, Stop And Error |
| Events | Webhook, Schedule Trigger, Wait |

Provision the installed local n8n runtime with its official CLI while that owned
instance is stopped. The installer first takes a SQLite backup, reads credential
references (never tokens), imports native templates and publishes action flows.
Schedule components remain inactive until a saved workflow is activated.

```sh
node examples/n8n-capability/setup-components-local.mjs /tmp/n8n-ka-state --install \
  --node /path/to/node24 --n8n-cli /path/to/n8n/bin/n8n
node examples/n8n-capability/serve.mjs /tmp/n8n-ka-state
```

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

**Activate events** enables a Webhook or Schedule root for 30 minutes or five
events. Native Schedule executions only emit scoped timer events. The local
worker invokes the DKG Program with a deterministic event identity, checking
current parent/child approvals before any downstream native actions. Webhook
callers POST `{ "invocationId": "<fresh UUID>", "items": [{...}] }` to the
activation endpoint shown in the UI. Retrying that event identity reconciles
the same invocation. Deactivation removes event access and unpublishes timers.
Google event activation requires the operator export key; its fingerprint, not
the key, is persisted. Event inputs/results and native workflow IDs are journalled
in the private `studio.sqlite` database for recovery across service restarts.

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
node examples/n8n-capability/verify-components-native.mjs /tmp/n8n-component-fixture http://127.0.0.1:45780 /path/to/n8n/package.json
node examples/n8n-capability/verify-studio-native.mjs /tmp/n8n-component-fixture --prepare
# Import/publish the four generated studio-fixtures with the official CLI and restart that fixture.
node examples/n8n-capability/verify-studio-native.mjs /tmp/n8n-component-fixture http://127.0.0.1:45780
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

## Execution boundaries

The tenant approval and the operator installation must agree on graph, executor,
workflow ID and digest. The adapter checks the published definition before
dispatch and the execution's actual published-version ID, graph and reviewed
parameters afterward. n8n expands omitted parameter defaults in its execution
snapshot; those additions are accepted while reviewed values remain exact.

Credentials stay outside KAs, browser payloads and receipts. Requests and results
have bounded sizes, schemas and deadlines. The common effect broker records an
exact per-call approval derived from the tenant grant. Consequential outcomes
that become ambiguous are blocked for inspection; they are never automatically
redispatched. A successful completed retry returns the persisted result after
current authorization checks. Private KA receipts establish provenance and
matching content, not independently verified execution of an external service.
