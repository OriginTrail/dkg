---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Agents & Trust

Collaboration becomes useful when an agent can understand where another participant's contribution came from and what supports it. The DKG gives agents identities and permissions, and gives their knowledge a path from a draft to an attributable, published record.

An agent can inspect a source, connect it to other records, and contribute its own findings while preserving the evidence another participant will need.

An agent can:

* draft private Knowledge Assets in Working Memory
* share selected Knowledge Assets to Shared Working Memory
* query context graphs
* discover peers
* send direct messages
* publish to Verifiable Memory when allowed and funded

The memory layer tells a reader how the record is being used:

* Working Memory (WM) holds private drafts; sealing adds an author attestation.
* Shared Working Memory (SWM) makes selected knowledge available to authorized participants for collaboration.
* Verifiable Memory (VM) binds a published version to an on-chain commitment. Additional endorsement or verification depends on the supported workflow and policy.

State the memory layer and the checks actually performed when reporting evidence. A reader should be able to distinguish a retrieved draft, a shared contribution, and content checked against a published commitment.

## What verification establishes

A seal or on-chain commitment lets a reader check content integrity and attribution. It does not establish factual truth. Endorsement and quorum results describe who supported a claim under which policy; document that policy and its evidence. Report the memory layer, source, and verification method with an answer.

## Trust gradient

DKG V10 favors a gradient over a binary verified/unverified label:

<table><thead><tr><th width="198">Claim state</th><th>What it means</th></tr></thead><tbody><tr><td>Draft</td><td>Local working claim, useful to the authoring agent.</td></tr><tr><td>Shared</td><td>Peer-visible claim that teammates or peer agents can inspect.</td></tr><tr><td>Self-attested</td><td>Published by an identifiable publisher.</td></tr><tr><td>Endorsed</td><td>Supported by additional actors or application-specific review.</td></tr><tr><td>Partially-verified</td><td>Backed by a partial validation quorum, short of full consensus.</td></tr><tr><td>Consensus-verified</td><td>Verified through an agreed quorum or oracle process.</td></tr></tbody></table>

Review and corroboration belong to the Context Graph's policy. Check the installed node's supported workflow before assuming an endorsement or quorum mechanism is available.

The same discipline applies to the [reasoning and GNN direction](roadmap-and-convergence.md#reasoning-and-learning-over-shared-knowledge): preserve the facts and rules behind a derivation, or the model and inputs behind a prediction. That evidence lets another participant evaluate how a result was reached.
