---
icon: sack-dollar
---

# DKG V10 Bounty Program

<figure><img src="../.gitbook/assets/dkg-memory-hr.png" alt=""><figcaption></figcaption></figure>

## Round 1 — Call for Integrations

<table data-header-hidden><thead><tr><th width="199"></th><th></th></tr></thead><tbody><tr><td>Theme</td><td><a href="https://github.com/OriginTrail/dkg">DKG v10</a> Working Memory &#x26; Shared Memory × <a href="https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f">LLM-Wiki</a> / <a href="https://github.com/karpathy/autoresearch">Autoresearch</a> agents</td></tr><tr><td>Total bounty pool</td><td>Total of 150,000 $TRAC for 3 rounds, up to 10,000 $TRAC per accepted contribution capped at 50,000 $TRAC in round 1</td></tr><tr><td>Status</td><td>Open</td></tr><tr><td>Issued by</td><td><a href="https://origintrail.io">OriginTrail</a></td></tr></tbody></table>

### 1. Summary

[OriginTrail](https://origintrail.io) is opening the first round of the DKG v10 integrations bounty. This round is narrowly scoped to integrations that bring **Working Memory** and **Shared Memory** — the two pre-verification layers of the v10 memory model — into tools that advance Andrej Karpathy's vision of the **LLM Wiki** and **autoresearch**: collaborative, agent-native knowledge substrates where retrieval, writing, and verification collapse into a single loop.

We are especially interested in integrations with **OpenClaw, Hermes**, and agents of comparable shape — autonomous or semi-autonomous research agents operating over long-horizon tasks and producing knowledge artifacts that benefit from provenance, collaboration, and eventual on-chain verification.

The best contributions will be listed in the official DKG v10 integrations registry, featured across OriginTrail's documentation and ecosystem surfaces, and **rewarded with up to 10,000 TRAC per accepted submission**, tiered by impact — see sections 10 and 11. Integrations live in contributor-owned repositories and are consumed by users through the registry; this round does not merge contributor code into the dkg monorepo.

This call is the first of **three planned rounds**. Round 1 focuses on Working and Shared Memory. Round 2 will target Verified Memory and context oracles. Round 3 will target agent-ready analytics and user support. See section 12 for the full roadmap.

### 2. Why now

AI is shifting from single agents to **multi-agent systems**. Teams of models are doing research, writing code, running operations, and producing knowledge faster than any single agent could.

The bottleneck is no longer the model. **The bottleneck is memory** — specifically, a shared memory substrate that multiple agents can read, write, contest, and verify over time. Closed labs are racing to build this as proprietary infrastructure inside their own products. The market is heading toward a world where every major AI platform ships its own walled-garden memory layer, and the knowledge produced within each one is trapped there.

An open, verifiable, agent-native alternative does not yet exist at a production scale. The DKG is the closest thing to it — a public knowledge substrate with provenance, trust gradients, and on-chain anchoring already wired in. v10 is the release that makes it usable for agents.

{% hint style="info" %}
**This is the moment to define the memory layer of AI**, before the closed alternatives harden into defaults. Round 1 of the DKG v10 bounty program is where builders who want that layer to be open can ship the integrations that will shape it.
{% endhint %}

### 3. Why this round

The v10 memory model is built around a trust gradient: drafts mature from **Working Memory** (private, agent-populated) through **Shared Memory** (team-gossiped, collaborative) to **Verified Memory** (chain-anchored, with self-attested → endorsed → consensus-verified gradations).

Rounds on Verified Memory will follow. This first round deliberately targets the **pre-verification surface** — the layers where agents draft, iterate, and collaborate — because that is where LLM-Wiki / autoresearch workflows live most of the time. A good research agent spends the bulk of its life drafting and revising; only a small tail of its output ever needs consensus verification.

Karpathy's framing of the [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — a knowledge substrate natively legible to language models, continuously curated by a mixture of humans and agents — maps almost directly onto the v10 three-layer model. This round is the first concrete step toward making that substrate real.

### 4. Build this

If you are unsure what to build, start from one of these. They are concrete, buildable inside a round, and each one plugs DKG memory into a workflow real users already have.

#### Illustrative suggestions

* **ChatGPT / Claude plugin or MCP server that writes to Working Memory.** Every drafted artifact — chat, research note, code analysis — is deposited into the author's Working Memory with provenance and an agent-assigned status tag. Turns any conversation into durable, attributable knowledge.
* **Slack threads → Shared Memory.** An agent that watches a channel, identifies substantive exchanges (not chitchat), and promotes them into Shared Memory and team Context Graph membership.
* **DKG as a memory backend for an existing RAG pipeline.** Swap a team's vector-store-plus-prompt retrieval loop for a DKG-backed one. Agents get provenance and promotion paths for free, and downstream context oracles become consumable without a rewrite.
* **GitHub → Working Memory ingestion.** Every issue, PR, and review comment in a repo flows into the author's Working Memory with code-aware tagging. The engineering knowledge a team generates daily, captured.

#### Other welcome shapes

* An OpenClaw adapter that deposits every drafted artifact into the author's Working Memory, status tags, and provenance.
* A Hermes Agent-style autoresearch loop that uses Shared Memory as its team scratchpad — gossip-replicated, multi-agent-readable, no merge-conflict UI.
* A wiki-style editor (think Roam / Logseq / Obsidian) that syncs bidirectionally with Shared Memory and promotes pages toward verification via the agent conversation surface.
* A citation-resolver that pulls from Shared Memory across a team's Context Graphs and resolves references back to canonical UALs.
* An inbox-style integration — email, arXiv feeds, RSS — that populates Working Memory with incoming items tagged by an agent.
* A SPARQL-backed research assistant that queries across a user's Working + Shared layers and a team paranet in a single cohesive view.

Your own idea is welcome. The list is a starting point, not a constraint.

### 5. In scope

A submission is in scope if it does **both** of the following:

1. Writes to or reads from **Working Memory** or **Shared Memory** on a DKG v10 node through a supported public interface and respecting v10 primitives (UAL, Knowledge Asset, Knowledge Collection, Context Graph, Integration, Curator).
2. Connects that capability to a product, project, or agent advancing the LLM-Wiki / autoresearch direction.

Supported public interfaces for this round are:

* The node HTTP API (authenticated via bearer token)
* The dkg CLI, invoked as a subprocess
* MCP server (for MCP-capable clients such as Cursor, Claude Code, Claude Desktop, and other agent frameworks)

#### Priority integration targets

* **OpenClaw** — the Telegram-based agent build-orchestration environment. Integrations that route OpenClaw artifacts into Working Memory, or expose Shared Memory as a team substrate OpenClaw agents can read and contribute to, are highly valued.
* **Hermes Agent** — or comparable autonomous research agents (long-horizon, tool-using, artifact-producing).
* **Claude Code sub-agents and Agent Teams, Cursor-like IDEs with agent panels, Jupyter / notebook autoresearch kernels, literature-review and research-synthesis agents, RAG / dRAG pipelines** that want a verifiable upstream.

### 6. Out of scope (for this round)

* Integrations that touch _only_ **Verified Memory** or chain-anchoring flows. These are the subject of a later round. Submissions that primarily target Working and Shared Memory but deliberately anticipate promotion to Verified Memory and consumption by context oracles are in scope and, per section 9, scored higher for it.
* UI buttons for endorsement, voting, or social consensus. In v10, these interactions are conversational and happen through the agent panel, not through UI affordances. Submissions reintroducing them will be rejected.
* Publisher-side Conviction / staking UX. Separate track.
* DKG v9-only work. The Situation Room-style v9 applications are valuable but out of scope here; this call is v10-specific.
* Integrations that bypass the Curator authority model on PUBLISH / SHARE operations.

Integrations that import from internal v10 packages (@origintrail-official/dkg-core, -storage, -chain, -publisher, -query, -agent, or any non-public subpath), patch node source, or load code into the node daemon process. These are forks of the node, not integrations in the v10 sense, and carry monorepo-merge obligations this program is not set up to handle. Build against the stable public interfaces listed in Section 5.

### 7. Design principles submissions must honor

Every accepted integration must respect the v10 design principles. These are non-negotiable:

* **Agent-first.** Connecting an agent is the entry point. "Let the agent decide" is the sensible default. Advanced controls live behind Advanced Settings, not on the main surface.
* **Trust gradient, not binary states.** Knowledge matures; it is not simply "unverified" or "verified". Working → Shared → Verified, with self-attested → endorsed → consensus-verified inside Verified.
* **Conversational consensus.** Endorsement and voting occur through agent conversation, not UI buttons.
* **Project-centric layering.** The three memory layers nest inside a project, not the other way around. Integrations should respect this hierarchy.
* **No merge/conflict UI on Shared Memory.** Shared Memory is gossiped, not merged.
* **Terminology discipline.** Use the established v10 vocabulary exactly: Context Graph, Integration, Curator, Entity, Knowledge Asset, Knowledge Collection, SHARE, PUBLISH, Projects (not "Memory Explorer"). Deviations should be justified in the submission.

### 8. Submission requirements

A complete submission includes:

1. **Pull request** against the [OriginTrail/dkg-integrations](https://github.com/OriginTrail/dkg-integrations) repository, adding a single integration entry pinned to a specific commit and published package version of your own repository. Integrations live in contributor-owned repositories and consume the DKG v10 node through the supported public interfaces listed in Section 5. Round 1 awards are paid on registry acceptance; contributor code is not merged into the dkg monorepo. OriginTrail core developers may, at their discretion, later invite flagship integrations into first-party status as a separate conversation with an explicit maintenance handoff
2. **Design brief** (Markdown, 1–3 pages) covering: problem, target user, which memory layer(s) are touched, which v10 primitives are used, how it maps to the LLM-Wiki / autoresearch direction, any terminology choices that deviate from the v10 vocabulary, and an explicit **promotion path** section describing how Working and Shared artefacts mature toward Verified Memory and how the integration's outputs are shaped for downstream consumption by context oracles.
3. **Working demo** — a recorded walk-through or live endpoint. Screenshots alone are insufficient.
4. **Test coverage** proportionate to the surface area touched, and integration tests against a local v10 node.
5. **Security notes** — any credential, write-authority, or data-egress consideration, particularly around Curator authority on PUBLISH / SHARE.
6. **Maintenance commitment** — named maintainer and at least a 6-month support window post-merge.

### ​​8a. Security requirements

Before a registry entry is accepted, the following are verified — most are automated as CI checks on the registry repository:

1. Package is published to npm (or an equivalent verifiable registry) with build provenance (e.g., npm publish --provenance via GitHub Actions).
2. No postinstall or preinstall scripts in the published package, unless explicitly justified and reviewed.
3. License file present and SPDX identifier matches the registry entry.
4. Declared network egress: every external domain the integration contacts beyond the local DKG node is listed in the registry entry.
5. Declared write authority: every DKG endpoint or operation the integration invokes is listed, with any Curator-authority operations (PUBLISH, SHARE) called out explicitly.
6. No dynamic code loading outside the DKG SDK (no eval on remote input, no remote module fetch and execute).
7. npm audit --production clean, or outstanding advisories triaged in the submission.
8. Contributor attestation on the PR: the code is the contributor's own work or properly licensed, and contains no intentional backdoors.
9. For featured-tier submissions, a one-time manual security review of the pinned commit.

### 9. Evaluation criteria

Submissions are scored against the following, roughly in order of weight:

1. **Fit with LLM-Wiki / autoresearch direction.** Does this meaningfully advance agent-native collaborative knowledge work, or is the DKG integration incidental?
2. **Adoption potential.** Will real users use this? Does it plug into an existing workflow people already have? Does it unlock agent behavior that was previously impossible? The strongest submissions ship with a credible first user, not just a theoretical one.
3. **Faithfulness to the v10 memory model.** Correct use of layers, primitives, Curator authority, and terminology.
4. **Forward-compatibility with Verified Memory and context oracles.** Although this round targets the pre-verification layers, the strongest submissions treat Working and Shared Memory as upstream of Verified Memory — not as a terminal destination. Concretely: data structures, provenance, and UAL references should be shaped so that promotion to Verified Memory is a natural next step rather than a rewrite; and the integration should anticipate consumption by context oracles, so that artifacts maturing through the trust gradient become usable as oracle inputs for downstream agents and applications. Submissions that explicitly document their promotion path and oracle-readiness score higher.
5. **Quality of the agent surface.** Agent-first onboarding, sensible defaults, conversational consensus respected.
6. **Engineering quality.** Code clarity, test coverage, deployment story, dependency hygiene (standalone-repo-over-HTTP preferred over monorepo embedding).

Documentation. Design brief, in-repo docs, and onboarding for other contributors.

### 10. Bounty structure

Awards are tiered. The committee assigns a tier based on evaluation score, with a published rationale for each award.

<table data-header-hidden><thead><tr><th width="175.5"></th><th width="205"></th><th></th></tr></thead><tbody><tr><td><strong>Tier</strong></td><td><strong>Award range</strong></td><td><strong>What it signals</strong></td></tr><tr><td><strong>Flagship</strong></td><td>8,000 – 10,000 TRAC + ecosystem spotlight</td><td>Production-grade integration with a clear user base, faithful to the v10 model, strong forward-compatibility with Verified Memory and oracles. Lined up to become a default example in v10 documentation and ecosystem demos.</td></tr><tr><td><strong>High-quality</strong></td><td>3,000 – 7,000 TRAC</td><td>Solid, well-scoped integration that ships a real capability and is maintained. The working core of the ecosystem.</td></tr><tr><td><strong>Experimental / early</strong></td><td>1,000 – 3,000 TRAC</td><td><p>Promising early-stage work — a <strong>fully working</strong> prototype that proves a direction, a partial integration with a credible path to maturity, or a well-executed exploration of an underserved surface.</p><p>Note: Half-completed solutions are not eligible. Your application has to demonstrate a fully working, DKG-relevant capability in the context of the above-listed requirements.</p></td></tr></tbody></table>

* Awards are disbursed upon the merge of the approved pull request.
* Multiple submissions per team are allowed, but each must be substantively distinct.
* Accepted submissions are lined up for merge in the order the committee deems appropriate; queue position does not affect the tier or award.
* TRAC is paid on the network the contributor selects from those supported by v10 at the time of merge (NeuroWeb, Base, Gnosis), subject to the network's availability at the time of disbursement.

### 11. What happens if you win

Accepted integrations don't just get TRAC. They get distribution.

* **Registry listing.** Every accepted integration appears in the official DKG v10 integrations registry, consumed by the node itself (integration discovery and installation flows), and is displayed in the v10 dashboard UI. Being in the registry is how users find and adopt your integration.
* **Documentation.** Flagship and high-quality integrations are featured as default examples in the OriginTrail v10 documentation, developer guides, and agent onboarding flows.
* **Ecosystem demos.** Highlighted in ecosystem demos, community calls, and Trace Alliance Academy materials, where enterprise partners and agent builders are actively looking for reference integrations to adopt.
* **Introductions.** Contributors behind strong integrations are introduced to enterprise partners exploring the DKG for their own stack, and to agent-builder teams looking for memory primitives.
* **Follow-on eligibility.** Rewarded integrations from this round may be eligible for further rounds of the bounty program — in particular, later rounds targeting Verified Memory, context oracles, and Conviction-related UX. Teams that deliver faithful Round 1 work and document a credible promotion path are well-positioned to extend their integration in subsequent rounds. Eligibility is not automatic; each round opens with its own scope and criteria, and prior participation is a signal of fit, not a guarantee of award.

The goal is simple: Round 1 should be a platform entry point, not a one-off payout. Builders who show up here are the ones who define how the layer takes shape.

### 12. Program roadmap — three rounds

This call is the first of three planned rounds. The rounds are sequential: each builds on artifacts and infrastructure matured in the previous one, and scope tightens and layer coverage deepens as the program progresses. Round 2 and Round 3 scope is indicative and subject to refinement at each round's opening.

<figure><img src="../.gitbook/assets/dkg_v10_bounty_program_high_res_white_bg.png" alt=""><figcaption></figcaption></figure>

Figure 1. The three-round progression of the DKG v10 bounty program.

| **Round**                                                                                            | **Focus**                                                        | **Scope**                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <p><strong>Round 1 — Working &#x26; Shared Memory</strong></p><p><em>(open now)</em></p>             | Pre-verification integrations, LLM-Wiki, and autoresearch agents | Working and Shared Memory surfaces; priority integration with OpenClaw, Hermes, and comparable research agents. Up to 10,000 TRAC per accepted submission.                                                    |
| <p><strong>Round 2 — Verified Memory &#x26; context oracles</strong></p><p><em>(planned)</em></p>    | Chain-anchoring, trust-gradient verification, oracle pipelines   | The self-attested → endorsed → consensus-verified gradient; oracle pipelines consuming matured Shared Memory artifacts; Conviction-related UX where relevant. Follow-on eligibility for Round 1 contributors. |
| <p><strong>Round 3 — Agent-ready analytics &#x26; user support</strong></p><p><em>(planned)</em></p> | Agent-legible observability and agent-mediated support           | Analytics surfaces legible to agents rather than only humans; agent-mediated user support spanning the full trust gradient. Builds on verified artifacts and oracle outputs delivered in Round 2.             |

**Why the sequence matters.**

Round 1 seeds the pre-verification substrate with artifacts that have clean provenance and promotion paths.

Round 2 turns that substrate into verified, oracle-consumable knowledge.

Round 3 makes the whole stack usable — both by agents operating over it and by humans who need support navigating it.

Integrations that anticipate this arc from Round 1 onward — see evaluation criterion 4 — are best positioned to extend across multiple rounds.

**What is not committed.** The bounty cap, timeline, and review committee for Rounds 2 and 3 are not set here. They will be specified when each round opens. The Round 1 scope is the binding document for this call.

### 13. Timeline

<table data-header-hidden><thead><tr><th width="223"></th><th></th></tr></thead><tbody><tr><td><strong>Milestone</strong></td><td><strong>Date</strong></td></tr><tr><td>Round opens</td><td>On publication</td></tr><tr><td>First review cut-off</td><td>To be announced on the official channel</td></tr><tr><td>Rolling review thereafter</td><td>Yes</td></tr><tr><td>Round closes</td><td>When the round-one pool is exhausted (50.000 $TRAC, or when Round 2 opens — whichever is earlier</td></tr></tbody></table>

Exact review cut-off dates are announced on the official OriginTrail channel on the day, in keeping with the ecosystem's practice of not publishing sensitive timing in advance.

### 14. How to submit

1. Open the pull request against [**OriginTrail/dkg-integrations**](https://github.com/OriginTrail/dkg-integrations)**,** adding a single integration entry for your project pinned to a specific commit and published package version of your own repository.
2. Include all the required resources, including the design brief and demo link, in your repository.
3. Tag the submission cfi-dkgv10-r1.

Questions and early-stage design conversations are encouraged before opening a PR. The OriginTrail community channels are the right place for those.

### 15. Governance & review

* Submissions are reviewed by a committee drawn from OriginTrail, Trace Labs, and Trace Alliance contributors active on v10.
* Decisions are recorded with reasoning published alongside each accepted, redacted where contributor privacy requires it.
* Award amounts are described as **programmatic bounty disbursements**, not as amounts owed; the committee's decision on fit, quality, tier, and amount is final for the round.
* Conflicts of interest (committee members contributing submissions) are disclosed and recused.

### 16. Notes on conduct and IP

* Submissions must be the contributor's own work or properly licensed with licenses for open source software like MIT, Apache 2.0 etc.
* Contributors retain authorship; merged code is licensed under the v10 repository's standard license.
* The call does not constitute a contract of employment or a promise of future work. It is an open call with programmatic rewards for accepted contributions.
* Each participant accepts the [OriginTrail DKG V10 Terms & Conditions.](../getting-started/dkg-v10-t-c.md)

***

_Issued by OriginTrail d.o.o. For the current official channel and submission thread, see_ [_origintrail.io_](https://origintrail.io)_._
