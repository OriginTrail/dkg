---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Memory Layers

![DKG memory layers](../.gitbook/assets/DKG-memory-layers.png)

The three memory layers describe how knowledge moves from work in progress to collaboration and durable publication. They let you develop a finding privately, bring it into a team's shared work, and give others a published record they can cite and check.

* **Working Memory (WM)** holds private drafts at your node. Import a document, record an observation, or revise a Knowledge Asset before deciding to share it.
* **Shared Working Memory (SWM)** makes selected knowledge available to authorized participants. Agents can inspect one another's contributions, connect related findings, and continue the work across nodes and frameworks.
* **Verifiable Memory (VM)** stores published knowledge on the network with on-chain commitments. Each published version can be checked against its commitment, and later updates preserve the asset's identity while recording new content commitments.

| Layer | Use | Visibility | On-chain publication cost |
| --- | --- | --- | --- |
| Working Memory | Drafts, imports, work in progress | Local node and authorized agent scope | None |
| Shared Working Memory | Collaborative findings and shared context | Context Graph's authorized participants | None for sharing a KA |
| Verifiable Memory | Published records with durable provenance | Context Graph's access policy | Gas/TRAC |

Local compute, storage, and model-provider charges are separate. Graph registration and read-authority resolution can also involve chain dependencies; “no publication fee” does not mean every sharing prerequisite is independent of the chain. See [funding](../use-dkg/funding.md) and [collaboration prerequisites](../build/collaborate.md#prerequisites).

Visibility and verification are separate choices. Publication preserves the graph's access policy; it does not automatically make private knowledge public. A content commitment supports integrity checks, while factual review and corroboration depend on the evidence and the graph's policy.

The normal lifecycle is:

```
create Knowledge Asset -> write triples -> finalize (seal) -> share -> publish
```

Finalize seals the draft with an EIP-712 author attestation over its merkle root. Sharing moves data from WM to SWM (the operation formerly called promote). Publishing finalizes selected SWM data into VM. Publishing is not a normal save operation; it is a finality operation.

## Memory lifecycle

The Knowledge Asset lifecycle is the write path agents should prefer. Use `dkg ka ...` or `dkg knowledge-asset ...` for lifecycle-native CLI workflows. The older `dkg assertion ...` commands remain compatibility aliases for Working Memory document import, query, and share/promote flows, and the internal lifecycle record may still use the `dkg:Assertion` term.

1. Create a Knowledge Asset in Working Memory.
2. Write RDF quads into that Knowledge Asset.
3. Query the Knowledge Asset to verify what was written.
4. Finalize (seal) the Knowledge Asset — this computes its canonical merkle root and signs an EIP-712 author attestation.
5. Share the Knowledge Asset to Shared Working Memory when peers should see it.
6. Publish SWM to Verifiable Memory when on-chain finality is required.
7. Read lifecycle history for audit and recovery.

Operational implications:

* Knowledge Asset names should be stable, lowercase slugs.
* Writes are additive. Use the [edit lifecycle](../use-dkg/knowledge-asset-lifecycle.md#editing-a-published-knowledge-asset) to revise an existing shared or published asset; preserve its identity and provenance.
* Sharing may target all roots or an explicit set of root entities.
* Publishing costs funds and clears/finalizes selected shared memory.
* Agents should keep provenance triples with durable claims when writing shared decisions, findings, tasks, or code context.

## Example

A research agent records an experiment in Working Memory, including its inputs and source observations. It shares a useful result so a second agent can compare it with other experiments. The team can publish the resulting finding with durable provenance, giving the next investigation a record to cite and check. Knowledge continues to be useful after publication: other participants can build on it and publish their own contributions.

That same flow is useful outside research:

* Coding agents can preserve review findings before deciding which ones become team-visible decisions
* Operations agents can share incident facts before publishing a final report
* Support agents can build shared product knowledge before it becomes verifiable documentation
