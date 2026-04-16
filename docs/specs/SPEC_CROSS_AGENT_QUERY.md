# Cross-Agent Query Protocol

**Status**: DRAFT v0.1  
**Date**: 2026-02-25  
**Scope**: Protocol for one agent to query another agent's knowledge store remotely.  
**Depends on**: Part 1 (local query engine), Paranet Lifecycle, Access Control basics  
**Protocol ID**: `/dkg/query/2.0.0`

---

## 1. Problem Statement

Today, agents can only query their own local triple store. If Agent A publishes to paranet "finance" and Agent B is subscribed, Agent B already has the data via gossipsub replication. But there are important cases where local-only queries fall short:

1. **Selective replication**: Not every node stores every triple. A node might subscribe to a paranet but only replicate a subset (future sharding). It needs to ask peers for what it doesn't have.
2. **Discovery queries**: Agent A wants to know "what entities does Agent B know about?" without subscribing to every paranet Agent B serves.
3. **On-demand access**: Agent A needs a specific knowledge asset from a paranet it's not subscribed to. Rather than subscribing and syncing the entire paranet, it asks a specific node.
4. **Private data queries**: Agent A knows Agent B has private triples about an entity. It needs to request access (this bridges to the access protocol).
5. **Federated queries**: A complex query spans multiple paranets hosted by different nodes. Each node answers its part.

### Design principles

- **No raw SPARQL over the wire by default.** Structured lookup types prevent injection, exfiltration, and resource exhaustion.
- **Agent B is always in control.** Agent B decides what to answer, what to reject, and how much to reveal.
- **Defense in depth.** Multiple safety layers, any one of which can block abuse.
- **Pay-per-query ready.** The protocol has hooks for payment proofs even though payment is not enforced in this version.

---

## 2. Protocol Overview

```
Agent A                   libp2p stream              Agent B
   │                     /dkg/query/2.0.0               │
   │                                                    │
   ├── QueryRequest ────────────────────────────────►   │
   │   { operationId, lookupType, params }              │
   │                                                    ├── Validate request
   │                                                    ├── Check access policy
   │                                                    ├── Execute lookup
   │                                                    ├── Apply result limits
   │   ◄──────────────────────────────────── QueryResponse
   │   { operationId, results, truncated, error }       │
```

The protocol uses **request-response** over a libp2p stream (not gossipsub). Each query is a single round-trip: one request, one response. This is simpler and more predictable than streaming.

---

## 3. Lookup Types

### 3.1 ENTITY_BY_UAL

Retrieve all triples for a specific knowledge asset by its UAL.

**Input**: `ual` (e.g., `did:dkg:base:84532/0x15e0.../1`)  
**Output**: N-Triples for that entity  
**Risk**: Low — single entity, bounded size  
**Use case**: "Show me knowledge asset X"

Agent B resolves the UAL to an entity URI, finds all triples with that subject in the paranet's data graph, and returns them.

### 3.2 ENTITIES_BY_TYPE

Find entities of a given RDF type within a paranet.

**Input**: `rdfType` (e.g., `https://schema.org/Person`), `paranetId`, `limit`  
**Output**: List of entity URIs (not full triples)  
**Risk**: Medium — bounded by `limit` parameter (max 100)  
**Use case**: "What Person entities exist in paranet X?"

Returns only entity URIs, not their full triple sets. The caller can follow up with `ENTITY_TRIPLES` for entities of interest. This two-step pattern prevents accidental exfiltration of large datasets.

### 3.3 ENTITY_TRIPLES

Retrieve all triples for a specific entity URI within a paranet.

**Input**: `entityUri` (e.g., `did:dkg:entity:alice`), `paranetId`  
**Output**: N-Triples for that entity  
**Risk**: Low — single entity, bounded size  
**Use case**: "Give me everything you know about entity Y in paranet X"

### 3.4 SPARQL_QUERY (opt-in)

Execute a read-only SPARQL query against a specific paranet.

**Input**: `sparql` (SPARQL string), `paranetId`, `limit`, `timeout`  
**Output**: JSON-serialized SPARQL result bindings  
**Risk**: High — arbitrary query complexity  
**Use case**: "Run this specific SPARQL query for me"

This type is **disabled by default**. Agent B must explicitly enable it in its configuration. Even when enabled, multiple safety guards apply (see §6).

---

## 4. Message Format

### QueryRequest

```typescript
interface QueryRequest {
    operationId: string;        // UUID, for correlation
    lookupType: LookupType;     // enum: ENTITY_BY_UAL | ENTITIES_BY_TYPE | ENTITY_TRIPLES | SPARQL_QUERY
    paranetId?: string;         // Target paranet (required for all except ENTITY_BY_UAL)
    ual?: string;               // For ENTITY_BY_UAL
    entityUri?: string;         // For ENTITY_TRIPLES
    rdfType?: string;           // For ENTITIES_BY_TYPE
    sparql?: string;            // For SPARQL_QUERY
    limit?: number;             // Max results (default: 100, max: 1000)
    timeout?: number;           // Max execution time in ms (default: 5000, max: 30000)
    paymentProof?: bytes;       // Reserved for future payment integration
}

enum LookupType {
    ENTITY_BY_UAL = 0,
    ENTITIES_BY_TYPE = 1,
    ENTITY_TRIPLES = 2,
    SPARQL_QUERY = 3,
}
```

### QueryResponse

```typescript
interface QueryResponse {
    operationId: string;        // Matches request
    status: QueryStatus;        // OK | ERROR | ACCESS_DENIED | RATE_LIMITED | NOT_FOUND | GAS_LIMIT_EXCEEDED
    ntriples?: string;          // N-Triples serialized result (for entity lookups)
    bindings?: string;          // JSON-serialized SPARQL bindings (for SPARQL_QUERY)
    entityUris?: string[];      // List of URIs (for ENTITIES_BY_TYPE)
    truncated: boolean;         // True if results were capped by limit
    resultCount: number;        // Total results before truncation
    gasConsumed?: number;       // DKG gas consumed (for future billing)
    error?: string;             // Human-readable error message
}

enum QueryStatus {
    OK = 0,
    ERROR = 1,
    ACCESS_DENIED = 2,
    RATE_LIMITED = 3,
    NOT_FOUND = 4,
    GAS_LIMIT_EXCEEDED = 5,
    UNSUPPORTED_LOOKUP = 6,
}
```

### Wire format

Messages are serialized as length-prefixed JSON over the libp2p stream. JSON is chosen over protobuf for this version because:
- Easier to debug (human-readable on the wire).
- The DKG already uses JSON for the daemon API.
- Performance is not critical for query request/response (unlike gossipsub bulk replication).

A future version can switch to protobuf if benchmarks show JSON serialization is a bottleneck.

---

## 5. Access Control

### 5.1 Query Access Policy

Each node configures which paranets are queryable and by whom:

```json
// ~/.dkg/config.json
{
    "queryAccess": {
        "defaultPolicy": "deny",
        "paranets": {
            "testing": {
                "policy": "public",
                "allowedLookupTypes": ["ENTITY_BY_UAL", "ENTITIES_BY_TYPE", "ENTITY_TRIPLES"],
                "sparqlEnabled": false
            },
            "agents": {
                "policy": "public",
                "allowedLookupTypes": ["ENTITY_BY_UAL", "ENTITIES_BY_TYPE", "ENTITY_TRIPLES"],
                "sparqlEnabled": false
            },
            "premium-data": {
                "policy": "allowList",
                "allowedPeers": ["12D3KooW..."],
                "allowedLookupTypes": ["ENTITY_BY_UAL", "ENTITY_TRIPLES", "SPARQL_QUERY"],
                "sparqlEnabled": true,
                "sparqlTimeout": 10000,
                "sparqlMaxResults": 500
            }
        }
    }
}
```

### 5.2 Policy Types

| Policy | Behavior |
|---|---|
| `deny` | Reject all remote queries (default) |
| `public` | Accept queries from any peer |
| `allowList` | Accept queries only from listed peer IDs |
| `tokenGated` | Accept queries from peers with valid payment proof (future) |

### 5.3 Policy Evaluation

When a `QueryRequest` arrives:

```
1. Is the requested paranet in queryAccess.paranets?
   NO → check defaultPolicy → likely "deny" → return ACCESS_DENIED

2. Does the policy allow this peer?
   - public: yes
   - allowList: check if agent address (or legacy peer ID) is in allowedAgents/allowedPeers
   - deny: no
   NO → return ACCESS_DENIED

3. Is the lookup type allowed for this paranet?
   NO → return UNSUPPORTED_LOOKUP

4. If SPARQL_QUERY: is sparqlEnabled for this paranet?
   NO → return UNSUPPORTED_LOOKUP

5. Rate limit check: has this peer exceeded queries/minute?
   YES → return RATE_LIMITED

6. Execute the query
```

---

## 6. Safety Layers

### Layer 1: No raw SPARQL by default

The three structured lookup types (`ENTITY_BY_UAL`, `ENTITIES_BY_TYPE`, `ENTITY_TRIPLES`) are translated into SPARQL internally by Agent B. The remote agent never composes arbitrary SPARQL.

### Layer 2: Access policy

Per-paranet, per-peer access control (§5). Default deny.

### Layer 3: Read-only guard

Even for `SPARQL_QUERY`, the existing `validateReadOnlySparql()` rejects any mutating keywords (INSERT, DELETE, DROP, CLEAR, LOAD, COPY, MOVE, ADD).

### Layer 4: Complexity limits (SPARQL_QUERY only)

| Limit | Default | Configurable |
|---|---|---|
| Max execution time | 5,000 ms | Yes (`sparqlTimeout`) |
| Max result rows | 1,000 | Yes (`sparqlMaxResults`) |
| Max result size | 1 MB | Yes |
| SERVICE clauses | Blocked | No (always blocked — prevents federation abuse) |
| Subqueries | Allowed | Configurable (can be blocked) |

If execution exceeds the time limit, the query is killed and a partial result returned with `status: GAS_LIMIT_EXCEEDED`.

### Layer 5: Result size cap

All lookup types have a maximum result size (default: 1MB serialized). Larger results are truncated with `truncated: true`.

### Layer 6: Rate limiting

Per-peer rate limits (default: 60 queries/minute). Configurable per-paranet. Exceeding the limit returns `RATE_LIMITED` with a `Retry-After` hint in the error message.

---

## 7. Query Handler Implementation

### 7.1 Protocol Registration

The query handler registers on the libp2p protocol router:

```typescript
node.handle('/dkg/query/2.0.0', async (stream, peerId) => {
    const request = await readQueryRequest(stream);
    const response = await queryHandler.handle(request, peerId);
    await writeQueryResponse(stream, response);
});
```

### 7.2 QueryHandler

```typescript
class QueryHandler {
    constructor(
        private store: TripleStore,
        private queryEngine: DKGQueryEngine,
        private config: QueryAccessConfig,
        private rateLimiter: RateLimiter,
    ) {}

    async handle(request: QueryRequest, peerId: PeerId): Promise<QueryResponse> {
        // 1. Validate request structure
        // 2. Check access policy for (paranetId, peerId, lookupType)
        // 3. Check rate limit
        // 4. Dispatch to lookup handler
        // 5. Apply result limits
        // 6. Return response
    }
}
```

### 7.3 Lookup Dispatch

```typescript
switch (request.lookupType) {
    case LookupType.ENTITY_BY_UAL:
        return this.lookupByUAL(request.ual);

    case LookupType.ENTITIES_BY_TYPE:
        return this.lookupByType(request.paranetId, request.rdfType, request.limit);

    case LookupType.ENTITY_TRIPLES:
        return this.lookupEntityTriples(request.paranetId, request.entityUri);

    case LookupType.SPARQL_QUERY:
        return this.executeSparql(request.paranetId, request.sparql, request.limit, request.timeout);
}
```

Each handler generates the appropriate SPARQL internally:

```typescript
// ENTITY_BY_UAL → resolves UAL to entity URI, then fetches triples
// ENTITIES_BY_TYPE → SELECT ?entity WHERE { GRAPH <paranet> { ?entity a <rdfType> } } LIMIT N
// ENTITY_TRIPLES → SELECT ?p ?o WHERE { GRAPH <paranet> { <entityUri> ?p ?o } }
// SPARQL_QUERY → validateReadOnlySparql(sparql); execute with timeout
```

---

## 8. Query Client

### 8.1 Agent API

```typescript
class DKGAgent {
    // Query a remote peer
    async queryRemote(
        peerId: PeerId | string,
        request: Omit<QueryRequest, 'operationId'>
    ): Promise<QueryResponse>;

    // Convenience methods
    async lookupEntity(peerId: PeerId, ual: string): Promise<Quad[]>;
    async findEntitiesByType(peerId: PeerId, paranetId: string, rdfType: string, limit?: number): Promise<string[]>;
    async queryRemoteSparql(peerId: PeerId, paranetId: string, sparql: string): Promise<QueryResult>;
}
```

### 8.2 Stream Management

The client opens a new libp2p stream for each query:

```typescript
async queryRemote(peerId: PeerId, request: QueryRequest): Promise<QueryResponse> {
    const stream = await this.node.dialProtocol(peerId, '/dkg/query/2.0.0');
    await writeQueryRequest(stream, { ...request, operationId: uuid() });
    const response = await readQueryResponse(stream);
    stream.close();
    return response;
}
```

For repeated queries to the same peer, connection multiplexing (yamux) ensures efficient reuse of the underlying TCP connection.

---

## 9. CLI Integration

### New commands

```bash
# Query a specific remote peer
dkg query-remote <peer-name-or-id> [paranet] -q "SPARQL..."
dkg query-remote <peer-name-or-id> --entity <uri> --paranet <id>
dkg query-remote <peer-name-or-id> --ual <ual>
dkg query-remote <peer-name-or-id> --type <rdf-type> --paranet <id>
```

### Examples

```bash
# Look up a specific knowledge asset on the relay node
dkg query-remote v9-cobb --ual "did:dkg:base:84532/0x15e0.../1"

# Find all Person entities on a peer's "testing" paranet
dkg query-remote v9-cobb --type "https://schema.org/Person" --paranet testing

# Run a SPARQL query on a peer (if they allow it)
dkg query-remote v9-cobb testing -q "SELECT ?s ?name WHERE { ?s <https://schema.org/name> ?name }"
```

### Daemon API

```
POST /api/query-remote
{
    "peerId": "12D3KooW...",
    "lookupType": "ENTITY_BY_UAL",
    "ual": "did:dkg:base:84532/0x15e0.../1"
}

Response:
{
    "status": "OK",
    "ntriples": "<did:dkg:entity:alice> <https://schema.org/name> \"Alice\" .\n...",
    "truncated": false,
    "resultCount": 3,
    "gasConsumed": 450
}
```

---

## 10. Gas Metering Integration

Every query operation is metered (when gas metering is enabled):

| Operation | Gas Cost |
|---|---|
| Parse incoming request | `G_parse` |
| Access policy check | Fixed (negligible) |
| ENTITY_BY_UAL | `G_scan × triples_for_entity` |
| ENTITIES_BY_TYPE | `G_scan × triples_scanned + G_result_byte × result_size` |
| ENTITY_TRIPLES | `G_scan × triples_for_entity` |
| SPARQL_QUERY | Full query gas (scan + join + filter + sort + result) |
| Serialize response | `G_result_byte × response_size` |

The `gasConsumed` field in the response reports actual gas used. In the future, this enables pay-per-query: Agent A must include a payment proof covering at least the estimated gas cost.

---

## 11. Error Handling

| Scenario | Response |
|---|---|
| Unknown paranet | `NOT_FOUND`: "Paranet 'xyz' not found in local store" |
| Unknown entity/UAL | `OK` with empty results (not an error — absence of knowledge is valid) |
| Access denied | `ACCESS_DENIED`: "Paranet 'xyz' is not queryable" or "Your peer ID is not in the allow list" |
| Rate limited | `RATE_LIMITED`: "Rate limit exceeded. Retry after {N} seconds" |
| SPARQL disabled | `UNSUPPORTED_LOOKUP`: "SPARQL queries are not enabled for paranet 'xyz'" |
| Query timeout | `GAS_LIMIT_EXCEEDED`: "Query exceeded time limit ({N}ms)" |
| Malformed request | `ERROR`: "Invalid request: {details}" |
| Internal error | `ERROR`: "Internal error processing query" (no details leaked) |

---

## 12. Future Extensions

These are **not** part of this spec but are designed for:

### Payment integration (Part 2)

The `paymentProof` field in `QueryRequest` is reserved. When payment channels or x402 are implemented:

1. Agent A estimates gas cost for the query.
2. Agent A creates a payment channel state update covering the cost.
3. Agent A includes the signed state update as `paymentProof`.
4. Agent B verifies the payment proof before executing.
5. Agent B settles the channel periodically.

### Caching

Frequently requested entities could be cached by the responding node to avoid repeated triple store lookups. Cache invalidation is straightforward: any publish or update to the entity invalidates the cache.

### Query routing

When Agent A doesn't know which peer has the data, it could broadcast a `QueryRequest` to the paranet's gossipsub topic. The first peer with the answer responds. This is expensive (all peers evaluate) and should be used sparingly — direct peer queries are preferred.

### Streaming results

For very large result sets, the response could switch from a single message to a stream of chunks. The protocol already uses libp2p streams, so this is a natural extension.

---

## 13. Open Questions

| ID | Question | Options |
|---|---|---|
| OQ1 | Should query access config be per-peer or per-identity? | Per-peer is simpler (peer ID is available in the stream). Per-identity requires looking up the peer's on-chain identity, which adds latency but is more meaningful. Start with per-peer, migrate to per-identity later. |
| OQ2 | Should ENTITIES_BY_TYPE return full triples or just URIs? | URIs only (current design). Returning full triples for many entities could be huge. The two-step pattern (find URIs, then fetch interesting ones) is safer. |
| OQ3 | Connection pooling? | Not needed initially — yamux multiplexing handles concurrent queries over a single TCP connection efficiently. Add explicit pooling only if benchmarks show overhead. |
| OQ4 | Should the protocol support subscriptions (long-lived query streams)? | Not in v2.0.0. Request-response is simpler. Subscriptions (e.g., "notify me when new Person entities appear") could be a v3.0.0 feature or handled via gossipsub. |
| OQ5 | Peer name resolution? | The CLI uses peer names (e.g., `v9-cobb`) from the agent discovery system. The daemon resolves name → peerId via the agents paranet. If the peer isn't known, the user provides the peer ID directly. |
