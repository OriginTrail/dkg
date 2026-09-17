# Tenant-approved Program operations

A tenant can grant IDENER permission to invoke a fixed read operation without granting IDENER general access to its Context Graph. The Program may be stored in a different Context Graph and authored by Trace Labs. The tenant's local custodial agent executes it against the tenant graph under the tenant's existing execution policy.

This is a manually configured, query-only path. `programBindings` grants are independent of the optional `programPolicy` used for direct local Program composition; both may be configured, but a bound operation still admits only its fixed query and cannot invoke an LLM. The source Program must already be available and readable by the executor on the tenant node. It does not fetch Programs from another node or replicate the tenant data to the Program author's node.

## Setup and activation

1. Trace Labs publishes a versioned `sr:Program` in the source graph. Its source calls one fixed saved-query selector through `dkg/query@1`; its tool declaration must match that import. No child Programs, LLM calls or remote execution are admitted through this path.
2. The tenant installs/reviews the named query in its own query catalog and defines a closed, bounded result schema. The query's projection is the data disclosure being approved; a schema alone does not decide which rows are appropriate to disclose.
3. The tenant configures its executor's `sr:ExecutionPolicy` and `sr:offersTool` for `dkg/query@1` in the tenant graph's Verifiable Memory, using the existing runtime policy mechanism.
4. The tenant adds a `semanticRuntime.programBindings` entry: stable operation IRI, tenant graph, allowed caller identities, local executor, exact source graph/Program/layer/author/source hash, and query definition/schema pins. Only the tenant operator edits this local configuration. There is no installation or approval API in this version.
5. Apply the configuration through the daemon's normal restart procedure. IDENER uses an agent-bound credential issued by the tenant node; the authenticated address must be in the binding's caller list. A node-default/implicit operator identity is not an invoke-only credential.

This configuration template uses illustrative DMaaST identities and measurement vocabulary, not a claim about the deployed Kamstrup dataset. Replace addresses, IRIs and hash placeholders with reviewed values before enabling it. `sourceHash` is lowercase SHA-256 of the exact UTF-8 S-expression source. Generate `query` using `createSemanticQueryPin(selector, decodedCatalogItem, outputSchema)` from `packages/cli/src/semantic-runtime-query-pins.ts`; it hashes the complete saved-query definition, including SPARQL, parameters/defaults, scope and view.

```json
{
  "semanticRuntime": {
    "enabled": true,
    "operatorPolicyIri": "urn:sr:policy:kamstrup",
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

## Everyday API call

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

Execution records remain in the executor's private Working Memory. They record the source Program, stable operation, source and data graph IDs, binding/source hashes, original caller and tenant executor. The execution IRI is a reference, not a grant to read that private graph. IDENER receives only the approved query outputs through the invocation response; raw `/api/query`, Program resolve/fork and inbox authorization remain unchanged.

## Updates, retries and revocation

- **Activation:** keep the operation IRI stable and explicitly replace its Program/query pins after tenant approval. There is no automatic “latest published” lookup. The active binding is the tenant-approved version.
- **Compatibility:** keep the operation's output contract compatible. Use a new operation IRI for a breaking contract; its callers must be authorized separately.
- **Rollback:** restore the previously approved binding. Use a new invocation UUID for a new execution.
- **Retries:** repeat the same UUID only for the same caller, graph, binding and policy. A completed request replays its persisted outputs after current authorization and query-contract checks. Reusing the UUID across callers or approved versions is rejected. An old execution may no longer be retrievable through this API after activation changes its binding.
- **Revocation:** disable the binding or remove the caller and apply the updated daemon configuration. Config-file edits are not hot reloads. Runtime checks examine the loaded grant before execution, around query dispatch, before persistence and before returning fresh or replayed results; changing that loaded grant invalidates an in-flight request. Revocation cannot retract previously delivered data.

Current limits: one fixed query selector, no request parameters, no raw SPARQL capability, no public execution publication, no paid/LLM binding on this path, and no cross-node Program invocation. Query-catalog defaults, if any, are part of the approved definition hash. The WASM import remains unchanged. Parameter forwarding and a catalog installation/approval interface are separate work.
