# Program authorization and routing through HTTP

A Program is stored RDF data until a Context Graph owner or an explicitly authenticated node operator installs an execution binding. A grant inside the S-expression requests a capability; it does not grant authority. Approval is a durable permission, checked on each invocation and before effects/results, not an interactive confirmation per request.

The APIs configure existing typed tools and the existing agent-key-signed inbox protocol. They add no dynamic inputs, arbitrary SPARQL writes, or automatic replication of the source Program. A Program can reside in a separate Context Graph from the data it reads or writes.

## Credentials and prerequisites

The examples use two nodes: **runner** hosts the private data and executes the Program; **client** forwards the caller's signed invocation. `program-library` and `tenant-data` below stand for their registered **canonical IDs**, which may be qualified on your network. Full `did:dkg:context-graph:...` graph URIs are also accepted and returned as canonical IDs without that URI prefix. Display-name/suffix aliases are not resolved by these APIs. Register/prepare the graphs and local agents using the normal DKG setup first.

| Credential | Issuer | Represented identity | Scope in this example |
| --- | --- | --- | --- |
| `OWNER_AGENT_TOKEN` | runner's agent registration/auth service | `OWNER_AGENT_ADDRESS`, the owner of the data graph | Upload to its source graph; inspect/approve/update/revoke bindings in graphs it owns. Normal graph permissions still apply. |
| `RUNNER_OPERATOR_TOKEN` | runner's node API auth service | runner node operator, not an agent wallet | Manage any local binding. Does not stand in for an invoke-only caller. |
| `CLIENT_OPERATOR_TOKEN` | client's node API auth service | client node operator | Manage outbound routes on client. Grants no authority at runner. |
| `CALLER_AGENT_TOKEN` | client's agent registration/auth service | `CALLER_AGENT_ADDRESS` | Authenticate the invocation to client. Client must hold that agent's custodial signing key. |

Tokens are bearer/API credentials in `Authorization: Bearer ...`. The client then signs the existing version-3 delegation with the **caller's own agent key**; the key is never sent to the runner. The signature binds the graph, operation, invocation UUID, destination peer and sending peer and expires within five minutes. Runner checks the signer against its stored binding. No runner bearer token, general data-graph membership, or node-default identity is needed by this invoke-only caller.

A node-operator credential must actually be classified as `nodeOperator` by DKG authentication. Merely naming a token `operator` does not confer authority. Anonymous/public requests, including anonymous requests with HTTP auth disabled, cannot manage bindings or routes. An ordinary graph member cannot approve bindings.

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
# Set these to credentials/addresses from your actual local registrations:
export OWNER_AGENT_TOKEN='REPLACE_WITH_RUNNER_OWNER_AGENT_TOKEN'
export OWNER_AGENT_ADDRESS='REPLACE_WITH_OWNER_AGENT_ADDRESS'
export CLIENT_OPERATOR_TOKEN='REPLACE_WITH_CLIENT_NODE_OPERATOR_TOKEN'
export CALLER_AGENT_TOKEN='REPLACE_WITH_CLIENT_CALLER_AGENT_TOKEN'
export CALLER_AGENT_ADDRESS='REPLACE_WITH_CALLER_AGENT_ADDRESS'
export RUNNER_PEER_ID='REPLACE_WITH_RUNNER_PEER_ID_FROM_API_STATUS'
```

Use your configured HTTPS endpoint or trusted local tunnel when sending bearer tokens. The graph IDs, device IRI and predicate in this example are illustrative; use data and projections you intend to disclose.

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

curl --fail-with-body -sS "$RUNNER_URL/api/knowledge-assets" \
  -H "Authorization: Bearer $OWNER_AGENT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @upload.json
```

The source graph must already be registered and ready for sharing; authorization fails closed if the selected Program view is unavailable or ambiguous. For a new version, upload a new asset name and versioned Program IRI. Normal asset lifecycle/retry rules still apply.

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

curl --fail-with-body -sS "$RUNNER_URL/api/programs/bindings" \
  -H "Authorization: Bearer $OWNER_AGENT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @authorization.json > approved.json

jq '{revision,bindingDigest,binding,resolution}' approved.json
```

`program.programLayer` selects source storage, `sparqlRead.layer` selects data being read, and `executionLayer` selects persisted Execution records and any explicitly approved created assets. They are independent. A result schema bounds shape/size; the owner must review the query projection and filters to decide which data to release.

Inspect one binding, or omit `operationIri` to list that graph's bindings:

```sh
curl --fail-with-body -sS -G "$RUNNER_URL/api/programs/bindings" \
  -H "Authorization: Bearer $OWNER_AGENT_TOKEN" \
  --data-urlencode "contextGraphId=$DATA_GRAPH" --data-urlencode "operationIri=$OPERATION_IRI" > current.json
```

## 3. Configure the outbound route on client

This is an operator-only routing decision. Runner's approval is independent.

```sh
jq -n --arg cg "$DATA_GRAPH" --arg op "$OPERATION_IRI" --arg peer "$RUNNER_PEER_ID" \
  '{route:{contextGraphId:$cg,operationIri:$op,targetPeerId:$peer}}' > route.json
curl --fail-with-body -sS "$CLIENT_URL/api/programs/routes" \
  -H "Authorization: Bearer $CLIENT_OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @route.json > routing.json

curl --fail-with-body -sS -G "$CLIENT_URL/api/programs/routes" \
  -H "Authorization: Bearer $CLIENT_OPERATOR_TOKEN" \
  --data-urlencode "contextGraphId=$DATA_GRAPH" --data-urlencode "operationIri=$OPERATION_IRI"
```

The client need not subscribe to or read the data graph to install this canonical graph/operation-to-peer mapping. Network reachability and peer discovery must be configured normally. There is no alternate peer or unsigned transport fallback.

## 4. Invoke the operation

```sh
export INVOCATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
jq -n --arg cg "$DATA_GRAPH" --arg op "$OPERATION_IRI" --arg id "$INVOCATION_ID" \
  '{contextGraphId:$cg,operationIri:$op,invocationId:$id}' > invocation.json
curl --fail-with-body -sS "$CLIENT_URL/api/programs/execute" \
  -H "Authorization: Bearer $CALLER_AGENT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @invocation.json
```

Reuse the same UUID for a retry. Each delivery gets a fresh transport ID so the destination's current permission checks cannot be skipped by transport response caching. Caller, source, output contracts, memory layers and the permission revision are bound to replay validation. A changed permission requires a new invocation UUID. The existing `programIri` spelling for configured operations remains supported; new clients should use `operationIri`, which never falls back to direct Program execution when no binding or route exists.

Successful output includes `executionIri`, `executionLayer`, `persisted` and permitted outputs. VM execution also requires its existing publication evidence. Invocation approval does not add the caller to the graph, and does not enable `POST /api/query` or direct Program/source reads. Private graph ACLs continue to govern those APIs; a denied raw query may return empty bindings under the existing query contract.

## 5. Update or revoke

An update is a complete replacement of the approved binding. Start with an owner-authenticated GET and keep its computed source/query/schema pins to avoid accidentally approving changed code while editing the caller list. `authorizationRevision` is server-owned and must be removed from an input binding.

```sh
# Example: replace the allowed caller list with one explicitly selected address.
export NEW_CALLER_AGENT_ADDRESS='REPLACE_WITH_NEW_CALLER_AGENT_ADDRESS'
jq --arg caller "$NEW_CALLER_AGENT_ADDRESS" \
  '{expectedRevision:.revision,binding:(.binding|del(.authorizationRevision)|.allowedCallerAgentAddresses=[$caller])}' \
  current.json > update.json
curl --fail-with-body -sS -X PUT "$RUNNER_URL/api/programs/bindings" \
  -H "Authorization: Bearer $OWNER_AGENT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @update.json > updated.json

# Revoke using a freshly inspected revision.
curl --fail-with-body -sS -G "$RUNNER_URL/api/programs/bindings" \
  -H "Authorization: Bearer $OWNER_AGENT_TOKEN" \
  --data-urlencode "contextGraphId=$DATA_GRAPH" --data-urlencode "operationIri=$OPERATION_IRI" > current.json
jq '{contextGraphId,operationIri,expectedRevision:.revision}' current.json > revoke.json
curl --fail-with-body -sS -X DELETE "$RUNNER_URL/api/programs/bindings" \
  -H "Authorization: Bearer $OWNER_AGENT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @revoke.json

# A replay of the previously successful UUID is now rejected (403).
curl -sS -w '\nHTTP %{http_code}\n' "$CLIENT_URL/api/programs/execute" \
  -H "Authorization: Bearer $CALLER_AGENT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @invocation.json
```

Revocation persists `enabled:false` plus a new revision. It takes effect before the management response is returned and survives restart. Running executions recheck it before subsequent effects and before releasing results; completed writes are not rolled back. Re-enable only through a new owner/operator `PUT` against the current revision, which repeats Program validation. A slow concurrent approval cannot overwrite a newer update/revocation: it receives 409.

To authorize a changed Program, review the new source, then PUT its new Program IRI/layer and source hash (or omit the source hash to compute the current one during this explicit approval). Renew query-definition and output-schema pins when changing those contracts. Merely editing/re-uploading the stored source does not update an existing permission.

Route replacement and removal use the same revision contract:

```sh
curl --fail-with-body -sS -G "$CLIENT_URL/api/programs/routes" \
  -H "Authorization: Bearer $CLIENT_OPERATOR_TOKEN" \
  --data-urlencode "contextGraphId=$DATA_GRAPH" --data-urlencode "operationIri=$OPERATION_IRI" > current-route.json
# Replace the destination; the new runner must authorize this caller independently.
export NEW_RUNNER_PEER_ID='REPLACE_WITH_NEW_RUNNER_PEER_ID'
jq --arg peer "$NEW_RUNNER_PEER_ID" \
  '{expectedRevision:.revision,route:(.route|.targetPeerId=$peer)}' current-route.json > update-route.json
curl --fail-with-body -sS -X PUT "$CLIENT_URL/api/programs/routes" \
  -H "Authorization: Bearer $CLIENT_OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @update-route.json > current-route.json

# Remove the route using the revision returned by the update.
jq '{contextGraphId,operationIri,expectedRevision:.revision}' current-route.json > remove-route.json
curl --fail-with-body -sS -X DELETE "$CLIENT_URL/api/programs/routes" \
  -H "Authorization: Bearer $CLIENT_OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @remove-route.json
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
