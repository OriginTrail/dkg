# Tenant-approved Program operations

A tenant can grant IDENER permission to invoke a fixed read operation without granting IDENER general access to its Context Graph. The Program may be stored in a different Context Graph and authored by Trace Labs. The tenant's local custodial agent executes it against the tenant graph under the tenant's approved local binding.

This is a manually configured, query-only path. `programBindings` grants are independent of the optional `programPolicy` used for direct local Program composition; both may be configured, but a bound operation still admits only its fixed query and cannot invoke an LLM. The source Program must already be available and readable by the executor on the tenant node. It does not fetch Programs from another node or replicate the tenant data to the Program author's node.

## Setup and activation

1. Trace Labs supplies a versioned `sr:Program` in the source graph, in any supported memory layer (`wm`, `swm`, or `vm`) that the tenant executor can read. Its source calls one fixed saved-query selector through `dkg/query@1` and declares exactly one tool IRI; the host maps that declaration exclusively to its installed query adapter. No child Programs, LLM calls or remote execution are admitted through this path.
2. The tenant installs/reviews the named query in its own query catalog and defines a closed, bounded result schema. The query's projection is the data disclosure being approved; a schema alone does not decide which rows are appropriate to disclose.
3. The tenant adds a `semanticRuntime.programBindings` entry: stable operation IRI, tenant graph, allowed caller identities, local executor, exact source graph/Program/layer/author/source hash, and query definition/schema pins. Only the tenant operator edits this local configuration. There is no installation or approval API in this version.
4. Apply the configuration through the daemon's normal restart procedure. The authenticated IDENER address must be in the binding's caller list. For signed inbox invocation, IDENER proves that address with its own signing key. For direct tenant HTTP calls, IDENER uses an agent-bound credential issued by the tenant node. A node-default/implicit operator identity is not an invoke-only credential.

The loaded binding supplies the execution policy and authorizes only the host's `dkg/query@1` adapter. No `operatorPolicyIri`, VM policy, or VM tool offer is required for this bound operation. The host still checks the installed/enabled adapter, graph access, source/author pins, exact query definition, result schema and current grant. Direct invocation outside `programBindings` still requires its operator-authored VM policy and tool offers. This does not bypass the storage layer's access or graph-authority checks: a locally stored Program must still be readable through the selected memory view.

This configuration template uses illustrative DMaaST identities and measurement vocabulary, not a claim about the deployed Kamstrup dataset. Replace addresses, IRIs and hash placeholders with reviewed values before enabling it. `sourceHash` is lowercase SHA-256 of the exact UTF-8 S-expression source. Generate `query` using `createSemanticQueryPin(selector, decodedCatalogItem, outputSchema)` from `packages/cli/src/semantic-runtime-query-pins.ts`; it hashes the complete saved-query definition, including SPARQL, parameters/defaults, scope and view.

```json
{
  "semanticRuntime": {
    "enabled": true,
    "programBindings": [{
      "operationIri": "urn:dmaast:operation:read-w10",
      "contextGraphId": "dmaast-kamstrup",
      "enabled": true,
      "allowedCallerAgentAddresses": ["0x2222222222222222222222222222222222222222"],
      "executorAgentAddress": "0x1111111111111111111111111111111111111111",
      "program": {
        "contextGraphId": "tracelabs-programs",
        "programIri": "urn:tracelabs:program:read-w10:1",
        "programLayer": "vm",
        "authorAgentAddress": "0x3333333333333333333333333333333333333333",
        "sourceHash": "REPLACE_WITH_SOURCE_SHA256"
      },
      "query": {
        "selector": "read-w10",
        "queryIri": "urn:dkg:profile:dmaast-kamstrup:query:read-w10",
        "definitionSha256": "REPLACE_WITH_QUERY_DEFINITION_SHA256",
        "outputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": ["bindings"],
          "properties": {
            "bindings": {
              "type": "array",
              "maxItems": 1,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["device", "temperature"],
                "properties": {
                  "device": {"type": "string", "maxLength": 128, "enum": ["urn:kamstrup:device:W10"]},
                  "temperature": {"type": "string", "maxLength": 32}
                }
              }
            }
          }
        },
        "outputSchemaSha256": "REPLACE_WITH_OUTPUT_SCHEMA_SHA256"
      }
    }]
  }
}
```

Example approved source:

```scheme
(strategy dmaast/read-w10
  (version "1.0.0")
  (scope graph:dmaast-kamstrup)
  (goal read-device)
  (supervise one-for-one
    (max-restarts 1) (window-ms 60000)
    (delegate reader
      (grant dkg.query)
      (call dkg/query@1 "read-w10"))))
```

The tenant binding fixes the actual data graph. The `scope` label in the source does not authorize or select a different graph.

## Signed invocation through the IDENER node

For node-to-node execution, IDENER can route the same three-field execute request through the DKG inbox. Add this trusted local configuration on IDENER, alongside `semanticRuntime.enabled: true`:

```json
{
  "semanticRuntime": {
    "enabled": true,
    "programRoutes": [{
      "contextGraphId": "dmaast-kamstrup",
      "operationIri": "urn:dmaast:operation:read-w10",
      "targetPeerId": "REPLACE_WITH_KAMSTRUP_PEER_ID"
    }]
  }
}
```

Restart IDENER after changing the configuration. Keep the tenant's reviewed `programBindings` configuration on Kamstrup. JPB uses its own graph, peer and tenant approval. A route is a destination mapping, not permission to execute. A graph/operation pair cannot have both a local binding and an outbound route on the same node.

SMAP now sends the request to **IDENER's own API**:

```http
POST /api/programs/execute
Authorization: Bearer <IDENER-local-agent-token>
Content-Type: application/json

{
  "contextGraphId": "dmaast-kamstrup",
  "programIri": "urn:dmaast:operation:read-w10",
  "invocationId": "123e4567-e89b-42d3-a456-426614174099"
}
```

The bearer credential is issued by the IDENER node for its local IDENER agent. This implementation requires that agent's signing key to be available in IDENER's custodial keystore. It never borrows the default node wallet or accepts a caller/target override in JSON. A node-operator token without an authenticated agent identity is rejected; a public-key-only agent returns `CALLER_SIGNATURE_UNAVAILABLE`. The HTTP credential has its existing DKG agent permissions; `programRoutes` does not turn it into an endpoint-scoped token.

IDENER signs a version-3 `bound-operation` request using `signAgentDelegation`, then sends it to the configured peer through the existing semantic-runtime inbox skill. The signed scope binds the request version/type, tenant graph, operation IRI, invocation UUID and target peer. The delegation also binds IDENER's sending peer and an issuance/expiry window of at most five minutes. The private key and HTTP token are never sent to the tenant or stored in the Context Graph. No tenant-issued bearer token or tenant-side API registration for IDENER is needed for this signed path.

Kamstrup verifies the signature, expected target scope, actual sending peer and validity window before calling `invokeBoundSemanticProgram` with the verified agent address. Its binding must list that address in `allowedCallerAgentAddresses`. The tenant selects the source Program, query, executor and output contract. IDENER needs no general membership in the tenant data graph; the executor must still have graph access and Program admission. The inbox handler does not forward bound requests again, and the ordinary version-2 Program invocation keeps its membership checks. No `messaging.openSkills` change is required.

Retries use the same UUID. The sender creates a fresh short-lived delegation; the tenant rechecks its current grant and reuses the persisted result only for the same execution identity. A disabled/removed caller remains rejected even when requesting a previously completed result. Configuration changes require the normal restart procedure. The response contains permitted outputs and the private execution reference, not permission to read the tenant's Working Memory.

Both nodes need this implementation, an enabled semantic runtime, and DKG peer connectivity. Unknown/older receivers reject version 3; there is no fallback to a tenant bearer token. `PROGRAM_TARGET_NODE_UNREACHABLE` identifies transport failure. Signing does not fix unavailable tenant graph authority or missing source Programs.

## Direct tenant HTTP API (existing alternative)

IDENER's SMAP backend calls the **Kamstrup tenant node** directly:

```http
POST /api/programs/execute
Authorization: Bearer <IDENER-agent-bound-token>
Content-Type: application/json

{
  "contextGraphId": "dmaast-kamstrup",
  "programIri": "urn:dmaast:operation:read-w10",
  "invocationId": "123e4567-e89b-42d3-a456-426614174099"
}
```

For a configured operation, `programIri` selects the stable operation IRI. The host resolves it to the exact approved source Program; IDENER cannot override the source graph, source version, executor, query, parameters, or output layer. Existing direct Program calls continue to use an actual Program IRI and explicit layers at this same endpoint, under their existing graph permissions. The old `/api/semantic-runtime/invoke` route has been replaced.

An illustrative successful response preserves the existing runtime response shape:

```json
{
  "invocationId": "123e4567-e89b-42d3-a456-426614174099",
  "executionIri": "urn:sr:execution:123e4567-e89b-42d3-a456-426614174099",
  "executionLayer": "wm",
  "outputs": ["{\"queryIri\":\"urn:dkg:profile:dmaast-kamstrup:query:read-w10\",\"result\":{\"bindings\":[{\"device\":\"urn:kamstrup:device:W10\",\"temperature\":\"21.5\"}]}}"],
  "persisted": true
}
```

Execution records remain in the executor's private Working Memory. They record the source Program, stable operation, source and data graph IDs, binding/source hashes, original caller and tenant executor. `appliedPolicy` is the local identifier `urn:dkg:program-binding:<bindingHash>`; `policyHash` binds that approval to the executor and fixed tool descriptor, and broker decisions use `TENANT_PROGRAM_BINDING_ALLOW`. These identify local approval, not a VM publication or on-chain attestation. The execution IRI is a reference, not a grant to read that private graph. IDENER receives only the approved query outputs through the invocation response; raw `/api/query`, Program resolve/fork and inbox authorization remain unchanged.

## Program graph readiness

A bound caller does not become the tenant node's identity. RFC-64 automatic local-principal selection considers the node's default identity and custodial agents; public-key-only API registrations are external callers. An explicit operator identity or authenticated graph-specific approval still takes precedence, and every selected identity must remain in the verified graph roster. Multiple matching custodial identities still require an explicit selection.

An authorized bound invocation whose Program is in SWM checks the tenant executor's graph admission before loading it. If unavailable, it returns HTTP 503 with `PROGRAM_GRAPH_AUTHORITY_UNAVAILABLE`; a caller without binding permission still receives HTTP 403. The normal query-time graph checks remain in effect. Resolve graph authority and retry; a successful read with no matching Program still returns `PROGRAM_NOT_FOUND`. This diagnostic does not grant membership, activate a graph, or publish anything.

## Updates, retries and revocation

- **Activation:** keep the operation IRI stable and explicitly replace its Program/query pins after tenant approval. There is no automatic “latest published” lookup. The active binding is the tenant-approved version.
- **Compatibility:** keep the operation's output contract compatible. Use a new operation IRI for a breaking contract; its callers must be authorized separately.
- **Rollback:** restore the previously approved binding. Use a new invocation UUID for a new execution.
- **Retries:** repeat the same UUID only for the same caller, graph, binding and policy. A completed request replays its persisted outputs after current authorization and query-contract checks. Reusing the UUID across callers or approved versions is rejected. An old execution may no longer be retrievable through this API after activation changes its binding.
- **Revocation:** disable the binding or remove the caller and apply the updated daemon configuration. Config-file edits are not hot reloads. Runtime checks examine the loaded grant before execution, around query dispatch, before persistence and before returning fresh or replayed results; changing that loaded grant invalidates an in-flight request. Revocation cannot retract previously delivered data.

Current limits: one fixed query selector, no request parameters, no raw SPARQL capability, no public execution publication and no paid/LLM binding on this path. Signed cross-node invocation transports the operation request; source Programs must already be readable on the tenant. Query-catalog defaults, if any, are part of the approved definition hash. The WASM import remains unchanged. Parameter forwarding and a catalog installation/approval interface are separate work.
