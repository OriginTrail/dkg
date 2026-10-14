# Targeted local Context Graph authority diagnostics

`GET /api/context-graph/{encodedContextGraphId}/authority` returns the node's
current local access policy, curator, on-chain binding and effective allowed
agents for one existing graph. Encode the complete graph ID as one URL segment.
This owner/operator endpoint uses the same native metadata, curator, registration and
revocation getters used by the graph-management APIs. It does not enumerate
other graphs, register a graph, change access or return graph data.

With authentication enabled, a node operator can inspect any graph; an
authenticated agent can inspect only a graph whose native curator DID matches
its authenticated wallet. Foreign agents and anonymous principals receive 403
before an existence check or disclosure of policy, registration or membership.
An allowlist entry or a matching namespace alone does not grant access.
Auth-disabled mode follows the existing node
administration gate and permits local diagnostics. The daemon's normal
authentication guard still rejects invalid/missing credentials when enabled.

Example response:

```json
{
  "contextGraphId": "0x1111111111111111111111111111111111111111/example",
  "accessPolicy": "private",
  "curator": "did:dkg:agent:0x1111111111111111111111111111111111111111",
  "onChainId": null,
  "allowedAgents": ["0x1111111111111111111111111111111111111111"]
}
```

An unknown explicit policy remains `null`; consumers must not treat it as
private. A missing graph returns 404 / `CONTEXT_GRAPH_NOT_FOUND`; malformed URL
encoding returns 400 / `INVALID_CONTEXT_GRAPH_ID`; a lookup failure returns
503 / `CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE` without upstream private details.
This is a local diagnostic view, not a signed or finalized chain attestation.

Monitoring consumers should reread it at each authorization boundary. Do not
cache HTTP responses across writes or use this diagnostic to bypass native
authorization on a subsequent query or write. Native metadata projection
invalidation remains responsible for reflecting local authority changes.
