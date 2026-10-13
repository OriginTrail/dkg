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
3. On the consumer, establish membership/permission and subscribe when authorized. A graph catalogue entry is not an active subscription. For a curated/private graph, use the supported curator/join flow; do not fall back to a public graph after an access failure.
4. Inspect peer reachability and catch-up. Read the content using the consumer's own credentials and current tool result.
5. Return the answer with its source and SWM layer. If it has only been shared, do not label it on-chain verified.

**Done:** retain producer operation evidence and consumer query evidence, node versions, topology, and graph ID. For Atlas, the consumer must retrieve the Atlas/Oxigraph/source relationship itself.

**Recover:** distinguish missing membership, inactive subscription, wrong network/ID, unavailable peer, and incomplete sync. Empty results alone do not identify the cause. For a confidentiality-sensitive integration, also verify that an uninvited identity is denied before treating its access boundary as tested.
