---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Let two agents use shared knowledge

**Outcome:** Agent B retrieves the Atlas fact that Agent A shared, using a fresh node/tool read. This recipe uses the public tutorial fixture. For confidential data, establish and verify the graph's private membership policy before any share.

## Prerequisites

- Two healthy DKG nodes on the same network, with reachable peers/relays, or two authorized agent clients on one node.
- A supported memory tool connection for each agent.
- Agent A has completed the [quickstart](../getting-started/quickstart.md) through sharing `atlas` and retained the exact Context Graph ID.

Two clients on the same node demonstrate independent retrieval; they do not demonstrate replication between nodes. Record which topology you tested.

## On Agent A's node

```bash
dkg status
dkg peers
dkg context-graph info "$CG"
dkg ka history atlas -c "$CG"
```

Record the exact graph ID and the source node's peer ID from status. A successful share establishes local completion; a consumer still needs discovery, admission, and data availability.

## On Agent B's node

For this open tutorial graph, copy the exact graph ID into B's environment and explicitly subscribe:

```bash
CG='<exact ID from node A>'
dkg subscribe "$CG"
dkg context-graph info "$CG"
dkg sync catchup-status "$CG"
```

Wait for supported catch-up to settle, then query the shared sample:

```bash
dkg query "$CG" --include-shared-memory -q 'SELECT ?project ?database ?source WHERE { GRAPH ?g { ?p <https://schema.org/name> ?project ; <https://example.org/dkg-tutorial/usesDatabase> ?db ; <https://schema.org/citation> ?source . ?db <https://schema.org/name> ?database . } }'
```

Expect the Atlas/Oxigraph/source row. Have Agent B retrieve the same evidence through its tools in a fresh conversation and state that it read SWM. It must not describe the result as on-chain verified.

If the graph is unknown or empty, inspect peer reachability, subscription state, catch-up status, and A's completed share. Check that both nodes use the same network and graph ID. Do not infer that zero rows means the source has no knowledge. [Relays and peers](../use-dkg/relays-and-peers.md).

## Curated or private collaboration

An open subscription is not an invitation to a private graph. The graph's curator manages agent membership and publication authority. Use the installed CLI's `context-graph request-join`, `join-requests`, and `approve-join` flow with the exact graph and curator peer ID, or have the authorized curator add the required agent address. Inspect each command's `--help` before supplying its required identity/signature options.

Prove that the invited agent can read the intended graph and an uninvited agent cannot. Agent addresses, peer IDs, node profiles, and payer wallets are different identifiers. Hosting knowledge does not by itself grant an agent permission to read it.

## Completion

Save the producer's share result and the consumer's query result, node versions, graph ID, and topology. This proves the exercised collaboration path. On-chain publication and quorum verification require their own evidence and are outside this recipe.
