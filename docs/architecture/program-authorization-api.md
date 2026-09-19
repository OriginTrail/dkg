# Program authorization and routing through HTTP

A Program is stored RDF data until a Context Graph owner or an explicitly authenticated node operator installs an execution binding. A grant inside the S-expression requests a capability; it does not grant authority. Approval is a durable permission, checked on each invocation and before effects/results, not an interactive confirmation per request.

The APIs configure existing typed tools and the existing agent-key-signed inbox protocol. They add no dynamic inputs, arbitrary SPARQL writes, or automatic replication of the source Program. A Program can reside in a separate Context Graph from the data it reads or writes.

## Credentials and prerequisites

The examples use two nodes: **runner** hosts the private data and executes the Program; **client** forwards the caller's signed invocation. `program-library` and `tenant-data` below stand for their registered **canonical IDs**, which may be qualified on your network. Full `did:dkg:context-graph:...` graph URIs are also accepted and returned as canonical IDs without that URI prefix. Display-name/suffix aliases are not resolved by these APIs. Register/prepare the graphs and local agents using the normal DKG setup first.

Every HTTP call below is **signed directly with the agent's private key** using EIP-191. The node recovers the signer address and checks the request's destination, exact method/path/body, timestamp and one-use nonce. No JWT or session token is issued or managed. The key stays with its owner. See the [signature profile, automatic backend client and operator setup](agent-key-http-authentication.md). The request freshness window does not expire the agent key or its access.

| Proof | Issuer | Represented identity | Scope |
| --- | --- | --- | --- |
| Owner HTTP signature | Owner's local signer | `OWNER_AGENT_ADDRESS` | Existing owner rights: upload Program, approve/update/revoke data-graph bindings. |
| Caller HTTP signature | Caller's local signer | `CALLER_AGENT_ADDRESS` | Existing Program-graph read rights and separately approved invocation rights. |
| Operator HTTP signature | Same caller's local signer | Same `CALLER_AGENT_ADDRESS` | Administration on client only, after its operator explicitly configures this address. |
| Invocation delegation in JSON | Caller's local signer | Same original caller | One data graph, operation, invocation UUID, execution peer and forwarding peer; expires within five minutes. |

The caller's signing key is held by the client application and need not be stored on either node. Runner retains its own executor's custodial key. Graph permissions are independent of authentication and operator role. Configure `auth.operatorAgentAddresses` on client once, as documented in the linked profile; possessing a signing key does not automatically grant administration. Anonymous/public requests cannot manage bindings or routes, including when HTTP auth is disabled. An ordinary graph member cannot approve bindings.

An agent-authenticated graph owner may select only its **own custodial identity** as executor. Graph ownership or membership does not authorize borrowing another wallet for reads, writes or any other tool. A foreign executor is rejected with `PROGRAM_EXECUTOR_FORBIDDEN` (403) before Program resolution or permission persistence. Only an explicitly authenticated node operator may select a different local custodial executor. This API has no executor-delegation mechanism; an owner also cannot refresh an operator-issued foreign-executor binding, but may revoke it.

The graph-owner manager must also be able to read the source Program under its own identity. The executor must have source/data read access and, for creation, write access. In this example the owner is also the runner's executor and Program uploader; the caller is a separate agent.

On a node without an explicit runtime setting, the first authorized management request starts the runtime in-process. Durable API entries restore it on subsequent boots. No configuration file edit or daemon restart is required for these steps. An existing explicit `semanticRuntime.enabled: false` is an operator kill switch and returns 409; the management API does not override it.

```sh
export RUNNER_URL='http://runner.example:9200'
export CLIENT_URL='http://client.example:9200'
export SOURCE_GRAPH='program-library'
export DATA_GRAPH='tenant-data'
export PROGRAM_IRI='urn:example:program:read-device:1'
export OPERATION_IRI='urn:example:operation:read-device'
export TOOL_IRI='urn:example:tool:sparql-read'
# These files remain only on the signer's machine and contain a hex key (chmod 600).
export OWNER_KEY_FILE='/secure/owner.key'
export CALLER_KEY_FILE='/secure/caller.key'
export OWNER_AGENT_ADDRESS='REPLACE_WITH_OWNER_AGENT_ADDRESS'
export CALLER_AGENT_ADDRESS='REPLACE_WITH_CALLER_AGENT_ADDRESS'
export RUNNER_PEER_ID='REPLACE_WITH_RUNNER_PEER_ID_FROM_API_STATUS'
export CLIENT_PEER_ID='REPLACE_WITH_CLIENT_PEER_ID_FROM_API_STATUS'
export SIGNER='packages/cli/scripts/sign-agent-request.mjs'
```

Use HTTPS or a trusted local tunnel; signatures authenticate requests but do not encrypt their contents. The graph IDs, device IRI and predicate in this example are illustrative; use data and projections you intend to disclose.

After building the CLI, run from the repository root. This wrapper gives **curl only public signature headers**, never a private key. Sign the exact path and body curl sends; do not change query encoding or reserialize JSON afterward. Do not follow redirects with the proof.

```sh
signed_curl() (
  key_file="$1"; peer="$2"; base_url="$3"; method="$4"; request_path="$5"; body_file="${6:-}"
  headers_file="$(mktemp)"
  trap 'rm -f "$headers_file"' EXIT
  if [ -n "$body_file" ]; then
    node "$SIGNER" http --key-file "$key_file" --peer "$peer" --method "$method" \
      --path "$request_path" --body "$body_file" --out "$headers_file"
    curl --fail-with-body -sS -X "$method" "$base_url$request_path" -H "@$headers_file" --data-binary "@$body_file"
  else
    node "$SIGNER" http --key-file "$key_file" --peer "$peer" --method "$method" \
      --path "$request_path" --out "$headers_file"
    curl --fail-with-body -sS -X "$method" "$base_url$request_path" -H "@$headers_file"
  fi
)
export BINDING_PATH="$(python3 -c 'import os,urllib.parse; print("/api/programs/bindings?"+urllib.parse.urlencode({"contextGraphId":os.environ["DATA_GRAPH"],"operationIri":os.environ["OPERATION_IRI"]}))')"
export ROUTE_PATH="${BINDING_PATH/bindings/routes}"
```

```mermaid
sequenceDiagram
  participant O as Owner signer
  participant R as Runner node
  participant C as Client node
  participant A as Caller signer
  A->>C: Operator-signed POST /api/agent/encryption-enrollments
  C-->>A: Public encryption key + node-bound challenge
  A->>C: Agent-signed POST .../activate + key/custody proofs
  C->>C: Persist encryption key only; no graph grant
  A->>C: Signed POST /api/context-graph/{source}/request-join + signed key bundle
  C->>R: Agent delegation and verified encryption keys
  O->>R: Signed POST /api/context-graph/{source}/approve-join (if pending)
  R->>R: Validate key readiness before Program-graph admission
  O->>R: Signed POST /api/knowledge-assets (Program)
  R->>C: Authorized Program-graph replication
  O->>R: Signed POST /api/programs/bindings (private data graph)
  R->>R: Check owner/executor, pin source, persist approval
  A->>C: Signed POST /api/programs/routes (explicit operator role)
  A->>C: Signed POST /api/query (shared Program graph)
  A->>C: Signed POST /api/programs/execute + invocation delegation
  C->>R: Operation + original caller's signed delegation
  R->>R: Check caller, current binding, source pin and replay state
  R->>R: Execute locally and persist receipt
  R-->>C: Permitted outputs and execution reference
  C-->>A: Result
  O->>R: Signed POST /api/query (receipt as executor)
  A->>R: Signed POST /api/query (private data graph)
  R-->>A: Denied / empty bindings under query contract
```

## 0. Enroll an external caller for private Program replication

HTTP signing proves identity; it does not provide a key with which the receiving node can decrypt a private Program graph. The backend keeps only its existing agent signing key. The client node generates and stores a separate X25519 encryption key, after explicit operator preparation and recipient-signed custody approval. No agent signing key is uploaded, no bearer token is created, and enrollment grants no Context Graph membership, private WM access or executor rights.

Using the variables and `signed_curl` function above, prepare on **client** as its explicitly authorized operator (here the caller also has that role):

```sh
jq -n --arg agent "$CALLER_AGENT_ADDRESS" '{agentAddress:$agent}' > recipient.json
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" POST \
  /api/agent/encryption-enrollments recipient.json > enrollment.json
node "$SIGNER" enrollment --key-file "$CALLER_KEY_FILE" --peer "$CLIENT_PEER_ID" \
  --input enrollment.json --out activate-enrollment.json
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" POST \
  /api/agent/encryption-enrollments/activate activate-enrollment.json > enrolled-key.json
```

Preparation returns HTTP 201 with exactly the public challenge fields:

```json
{
  "version": 1,
  "enrollmentId": "48_HEX_CHARACTERS",
  "agentAddress": "CALLER_AGENT_ADDRESS",
  "targetPeerId": "CLIENT_PEER_ID",
  "encryptionKeyAlgorithm": "X25519",
  "encryptionKeyId": "COMPUTED_AGENT_KEY_ID",
  "publicEncryptionKey": "BASE64URL_PUBLIC_KEY",
  "expiresAt": 1790000600000
}
```

The helper produces the complete activation payload below, with two real EIP-191 signatures replacing the placeholders. `encryptionKeyProof` uses the existing workspace-key proof format; `custodyProof` binds the public key to the agent, node, enrollment ID and expiry. The signed HTTP actor must be this recipient, even if another agent prepared it as operator.

```json
{
  "agentAddress": "CALLER_AGENT_ADDRESS",
  "enrollmentId": "48_HEX_CHARACTERS",
  "encryptionKeyProof": "0xAGENT_SIGNATURE_OF_ENCRYPTION_KEY",
  "custodyProof": "0xAGENT_SIGNATURE_OF_NODE_CUSTODY_CHALLENGE"
}
```

Activation returns HTTP 200 with `agentAddress`, `targetPeerId`, `encryptionKeyId`, `encryptionKeyAlgorithm`, `publicEncryptionKey` and `encryptionKeyProof`. Neither response contains private key material. Pending challenges last ten minutes and survive restart; completed enrollment has no session expiry. Activation consumes the challenge; inspect `/api/agent/{address}/encryption-keys` if a successful response was lost. A storage failure does not advertise an unpersisted key. Active encryption keys and their private halves survive restart in the node keystore.

The client node must also have its own authorized replication identity for the Program graph. Background metadata sync requests use that node's custodial identity; an external caller's join approval or encryption custody must not replace it. The caller is still the principal of HTTP requests and Program invocations. If no authorized node signer exists, bootstrap remains closed; enrollment does not supply the caller's signing key or grant a substitute identity access.

Next send the existing agent-signed join delegation, including its signed encryption-key bundle, through client to the Program-graph curator. `DEPLOYMENT_ID` must match both nodes' chain adapter deployment identity (chain ID and Hub for EVM), and `SOURCE_GRAPH` must be canonical. Only use the **Program** graph here.

```sh
export DEPLOYMENT_ID='REPLACE_WITH_NETWORK_DEPLOYMENT_ID'
export SOURCE_PATH="$(python3 -c 'import os,urllib.parse; print("/api/context-graph/"+urllib.parse.quote(os.environ["SOURCE_GRAPH"],safe=""))')"
node "$SIGNER" join --key-file "$CALLER_KEY_FILE" --peer "$CLIENT_PEER_ID" \
  --deployment "$DEPLOYMENT_ID" --graph "$SOURCE_GRAPH" --curator "$RUNNER_PEER_ID" \
  --input enrolled-key.json --out join-programs.json
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" POST \
  "$SOURCE_PATH/request-join" join-programs.json
# If the response is pending, the Program-graph owner approves:
signed_curl "$OWNER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" POST \
  "$SOURCE_PATH/approve-join" recipient.json
```

`join-programs.json` has the complete existing join payload: `agentName`, `curatorPeerId`, and `delegation` containing `agentAddress`, `scope`, `delegateePeerId`, `issuedAtMs`, `expiresAtMs`, `signature`, `workspaceEncryptionKeys` (algorithm, public key, proof), and `workspaceEncryptionKeysSignature`. The helper signs these locally. The curator checks the sender peer, delegation, key proofs and freshness before caching them. An already approved member can refresh its key bundle through the same signed join flow; a pending member still needs owner approval. Enrollment alone never adds membership. Direct invitations now reject private recipients without a verified active encryption key with `PRIVATE_RECIPIENT_NOT_READY`, before any roster write.

## 1. Upload the Program as a Knowledge Asset

This uses the existing asset API. It seals the Program and shares it into source SWM, where the runner's executor must be able to read it. Uploading does **not** authorize any caller.

```sh
cat > program.sexpr <<EOF_PROGRAM
(strategy example/read-device (version "1.0.0")
  (scope graph:${DATA_GRAPH}) (goal read-device)
  (supervise one-for-one (max-restarts 1) (window-ms 60000)
    (delegate reader (grant dkg.sparql.read)
      (call dkg/sparql-read@1
        "SELECT ?value WHERE { <urn:example:device:1> <urn:example:value> ?value } LIMIT 5"))))
EOF_PROGRAM

jq -n --arg cg "$SOURCE_GRAPH" --arg iri "$PROGRAM_IRI" --arg tool "$TOOL_IRI" \
  --rawfile source program.sexpr '
  {contextGraphId:$cg,name:"read-device-program-v1",finalize:true,alsoShareSwm:true,
   quads:[
     {subject:$iri,predicate:"http://www.w3.org/1999/02/22-rdf-syntax-ns#type",object:"https://origintrail.io/semantic-runtime/v1#Program"},
     {subject:$iri,predicate:"https://origintrail.io/semantic-runtime/v1#language",object:("sexpr-v1"|tojson)},
     {subject:$iri,predicate:"https://origintrail.io/semantic-runtime/v1#version",object:("1.0.0"|tojson)},
     {subject:$iri,predicate:"https://origintrail.io/semantic-runtime/v1#source",object:($source|tojson)},
     {subject:$iri,predicate:"https://origintrail.io/semantic-runtime/v1#requiresTool",object:$tool}
   ]}' > upload.json

signed_curl "$OWNER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" POST '/api/knowledge-assets' upload.json
```

The source graph must be created and ready for sharing; on-chain registration is not required for private P2P sharing. Authorization fails closed if the selected Program view is unavailable or ambiguous. For a new version, upload a new asset name and versioned Program IRI. Normal asset lifecycle/retry rules still apply.

For private source graphs, SWM sender-key delivery distinguishes API registration from encryption-key custody. Registering a remote agent's public key on runner for API authentication does not make runner its decryption custodian. An external API-only recipient uses its resolved remote peer and active encryption key; the receiving node still checks graph/peer authorization and possession of the exact private key. Missing/self remote destinations are rejected for these external registrations. Locally custodial identities and locally owned or revoked keys retain the strict local checks; missing/revoked custody is not bypassed by forwarding elsewhere. Agent-key authentication requires no API-token registration. Normal graph enrollment and encryption-key delegation remain required; do not copy signing keys between nodes to enable sharing.

A partial upload response (`207` with a `swm-share` error) means the sealed WM asset exists but sharing did not complete. After fixing the reported cause, retry the existing asset's SWM transition with its owner-signed request and author lane, then verify source readback in SWM before approving a `programLayer: "swm"` binding. Shared Program visibility does not grant invocation permission or access to the separate private data graph.

For a private unregistered replica, the receiver validates its durable approved join, the approving curator's identity and owner generation, the graph's own private metadata, and its current membership/delegation to the physical receiver. The finalized chain-name index must independently establish absence; a known binding or registration in flight takes precedence. Raw participant lists, subscription hints and ontology declarations do not establish this authority. The same validated lifecycle policy supplies the private catalog roster.

Sender-key ACKs distinguish an authoritative exclusion (`sender-not-allowed`, terminal) from unavailable authority (`authority-unavailable`, retryable). The latter retains the resolver's typed reason and a diagnostic digest; receiver logs include bounded, sanitized resolver details. It installs no receive key. The sender persists the pending setup for retry, so even HTTP 200 / `swmShared:true` is not proof of receiver replication: query the **receiver's** local SWM for the newly shared Program and verify its source hash. Sharing the Program graph never grants membership of its separate data graph.

## 2. Authorize the caller on runner

`POST /api/programs/bindings` creates one entry. `PUT` replaces one with optimistic concurrency via `expectedRevision`. Activation resolves the actual Program, computes source/author/schema pins, admits it through WASM, checks the selected executor and tool contracts, and validates typed tool arguments without dispatching data queries or creating assets. The response contains the effective binding, computed hashes, revision and resolution. A supplied hash/author must match; omitting a hash explicitly requests resolution of the current stored version during this approval request.

```sh
jq -n --arg cg "$DATA_GRAPH" --arg sourceCg "$SOURCE_GRAPH" --arg op "$OPERATION_IRI" \
  --arg program "$PROGRAM_IRI" --arg executor "$OWNER_AGENT_ADDRESS" \
  --arg caller "$CALLER_AGENT_ADDRESS" --arg tool "$TOOL_IRI" '
  {binding:{contextGraphId:$cg,operationIri:$op,executorAgentAddress:$executor,
    allowedCallerAgentAddresses:[$caller],executionLayer:"wm",
    program:{contextGraphId:$sourceCg,programIri:$program,programLayer:"swm"},
    sparqlRead:{toolIri:$tool,layer:"swm",timeoutMs:5000,maxResultItems:5,maxOutputBytes:16384,
      outputSchema:{type:"object",additionalProperties:false,required:["bindings"],properties:{
        bindings:{type:"array",maxItems:5,items:{type:"object",additionalProperties:false,
          required:["value"],properties:{value:{type:"string",maxLength:128}}}}
      }}}}}' > authorization.json

signed_curl "$OWNER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" POST '/api/programs/bindings' authorization.json > approved.json

jq '{revision,bindingDigest,binding,resolution}' approved.json
```

`program.programLayer` selects source storage, `sparqlRead.layer` selects data being read, and `executionLayer` selects persisted Execution records and any explicitly approved created assets. They are independent. A result schema bounds shape/size; the owner must review the query projection and filters to decide which data to release.

Inspect one binding, or omit `operationIri` to list that graph's bindings:

```sh
signed_curl "$OWNER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" GET "$BINDING_PATH" > current.json
```

## 3. Configure the outbound route on client

This is an operator-only routing decision. Runner's approval is independent.

```sh
jq -n --arg cg "$DATA_GRAPH" --arg op "$OPERATION_IRI" --arg peer "$RUNNER_PEER_ID" \
  '{route:{contextGraphId:$cg,operationIri:$op,targetPeerId:$peer}}' > route.json
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" POST '/api/programs/routes' route.json > routing.json

signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" GET "$ROUTE_PATH"
```

The client need not subscribe to or read the data graph to install this canonical graph/operation-to-peer mapping. Network reachability and peer discovery must be configured normally. There is no alternate peer or unsigned transport fallback.

## 4. Invoke the operation

```sh
export INVOCATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
jq -n --arg cg "$DATA_GRAPH" --arg op "$OPERATION_IRI" --arg id "$INVOCATION_ID" \
  '{contextGraphId:$cg,operationIri:$op,invocationId:$id}' > invocation.json
node "$SIGNER" invocation --key-file "$CALLER_KEY_FILE" --peer "$RUNNER_PEER_ID" \
  --forwarder "$CLIENT_PEER_ID" --input invocation.json --out authorized-invocation.json
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" POST '/api/programs/execute' authorized-invocation.json > execution.json
```

Reuse the same UUID for a retry, generating fresh HTTP signature headers every time. Refresh an expired delegation with the same UUID and operation. HTTP nonces are single-use authentication; the UUID identifies the durable execution. Each delivery gets a fresh transport ID so the destination's current permission checks cannot be skipped by transport response caching. Caller, source, output contracts, memory layers and the permission revision are bound to replay validation. A changed permission requires a new invocation UUID. The existing `programIri` spelling for configured operations remains supported; new clients should use `operationIri`, which never falls back to direct Program execution when no binding or route exists.

Successful output includes `executionIri`, `executionLayer`, `persisted` and permitted outputs. VM execution also requires its existing publication evidence. Invocation approval does not add the caller to the graph, and does not enable `POST /api/query` or direct Program/source reads. Private graph ACLs continue to govern those APIs; a denied raw query may return empty bindings under the existing query contract.

Read the newly shared Program on **client**, using a caller authorized for the Program graph only, then inspect the receipt as owner/executor and test that direct private-data access remains denied:

```sh
jq -n --arg cg "$SOURCE_GRAPH" --arg iri "$PROGRAM_IRI" \
  '{contextGraphId:$cg,view:"shared-working-memory",sparql:("SELECT ?source WHERE { <"+$iri+"> <https://origintrail.io/semantic-runtime/v1#source> ?source }")}' > read-program.json
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" POST '/api/query' read-program.json
jq -n --arg cg "$DATA_GRAPH" --arg iri "$(jq -r .executionIri execution.json)" \
  '{contextGraphId:$cg,view:"working-memory",sparql:("SELECT ?p ?o WHERE { <"+$iri+"> ?p ?o }")}' > receipt.json
signed_curl "$OWNER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" POST '/api/query' receipt.json
jq -n --arg cg "$DATA_GRAPH" \
  '{contextGraphId:$cg,view:"working-memory",sparql:"SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5"}' > forbidden-read.json
signed_curl "$CALLER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" POST '/api/query' forbidden-read.json
```

The caller's direct data query must disclose no rows. A receipt reference is not permission to read it. A successful older Program is not proof that the newly uploaded definition replicated; verify the exact source on client.

## 5. Update or revoke

An update is a complete replacement of the approved binding. Start with an owner-authenticated GET and keep its computed source/query/schema pins to avoid accidentally approving changed code while editing the caller list. `authorizationRevision` is server-owned and must be removed from an input binding.

```sh
# Example: replace the allowed caller list with one explicitly selected address.
export NEW_CALLER_AGENT_ADDRESS='REPLACE_WITH_NEW_CALLER_AGENT_ADDRESS'
jq --arg caller "$NEW_CALLER_AGENT_ADDRESS" \
  '{expectedRevision:.revision,binding:(.binding|del(.authorizationRevision)|.allowedCallerAgentAddresses=[$caller])}' \
  current.json > update.json
signed_curl "$OWNER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" PUT '/api/programs/bindings' update.json > updated.json

# Revoke using a freshly inspected revision.
signed_curl "$OWNER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" GET "$BINDING_PATH" > current.json
jq '{contextGraphId,operationIri,expectedRevision:.revision}' current.json > revoke.json
signed_curl "$OWNER_KEY_FILE" "$RUNNER_PEER_ID" "$RUNNER_URL" DELETE '/api/programs/bindings' revoke.json

# A replay of the previously successful UUID is now rejected (403).
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" POST '/api/programs/execute' authorized-invocation.json
```

Revocation persists `enabled:false` plus a new revision. It takes effect before the management response is returned and survives restart. Running executions recheck it before subsequent effects and before releasing results; completed writes are not rolled back. Re-enable only through a new owner/operator `PUT` against the current revision, which repeats Program validation. A slow concurrent approval cannot overwrite a newer update/revocation: it receives 409.

To authorize a changed Program, review the new source, then PUT its new Program IRI/layer and source hash (or omit the source hash to compute the current one during this explicit approval). Renew query-definition and output-schema pins when changing those contracts. Merely editing/re-uploading the stored source does not update an existing permission.

Route replacement and removal use the same revision contract:

```sh
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" GET "$ROUTE_PATH" > current-route.json
# Replace the destination; the new runner must authorize this caller independently.
export NEW_RUNNER_PEER_ID='REPLACE_WITH_NEW_RUNNER_PEER_ID'
jq --arg peer "$NEW_RUNNER_PEER_ID" \
  '{expectedRevision:.revision,route:(.route|.targetPeerId=$peer)}' current-route.json > update-route.json
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" PUT '/api/programs/routes' update-route.json > current-route.json

# Remove the route using the revision returned by the update.
jq '{contextGraphId,operationIri,expectedRevision:.revision}' current-route.json > remove-route.json
signed_curl "$CALLER_KEY_FILE" "$CLIENT_PEER_ID" "$CLIENT_URL" DELETE '/api/programs/routes' remove-route.json
```

Removing routing does not revoke permission on runner. Revoke the destination binding when withdrawing execution rights.

## Existing named queries and asset creation

The binding uses the same permissions as configuration-file bindings:

- **Named query:** replace `sparqlRead` with `query: {"selector":"read-device","outputSchema":...}` and use a Program declaring the matching `dkg/query@1` tool. The API reads the tenant's saved query and computes `queryIri`, `definitionSha256` and `outputSchemaSha256`; any supplied pins must match. The schema is mandatory and closed/bounded. No arbitrary selector or parameters can be supplied at invocation.
- **Raw read:** `sparqlRead` requires its exact tool IRI, read layer, timeout, row/quad limit, output byte limit and closed schema. It computes `outputSchemaSha256`. Existing read-only, graph-scope and cooperative cancellation limits apply.
- **Asset creation:** add `assetCreation: {"toolIri":"urn:example:tool:asset-create"}` and use a Program declaring/calling `dkg/asset-create@1`. The API checks the local executor's write authority and the literal content contract. The host still fixes the data graph, author, deterministic asset name and `executionLayer`. The existing durable effect recovery and publication checks remain in force. Merely adding the permission does not run the creation.

Use the same POST/PUT envelope for these permissions; unsupported fields and supplied mismatching pins are rejected. Several permitted operations may be composed across delegates, with one typed call per delegate. No host effect is dispatched during activation preflight.

## Storage, precedence and failure behavior

Entries live in the runtime's `semantic-runtime.sqlite` database, schema version 3, with transactional writes and monotonically increasing revisions. The daemon owns this database; do not run multiple daemons against it. Each kind has at most 256 durable entries including revocation tombstones, and effective bindings/routes are also bounded. Back up the database with the node's state.

For the exact `(contextGraphId, operationIri)` key:

1. A durable API record wins over `semanticRuntime.programBindings` / `programRoutes` from the file.
2. A revoked API binding remains disabled even if the file contains an enabled binding.
3. A removed API route remains masked even if it is still present in the file.
4. File-only entries continue to work and appear with `origin: "configuration-file"`, revision `0`. Override/revoke them with PUT/DELETE and `expectedRevision: 0`. POST rejects any existing entry, including a tombstone. API writes never edit the configuration file.

GET exposes the effective binding/route and its origin/revision; revoked bindings remain inspectable, and removed routes return `route:null`. A corrupt durable record fails startup rather than falling back to a potentially more permissive file entry. Local validation, SQLite persistence, typed component preflight, and signed in-process transport tests are separate from live deployment proof. This change does not by itself validate a remote node's registration, shared-memory readiness, network transport or VM publication.

A graph/operation cannot have both a local binding and an outbound route on the same node. The check applies to the complete configuration after file defaults, API overrides and route-removal tombstones are merged. Conflicting POST/PUT requests return `AMBIGUOUS_PROGRAM_ROUTE` (409) without changing either SQLite or active configuration; restored conflicts prevent runtime startup. Disabled/revoked bindings still reserve their operation as local, matching the existing configuration-file invariant. Use a distinct operation IRI for an outbound route. A removed route no longer conflicts with a local binding, including when its file default remains present.
