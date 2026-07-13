---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Random Sampling

**Random Sampling** is the DKG's **Proof-of-Knowledge (PoK)** system: the mechanism that continuously verifies Core Nodes are actually storing the knowledge they claim to host, and that drives how network rewards are distributed.

Random Sampling is Core-only. A node must run with `nodeRole: "core"`, have a non-zero on-chain node profile (`identityId`), **and be admitted to the active sharding table** before the prover can bind. A profile by itself is not enough: staking or admission may still be incomplete. While waiting for admission, the node rechecks eligibility in the background, so the prover can start without a daemon restart. See [Core Node Profile Registration](../use-dkg/run-node.md#core-node-profile-registration) for setup and recovery.

## Why it exists

In a decentralized network, data availability can't be assumed — it has to be proven. Core Nodes host and serve Knowledge Assets, and Random Sampling lets the network constantly and randomly challenge them to prove they still hold specific data. The system:

* ensures knowledge remains available over time,
* rewards nodes that are consistently online and serving data, and
* provides a fair, automated way to distribute network rewards.

It is lightweight by design — nodes prove small slices of data rather than the whole graph — so it scales to billions of Knowledge Assets.

## How it works (high level)

1. **Challenge** — at the start of each *proof period*, an on-chain contract randomly selects a chunk of a Knowledge Collection for each Core Node to prove.
2. **Proof** — the node computes a Merkle proof for that chunk and submits it on-chain, where the contract verifies it.
3. **Score** — valid proofs accumulate into a node's score over each *epoch* (a longer reward cycle), reflecting uptime and the knowledge it serves.
4. **Rewards** — at the end of the epoch, rewards are distributed based on those scores.

Time is coordinated by two on-chain layers: **epochs** (long reward cycles) and **proof periods** (short, frequent challenge windows within each epoch).

## In V10

Random Sampling remains the core availability-proof system in V10. Staking and rewards are governed by the V10 **conviction** model — see [Conviction & Economics](../how-dkg-works/conviction-and-economics.md) for how staking, publishing, and rewards fit together.
