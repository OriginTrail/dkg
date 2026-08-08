---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Memory Layers

![DKG memory layers](../.gitbook/assets/DKG-memory-layers.png)

DKG V10 separates memory by scope and trust into three memory layers. Every piece of knowledge starts private and can be promoted toward verification as it matures.

* **Working Memory (WM)** — _Private, local, free._ Your agent's scratchpad. Write drafts, ingest documents, stage knowledge before sharing it. Nothing leaves your node. No gas, no cost, no coordination overhead. This is where all knowledge starts.
* **Shared Working Memory (SWM)** — _Collaborative, gossip-replicated, no chain required._ Selectively share knowledge with specific peers — other agents, teammates, or nodes — without publishing to a blockchain. Multiple agents can read from and write to the same Context Graph. This is where collective intelligence happens before anything needs to be verified.
* **Verifiable Memory (VM)** — _**Blockchain-anchored, cryptographically provable.**_ Promote knowledge that needs a durable, independently verifiable record. Each published version is bound to an on-chain commitment; later updates create an auditable new committed state instead of silently rewriting history. Query access follows the Context Graph's policy. Trust level is explicit: self-attested, endorsed, partially verified, or consensus verified.

<table><thead><tr><th width="168">Layer</th><th width="228">Scope</th><th width="106">Cost</th><th>Use</th></tr></thead><tbody><tr><td>Working Memory (WM)</td><td>Private to an agent/node</td><td>Free</td><td>Drafts, session notes, local imports.</td></tr><tr><td>Shared Working Memory (SWM)</td><td>Visible to allowed peers</td><td>Free</td><td>Team-visible findings and shared context.</td></tr><tr><td>Verifiable Memory (VM)</td><td>On-chain anchored</td><td>Gas/TRAC</td><td>Durable final records and verifiable Knowledge Assets.</td></tr></tbody></table>

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
* Writes are additive; discard and recreate if a stable Knowledge Asset needs replacement.
* Sharing may target all roots or an explicit set of root entities.
* Publishing costs funds and clears/finalizes selected shared memory.
* Agents should keep provenance triples with durable claims when writing shared decisions, findings, tasks, or code context.

## Example

An autoresearch agent may write every experiment note to Working Memory. When the result is useful to the team, it shares the Knowledge Asset to Shared Working Memory so peer agents can query it. When trusted verifiers reproduce the result, and the team wants durable provenance, the selected graph data can be published to Verifiable Memory.

That same flow is useful outside research:

* Coding agents can preserve review findings before deciding which ones become team-visible decisions
* Operations agents can share incident facts before publishing a final report
* Support agents can build shared product knowledge before it becomes verifiable documentation
