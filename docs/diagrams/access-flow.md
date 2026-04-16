# Private Data Access Flow

How an agent retrieves private triples from another node that holds the
encrypted private content. This is the `/dkg/access/1.0.0` protocol.

## Context

When a KC is published with `privateQuads`, the publisher:
- Hashes the private triples into a `privateMerkleRoot`
- Anchors that root as a synthetic public triple
- Stores private triples locally in the `PrivateContentStore`

Other nodes only receive the public triples (including the synthetic anchor).
To get the private triples, they must send an access request to a node that
has them.

## Sequence diagram

```mermaid
sequenceDiagram
    actor User

    participant AgentA as Agent A<br/>Requesting
    participant NodeA as Agent A<br/>DKGNode
    participant P2P as P2P Network
    participant NodeB as Agent B<br/>DKGNode
    participant Handler as Agent B<br/>AccessHandler
    participant StoreB as Agent B<br/>TripleStore
    participant PrivB as Agent B<br/>PrivateContentStore

    User ->> AgentA: accessPrivateData(ual, ownerPeerId)
    AgentA ->> AgentA: Generate operationId (UUID)

    AgentA ->> NodeA: sendRequest(ownerPeerId, accessRequest)
    Note right of NodeA: Protocol: /dkg/access/1.0.0<br/>Payload: ual + requesterPeerId<br/>operationId

    NodeA ->> P2P: Direct stream to Agent B
    P2P ->> NodeB: Incoming protocol stream
    NodeB ->> Handler: handleAccess(data, peerId)

    Handler ->> Handler: Decode AccessRequest
    Handler ->> Handler: Check access policy
    Note right of Handler: Who is allowed to access<br/>this private data?<br/>- Public: anyone<br/>- AllowList: specific peers<br/>- TokenGated: requires on-chain proof

    alt Access denied
        Handler -->> NodeB: AccessResponse (denied, reason)
        NodeB -->> P2P: Response
        P2P -->> NodeA: Response
        NodeA -->> AgentA: Error: access denied
    end

    Handler ->> StoreB: query(metadataSparql for UAL)
    StoreB -->> Handler: paranetId + rootEntity

    Handler ->> PrivB: getPrivateTriples(paranetId, rootEntity)
    PrivB -->> Handler: private triples

    Handler ->> Handler: Serialize to N-Triples
    Handler -->> NodeB: AccessResponse (ntriples)
    NodeB -->> P2P: Response
    P2P -->> NodeA: Response
    NodeA -->> AgentA: private triples

    AgentA ->> AgentA: Verify privateMerkleRoot
    Note right of AgentA: Hash received triples<br/>Compare with the synthetic<br/>anchor triple in public data

    alt Verification passes
        AgentA ->> AgentA: Store private triples locally
        AgentA -->> User: Private triples
    else Verification fails
        AgentA -->> User: Error: merkle root mismatch
    end
```

## Access policies

The access handler on Agent B checks whether Agent A is allowed to access
the private data. The policy is per-KC or per-paranet:

| Policy | Description |
|--------|-------------|
| `public` | Any peer can access (private data with public access — useful for data that is integrity-verified but not confidential) |
| `allowList` | Only specific agent addresses (or legacy peer IDs) can access |
| `tokenGated` | Requester must prove they hold a specific token (checked on-chain) |
| `ownerOnly` | Only the original publisher can re-access (default) |

## Verification

When Agent A receives private triples, it can verify them using the
`privateMerkleRoot` that was anchored in the public triples:

1. Look up the synthetic triple: `<urn:dkg:kc> dkg:privateContentRoot "0x..."`
2. Hash the received private triples using the same algorithm
3. Compare the computed root with the anchored root
4. If they match, the private data is authentic and unmodified
