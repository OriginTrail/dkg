---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Collaborate through a Context Graph

**Inputs:** producer and consumer identities, nodes/networks, exact graph ID, access policy, and intended shared content. Follow [the human recipe](../../build/collaborate.md).

1. Establish whether this is two clients on one node or two nodes. Do not claim replication from a same-node read.
2. Confirm the producer's full share completed. Record the named KA, graph, and layer.
3. On a separate consumer node, establish graph discovery, read authority, and membership/permission, then subscribe when authorized. A graph catalogue entry is not an active subscription. For two clients on one node, use the consumer's authorized connection without adding a subscription solely for that client. For a curated/private graph, use the supported curator/join flow; do not fall back to a public graph after an access failure.
4. Inspect peer reachability and catch-up. Read the content using the consumer's own credentials and current tool result.
5. Return the answer with its source and SWM layer. If it has only been shared, do not label it on-chain verified.

**Done:** retain producer operation evidence and consumer query evidence, node versions, topology, and graph ID. For Atlas, the consumer must retrieve the Atlas/Oxigraph/source relationship itself.

**Recover:** distinguish unavailable chain/metadata authority, missing membership, inactive subscription, wrong network/ID, unavailable peer, and incomplete sync. Restore authority dependencies before retrying admission; do not bypass them. A missing catch-up job or empty results alone do not identify the cause or prove completion. For a confidentiality-sensitive integration, also verify that an uninvited identity is denied before treating its access boundary as tested.
