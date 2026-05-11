# Mode <X> transcript: <one-line summary>

> Spec reference: RFC §4(<x>) / §9.5(<x>). Captured on devnet
> commit `<git rev>` against contracts at
> `<localhost_contracts.json hash>`.

## Setup

| Actor | Address | Identity ID | Role |
|---|---|---|---|
| Edge agent | `0x...` | n/a | EOA the agent signs author attestations with |
| Edge publisher | `0x...` | n/a | EOA that submits the on-chain tx (`msg.sender`) |
| Core <N> | `0x...` | `<id>` | Claimed publishing-factor target |
| Core <N> PCA | `0x...` | n/a | Conviction account, if mode requires |

Mode-specific fixtures applied (PCAs created, authorizedKeys
added, etc.):

```text
<paste pca-create / authorize tx hashes>
```

## Action

```text
$ NODE_DIR=.devnet/node5 ./scripts/dkg publish <cgId> \
    --file devnet/agent-provenance/turns/turn-<x>.nq \
    --publisher-node-identity-id <core_id>

<paste full stdout/stderr — should include the daemon log line:
"On-chain confirmed: UAL=... batchId=N tx=0x...">
```

KC ID minted: `<batchId>`
TX hash: `<0x...>`
Block number: `<N>`

## Assertions

### A1. on-chain author = agent EOA

```text
$ cast call <KCS> 'getLatestMerkleRootAuthor(uint256)(address)' <kcId>
0x<edge_agent_address>
```

PASS / FAIL.

### A2. on-chain publisher = msg.sender

```text
$ cast call <KCS> 'getLatestMerkleRootPublisher(uint256)(address)' <kcId>
0x<edge_publisher_address>
```

PASS / FAIL.

### A3. KnowledgeCollectionCreated event carries indexed author

```text
$ cast logs --rpc-url http://127.0.0.1:8545 \
   --address <KCS> --from-block <N> --to-block <N> \
   'KnowledgeCollectionCreated(uint256,address,...)'

<paste — confirm topic[2] == 0x000...0<edge_agent_address>>
```

PASS / FAIL.

### A4. publishing-factor / PCA accounting

Mode-specific. Delete and replace per the per-mode assertions in
the runbook.

For modes (a)/(b):
```text
$ cast call <PCA> 'epochAllowance(uint72,uint256)(uint96)' <core_id> <epoch>
<old> → <new>     # decremented by ~discounted fee
```

For mode (c):
```text
<core_id>'s publishing-factor counter:  <old> → <old+1>
PCA epochAllowance:                     unchanged
```

For mode (d):
```text
no core's publishing-factor counter incremented
```

### A5. /api/kc/<kcId>/author

```text
$ curl -s http://127.0.0.1:9201/api/kc/<kcId>/author -H "Authorization: Bearer $(cat .devnet/node1/auth.token)"
{"kcId":"<kcId>","author":"0x<edge_agent_address>","attested":true}
```

PASS / FAIL.

### A6. dkg:Publication triple in CG meta

```text
$ NODE_DIR=.devnet/node1 ./scripts/dkg query "
  SELECT ?author WHERE {
    GRAPH <did:dkg:context-graph:<cgId>/_meta> {
      <urn:dkg:kc:<kcId>> <https://dkg.network/ontology#authoredBy> ?author .
    }
  }
"

<paste — confirm ?author = "0x<edge_agent_address>">
```

PASS / FAIL.

## Verdict

PASS — all assertions green.
or
FAIL — assertion <ID> failed; details: …

---

Captured by: `<operator>`
Date: `<YYYY-MM-DD>`
Git rev: `<rev>`
