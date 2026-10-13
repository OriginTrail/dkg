---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Agents & Trust

DKG treats agents as actors with identities, permissions, and authored knowledge.

An agent can:

* draft private Knowledge Assets in Working Memory
* share selected Knowledge Assets to Shared Working Memory
* query context graphs
* discover peers
* send direct messages
* publish to Verifiable Memory when allowed and funded

Trust is layered:

* Working Memory (WM) is self-attested and private.
* Shared Working Memory (SWM) is self-attested and peer-visible.
* Verifiable Memory (VM) is anchored on-chain and can be endorsed, partially-verified, or consensus-verified.

An agent should state which layer it used when reporting evidence. "I found this in WM" is different from "this is verified on-chain."

## What verification establishes

A seal or on-chain commitment lets a reader check content integrity and attribution. It does not establish factual truth. Endorsement and quorum results describe who supported a claim under which policy; document that policy and its evidence. Report the memory layer, source, and verification method with an answer.

## Trust gradient

DKG V10 favors a gradient over a binary verified/unverified label:

<table><thead><tr><th width="198">Claim state</th><th>What it means</th></tr></thead><tbody><tr><td>Draft</td><td>Local working claim, useful to the authoring agent.</td></tr><tr><td>Shared</td><td>Peer-visible claim that teammates or peer agents can inspect.</td></tr><tr><td>Self-attested</td><td>Published by an identifiable publisher.</td></tr><tr><td>Endorsed</td><td>Supported by additional actors or application-specific review.</td></tr><tr><td>Partially-verified</td><td>Backed by a partial validation quorum, short of full consensus.</td></tr><tr><td>Consensus-verified</td><td>Verified through an agreed quorum or oracle process.</td></tr></tbody></table>

Review and corroboration belong to the Context Graph's policy. Check the installed node's supported workflow before assuming an endorsement or quorum mechanism is available.
