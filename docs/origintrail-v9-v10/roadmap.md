---
status: historical
version: v9-v10
audience: human
doc_type: historical
description: >-
  Multi-Agent Memory  ·  DePIN  ·  Truth-Seeking Algorithms  ·  Conviction
  Mechanisms
---

# Roadmap

{% hint style="warning" %}
**Historical pre-launch roadmap.** The dates, four-week plan, and prospective availability below are retained for context and are not current operational guidance. See [Networks & RPCs](../general/networks.md) for current availability and [GitHub Releases](https://github.com/OriginTrail/dkg/releases) for shipped versions.
{% endhint %}

## Metcalfe Convergence Phase

### 1. Why Now: Matching the Velocity of Agentic AI

Agentic systems are entering production at a pace that will define infrastructure lock-in for the next decade. The unsolved problem at the frontier is no longer model capability, but rather how collaborating agents share and verify the knowledge they’ve learned.

{% hint style="info" %}
**KARPATHY’S AUTORESEARCH: THE PROBLEM THE DKG SOLVES**

Andrej Karpathy [described the next frontier:](https://x.com/BranaRakic/status/2035467180431593939?s=20) thousands of autonomous agents collaborating across the internet on the same research problem, running parallel experiments where each commit builds on the last. His AutoResearch system ran 700 experiments in 2 days on a single GPU, discovering 20 optimizations autonomously. His vision: "a swarm of agents on the internet could collaborate to improve LLMs and could potentially even run circles around Frontier Labs."

But Karpathy identified the critical unsolved problem: **how do you coordinate an untrusted pool of workers out there on the internet?** The work is expensive to produce but cheap to verify. The structure looks like a blockchain - instead of blocks you have commits, and the proof of work is doing tons of experimentation to find commits that work. The Earth has a huge amount of untrusted compute. We need systems in place that deal with using that compute with trust.

**This is exactly what context graphs on the DKG do.**
{% endhint %}

{% hint style="info" %}
**DECENTRALIZED KNOWLEDGE GRAPH (DKG): THE TRUST LAYER FOR KEEPING CONTEXT IN AGENT SWARMS**

As Branimir Rakić (OriginTrail CTO) articulated: an auto-research swarm sets up a context graph with a defined set of verifier agents and an M-of-N signature threshold. Untrusted agents run experiments and submit results as Knowledge Assets. For those results to land in the shared context graph, M of the N trusted verifiers must confirm results, then cryptographically co-sign the batch on-chain, attesting that the claimed metrics actually reproduce.

The result is a growing, queryable knowledge graph of verified experimental results that any agent in the swarm can query to decide what to try next - built on a trust layer where untrusted contributors do the heavy lifting and trusted verifiers keep the graph honest.
{% endhint %}

Meanwhile, every major AI company is racing to give AI an improved memory. Anthropic shipped it for Claude, OpenAI built it into ChatGPT, Google wired it into Gemini. But these are siloed, proprietary memory systems. The demos are compelling: an assistant that remembers. The problem: each system creates its own memory silo. No agent can access another’s memory. No memory is verifiable. No memory is ownable by the user. The DKG provides the alternative: **multi-agent memory that is persistent, verifiable, decentralised, controlled by users and shared across any framework.**

The improvements to OriginTrail are not a reaction to advancements by major AI companies - DKG V9 must ship the multi-agent memory layer  to service immediate demand signals from industries the DKG is already exposed to, and implicit indications from markets that do not yet use decentralised infrastructure for AI agents.&#x20;

The V9 testnet has validated the core architectural changes: multi-agent memory coordination, autonomous knowledge publishing, conviction mechanism viability, Edge Node + AI agents co-location via the DKG CLI, and enhanced graph structure. With the DKG v9 Testnet progress, **the following 4 week development plan’s objective is to release the full DKG v10 Mainnet:**

| <p><strong>WEEK 1</strong></p><p>NOW</p> | V9 Testnet Hardening - Multi-agent memory, initial swarm simulations.                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| <p><strong>WEEK 2</strong></p><p>W2</p>  | V10 Mainnet Candidate - Deployment & testing of conviction mechanisms, parameters finalised, data monetisation flow.                                |
| <p><strong>WEEK 3</strong></p><p>W3</p>  | V10 Mainnet Candidate - Full feature set: Context Oracles simulation integration, final stress tests, mainnet readiness.                            |
| <p><strong>WEEK 4</strong></p><p>W4</p>  | V10 Mainnet Launch - Conviction mechanisms live. Full DePIN infrastructure: every Edge Node = DKG participant + AI agent host + knowledge endpoint. |

### 2. The Four Pillars of Convergence

<table data-header-hidden><thead><tr><th width="187"></th><th></th><th></th><th></th></tr></thead><tbody><tr><td><p><strong>DePIN Infrastructure</strong></p><p></p><p>Nodes + AI agents on local devices</p></td><td><p><strong>Multi-Agent Memory</strong></p><p></p><p>Collective memory across swarms</p></td><td><p><strong>DKG Apps</strong></p><p></p><p>DKG-grounded swarm intelligence</p></td><td><p><strong>Truth-Seeking Algorithms</strong></p><p></p><p>Monetisation + conviction mechanisms</p></td></tr></tbody></table>

#### 2.1  DePIN: Nodes Co-located with AI Agents

Every DKG node is simultaneously a DePIN infrastructure participant and an AI agent host. Edge Nodes run DKG-enabled trusted AI directly on user devices - laptops, Mac Minis, enterprise systems - preserving privacy while participating in the global knowledge marketplace. Core Nodes form the resilient network backbone, hosting the public replicated DKG. Edge Nodes bring intelligence to the network edge.

* **Local AI agent hosting:** Agents process sensitive data on-device. The Edge Node provides access to both private (local) and public (DKG network) knowledge.
* **DKG CLI:** Single command-line interface for the entire node lifecycle - installation, agent deployment, plugin management, knowledge operations. Fully functional Edge Node with co-located agent in minutes.
* **Fully local dRAG with enhanced privacy:** Decentralised RAG on-device, combining private Edge Node data with public DKG knowledge for hallucination-resistant responses.

#### 2.2  Multi-Agent Memory

The DKG provides persistent, verifiable memory for autonomous agents. Individual agents maintain private memory as knowledge graphs on their DKG Edge Node (ownable, portable, cryptographically verifiable). Agents publish selected knowledge to the public DKG (such as indexing information for private knowledge, or open public knowledge) where it becomes collective swarm memory.

* **AI Agent Workspace:** Collaboration module enabling agents to coordinate and share context in real time without full verifiability of public DKG + on-chain proofs..
* **Context Oracle:** Cryptographically verifiable corroborated multi-agent claims with Knowledge Assets - consensus checks that ground agent outputs in verified knowledge.

The DKG trust layer for keeping context enables V9/V10 agents to autonomously identify knowledge gaps and fill them through neural reasoning - the DKG becomes a self-expanding knowledge organism. Through the DKG CLI and API, agents on any framework share the same memory backbone.

#### 2.3  DKG Apps

**Example 1: OriginTrail Game**

Hello world for the DKG node - an Oregon Trail-inspired game demonstrating multi-node collaboration, serving as the accessible entry point for developers to experience the DKG’s multi-agent capabilities firsthand.



**Example 2: Verifiable Agent-Driven Predictions**

MiroFish-style swarm engines spawn thousands of agents to simulate emergent behaviour for predictions. The DKG transforms these from opaque simulations into verifiable infrastructure: agents ground reasoning in provenance-backed Knowledge Assets, memories persist across simulation runs, every prediction carries a full on-chain provenance trail, and DKG-verified predictions flow into prediction markets with cryptographic proof of methodology integrity.



**Example 3: Trusted Autoresearch**

Andrej Karpathy's autoresearch lets AI agents collaborate on ML experiments - for them to do so at scale the missing piece is trust. Any untrusted agent can run experiments and claim results, but without a verification layer, no other agent can know whether those results actually reproduce. The DKG v9/v10 autoresearch app solves this by wrapping the same experiment loop in a DKG context graph with an M-of-N verification threshold: untrusted agents run experiments and submit results as Knowledge Assets, but those results only land in the shared graph once M of N designated verifier agents cryptographically co-sign the batch on-chain, attesting that the claimed metrics reproduce. The result is a growing, SPARQL-queryable knowledge graph of verified experimental findings that any agent in the swarm can query to decide what to try next — keeping the open, permissionless contribution model of AgentHub while adding the cryptographic trust layer it lacks.

#### 2.4  Truth-Seeking Algorithms: Monetisation + Conviction Mechanisms

For the DKG to achieve self-sustaining growth, the knowledge economy must have native monetisation and aligned long-term incentives. Two conviction mechanisms - publisher conviction (demand-side) and staker conviction (supply-side) - form the economic engine, complemented by external composability with agent payment protocols.

***

### 3. Publisher Conviction

#### 3.1  Mechanism

Publishers commit a sum of TRAC in advance for 12 months of undefined DKG usage. The committed TRAC converts into a pre-purchased allowance for publishing, updating, and querying Knowledge Assets. This allowance depletes with usage and with completion of each epoch. This also means that TRAC emissions pre-comitted get distributed into the network, even if publishers don’t use the allowance to publish anything in any given epoch. &#x20;

If the epoch limit is exhausted (committed TRAC / 12 epochs), the publisher can top up at the current network rate.

* **Fixed term:** Always 12 months. The conviction signal on time is binary - you’re in or you’re not.
* **Variable capital:** The amount committed determines the discount tier.
* **Locked TRAC:** Committed TRAC is locked for the full 12-month term, reducing circulating supply and increasing network security.
* **Credit expiry:** Unused credits “expire” each epoch, but still flow towards staking rewards - ensuring committed capital always benefits the network.

#### 3.2  Discount Tiers

The discount curve is calibrated against industry benchmarks\* for comparable infrastructure commitment models:

| **TRAC Committed** | **Discount** | **Industry Benchmark**                                           |
| ------------------ | ------------ | ---------------------------------------------------------------- |
| 25,000             | 10%          | Comparable to SaaS annual prepay (15–25%)                        |
| 50,000             | 20%          | <p><br></p>                                                      |
| 100,000            | 30%          | Comparable to AWS 1-yr Partial Upfront (\~40%)                   |
| 250,000            | 40%          | Comparable to OpenAI Batch API discount (50%)                    |
| 500,000            | 50%          | Between AWS 1-yr and 3-yr commitments                            |
| 1,000,000+         | 75%          | Comparable to AWS 1-yr All Upfront / EC2 Instance SP (up to 72%) |

**\*Industry benchmarks**

* **AWS Savings Plans:** 1-year commitments offer up to 66–72% off on-demand. These are the discounts publishers compare against when evaluating DKG commitment economics.
* **LLM API pricing:** OpenAI Batch API offers 50% off. Enterprise contracts routinely reach 40–60%. The DKG’s mid-tiers match these benchmarks.

{% hint style="info" %}
**ENTRY TIER MATTERS MOST:** _Converting a pay-as-you-go publisher into a 12-month committed publisher is the highest-leverage decision in the flywheel. The 25K → 10% tier clears lockup friction and gets the publisher contributing to DKG growth for a full year._
{% endhint %}

***

### 4. Delegated Staker Conviction

Conviction Staking introduces a new way to commit to the OriginTrail ecosystem. When staking TRAC, participants choose their principal amount and a lock period - ranging from no lockup at all to a full 12-month commitment. Each tier carries a progressively higher reward multiplier:

| **Lock Period** | **Multiplier** | **Description**                                                        |
| --------------- | -------------- | ---------------------------------------------------------------------- |
| No lockup       | 1x             | Base rewards with full liquidity - withdraw anytime                    |
| 1 month         | 1.5x           | Equivalent to V8’s existing 28-day withdrawal period, now with a boost |
| 3 months        | 2x             | Quarterly commitment - meaningful conviction signal                    |
| 6 months        | 3.5x           | Half-year commitment - strong alignment                                |
| 12 months       | 6x             | Full conviction - maximum alignment with network growth                |

The curve is designed to disproportionately reward long-term alignment with network growth, while preserving accessible entry points at every level of commitment.

#### 4.1  ERC-721 Conviction NFTs (Uniswap V3 Model)

Each conviction stake is minted as an ERC-721 NFT, making your locked position a first-class on-chain asset. The NFT encodes principal, lock duration, multiplier, and expiry - turning what would otherwise be an illiquid lockup into something composable and verifiable.

The design draws direct inspiration from Uniswap V3, which pioneered ERC-721 NFTs to represent unique financial positions. In Uniswap V3, liquidity providers concentrate capital into a specific price range - the tighter the range, the greater the yield. Conviction staking applies the same logic to time: stakers concentrate commitment into a specific lock period - the longer the lock, the higher the multiplier. Where Uniswap V3 rewards precision in price, DKG V9 rewards conviction in time.

* **Network-level conviction:** Unlike traditional delegated staking, conviction is not tied to a specific node. It is a commitment to the DKG network as a whole. Node selection and delegation remain separate concerns.
* **Fractionalisable:** Conviction NFTs support fractionalisation - a single locked position can be split into smaller units, enabling shared staking positions, secondary market liquidity, and collective participation without breaking the underlying lock or forfeiting the multiplier.
* **Composable:** Conviction NFTs can be held, transferred, traded, or used as building blocks in DeFi - bringing the full expressiveness of the NFT ecosystem to staking.

***

### 5. Monetisation: x402 Native Agent Payments

x402 (Coinbase/Google/Visa/Cloudflare) enables autonomous stablecoin micropayments over HTTP. Integrated with the DKG: agents can pay per-query for premium Knowledge Assets, agent-to-agent knowledge commerce operates at protocol level without intermediaries, and the full cycle - knowledge retrieval, swarm simulation, prediction, market trade, settlement - becomes a single autonomous flow.

***

### 6. The Conviction Flywheel

| <p><strong>DEMAND SIDE</strong></p><p></p><ul><li>Publishers commit TRAC for 12 months</li><li>Knowledge Assets created at scale</li><li>DKG becomes more valuable (Metcalfe)</li><li>More agents integrate → more publishers</li></ul> | <p><strong>SUPPLY SIDE</strong></p><p></p><ul><li>Stakers lock TRAC for fixed periods</li><li>Infrastructure secured long-term</li><li>Node stability attracts publishers</li><li>Fee share + boost rewards stakers</li></ul> |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |

{% hint style="info" %}
**RESULT:** Publishers commit TRAC for knowledge growth. Stakers commit TRAC for infrastructure security. Locked TRAC reduces circulating supply. Network stability attracts more publishers and agents. More Knowledge Assets make the DKG more valuable. The flywheel accelerates - driven by the network effects that Metcalfe’s Law predicts from connectivity.
{% endhint %}

{% hint style="info" %}
**WE CONNECT WHAT OTHERS ISOLATE**

The Metcalfe Convergence Phase is the inflection point where the DKG becomes the essential trust layer for the Age of AI. V9 testnet validated. V10 mainnet in 4 weeks. The Convergence is not a distant vision - it is happening now.
{% endhint %}

_The roadmap published on the official OriginTrail website does not yet reflect the pace of the DKG v10 Mainnet rollout. Most of the envisioned features of it however are covered in detail here:_ [_origintrail.io/ecosystem/roadmap_](http://origintrail.io/ecosystem/roadmap)&#x20;
