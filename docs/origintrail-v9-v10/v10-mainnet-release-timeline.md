---
status: historical
version: v10
audience: human
doc_type: historical
---

# V10 Mainnet Release Timeline

{% hint style="warning" %}
**Historical launch plan.** The April 2026 dates and prospective instructions below are retained for context and are not current operational guidance. See [Networks & RPCs](../general/networks.md) for current availability and [GitHub Releases](https://github.com/OriginTrail/dkg/releases) for shipped versions.
{% endhint %}

<table data-header-hidden><thead><tr><th width="146"></th><th width="169.5"></th><th></th></tr></thead><tbody><tr><td><strong>Milestone</strong></td><td><strong>Date (indicative)</strong></td><td><strong>Key Output</strong></td></tr><tr><td>V10 Release Candidate out</td><td>8 April 2026</td><td>V10rc testnet releases. Smart contracts finalised (implementation, tests, internal security review). V10 protocol core implementation confirmed. New node UI implemented.</td></tr><tr><td>Epoch snapshot</td><td>9 April 2026 00:00:01 UTC</td><td>Current epoch ends. Mainnet snapshot executed — V8 publishing allocation frozen at epoch boundary. Defines each publisher's TRAC balance eligible for V10 conviction migration.</td></tr><tr><td>Updating V8 publishing allocation to V10 Publisher Conviction</td><td>10 April 2026</td><td><p>Tokens sent to publisher wallets so they can republish under the V10 conviction system once V10 launches. Publishers have time to bridge to networks of their choice.</p><p>Node runners have 1 week to get ready to update.</p><p>Stakers prepare to potentially re-delegate ahead of V10 release. V10.0 Mainnet release scheduled for the following week.</p></td></tr><tr><td>New Conviction System Staking UI</td><td>15–17 April 2026</td><td>New Staking UI live, now including conviction staking. Exact release time communicated only via the official channel on the day of release — not published in advance to reduce potential attack vectors.</td></tr><tr><td>V10 Mainnet launch window</td><td>15–17 April 2026</td><td><p>DKG V10 deployed on all networks (NeuroWeb, Base, Gnosis). Publishers and node runners choose which network to operate on. Publishing factor resets to new V10 system (breaking change).</p><p>Publishers create publishing conviction accounts and allocate their TRAC on their network of choice.</p><p>Stakers use the new Staking UI to upgrade their staking positions to V10 conviction.</p></td></tr><tr><td>Ongoing V10 updates &#x26; bounty release</td><td>20 April onwards</td><td>Rolling V10 updates across all integrated networks. Bounty programme releases, with rewards for ecosystem builders and developers actively growing the V10 network, including bug bounty.</td></tr></tbody></table>

### Publisher Conviction — How It Works in DKG V1

[The V10 roadmap ](https://docs.origintrail.io/origintrail-v9-v10/roadmap)specifies Publisher Conviction in precise operational terms: publishers commit a sum of TRAC in advance for 12 months of DKG usage. The committed TRAC converts into a pre-purchased allowance for publishing, updating, and querying Knowledge Assets on the publisher's chosen network — Base, Gnosis, or NeuroWeb. The conviction signal is binary: you are in for 12 months, or you are not. The variable is the amount of TRAC committed.

* **Discount tiers:** Six tiers from 10% discount (25,000 TRAC committed) to 75% discount (1,000,000+ TRAC committed). The DKG's conviction economics are benchmarked against comparable infrastructure commitment models, designed to make multi-year knowledge publishing financially attractive relative to pay-as-you-go alternatives.
* **Epoch flow-through:** TRAC committed by publishers is distributed to staker rewards each epoch even if publishers do not use their full allowance in a given epoch. There is no dead capital in a conviction position — committed TRAC always flows to the network.
* **ERC-721 Conviction NFTs:** Each conviction position is minted as an ERC-721 NFT encoding the principal, lock duration, discount tier, and expiry. Conviction NFTs are composable and fractionalisable — they can be held, transferred, traded, or used as building blocks in DeFi. Publishers who wish to exit a position before term can do so via secondary market transfer of the NFT.

Network-level commitment: Conviction is a commitment to the DKG network as a whole, not to a specific node. Node selection and delegation remain separate concerns. The design intent: disproportionately reward long-term alignment with network growth while preserving accessible entry points at every level of commitment.

#### The V8 → V10 Publisher TRAC Migration

To republish existing knowledge to the V10 network, each publisher brings their accrued V8 publishing TRAC — TRAC committed but not yet emitted as staking rewards — to DKG V10, choosing their preferred network (NeuroWeb, Base, or Gnosis).

This TRAC is committed under the V10 Publisher Conviction mechanism and emits programmatically to stakers over up to 2 years, made possible by the V10 conviction emission model entering into force at launch. Publishers add additional TRAC to their accounts for publishing new knowledge.

The result: useful publisher knowledge is migrated to V10. Stakers receive the same total TRAC for published knowledge from the V8 period, but 3 years earlier in net terms. Publishers enter V10 already in conviction positions with discount tier access.

{% hint style="info" %}
**In Plain Terms for Stakers**

Under DKG V8, the TRAC publishers committed for publishing is programmatically emitted to stakers over up to 5 years. Under V10, that same TRAC is brought by publishers under the Publisher Conviction mechanism and emitted programmatically over up to 2 years. The total amount does not change — only the schedule does — meaning stakers receive it 3 years faster in net terms.

Stakers are not required to take any action to receive V10 publisher conviction rewards. If you are staked on a V10-active node, publisher conviction TRAC will flow to you each epoch automatically, starting from the V10 mainnet launch.

The updated Staking UI gives you the option to boost your rewards further by locking your own staking position under conviction multipliers. Learn more about the Delegated Staker Conviction mechanism [here.](https://docs.origintrail.io/origintrail-v9-v10/roadmap)
{% endhint %}

### Release Timeline

The following sections detail what happens, when, and what each participant group — publishers and publishing node runners, stakers, and node runners — needs to do at each stage of the V10 launch.

{% stepper %}
{% step %}
### 6–10 April - Release Candidate & V8 Allocation Update

**What Publishers and Publishing Node Runners Should Do**

* Review the official V10 documentation — it specifies the exact conviction parameters, discount tiers, and emission schedule that will govern your V10 position.
* Review your V8 TRAC balance as of the epoch snapshot on 9 April. This is the amount you can commit to a V10 Publisher Conviction position.
* Decide your conviction tier: the amount of TRAC you commit determines your discount (10% at 25,000 TRAC up to 75% at 1,000,000+ TRAC).
* Choose your network: NeuroWeb, Base, or Gnosis are all supported. Your conviction position is network-specific.
* Prepare your V10 publishing wallets for the creation of conviction accounts on your chosen network.
* Your V8 nodes will remain operational, but after V10 launches you will need to deploy new V10 nodes to resume knowledge creation.

**What Node Runners Should Do**

* Review the V10 node release notes that accompany the Release Candidate published on 8 April.
* Prepare to deploy V10 nodes as fresh deployments — V10 nodes are not upgraded in-place from V8. The publishing factor resets to the new V10 system at launch.
* Consider testing the V10 release candidate on testnet to prepare for the migration.
* Plan for publishers to republish to your V10 node. All publishing on V10 starts from a clean state regardless of V8 history.

**What Stakers Should Do**

* No immediate action is required this week — staking features continue normally on V8.
* Review the official V10 documentation to understand the new Conviction System Staking UI, launching between 15 and 17 April. Exact timing will be announced on the official channel on the day of release.
* Prepare to potentially re-delegate under V10 conviction. The new staking model offers multipliers (1x to 6x) based on lock period — consider which tier suits your preference.
{% endstep %}

{% step %}
### 13–17 April - V10 Mainnet Launch & New Conviction System Staking UI

This is the launch week. The new Conviction System Staking UI goes live between 15 and 17 April — exact timing communicated on the official channel on the day to avoid providing potential attackers with advance information. V10 Mainnet launches in the same window across all networks: NeuroWeb, Base, and Gnosis. Publishers and node runners choose which network to operate on.

**What Publishers and Publishing Node Runners Should Do**

* Create your V10 Publishing Conviction account on your chosen network once mainnet is live. Allocate your V8 TRAC snapshot balance plus any additional TRAC you wish to commit to your conviction position.
* Your conviction position is minted as an ERC-721 NFT. Verify it appears in your wallet and matches your intended principal, discount tier, and expiry.
* Begin republishing your Knowledge Assets to V10 nodes. V10 is a fresh start — your V8 Knowledge Assets do not automatically migrate. Republish the knowledge you wish to carry forward at the discounted rate your conviction tier provides.
* Your conviction TRAC begins flowing to staker rewards from the first epoch after you create your position — regardless of whether you have actively published anything yet.
* Deploy your V10 DKG nodes after V10 lands on mainnet — V10 nodes are deployed fresh, not upgraded from V8. Your node's publishing factor resets to zero at launch. Attracting active publishers to republish through your node is the primary way to build publishing factor quickly.

**What Stakers Should Do**

* Access the new Conviction System Staking UI when it goes live. Review your V8 staking position and convert to V10 conviction staking if you wish to access reward multipliers.
* Conviction staking on V10 offers five lock tiers: no lockup (1x multiplier), 1 month (1.5x), 3 months (2x), 6 months (3.5x), and 12 months (6x). Choose the tier that reflects your intended commitment.
* Conversion is opt-in — V8 staking positions continue to receive base rewards without the V10 conviction multiplier. You can convert at any time after launch.
* Publisher conviction positions begin emitting TRAC to staker rewards from epoch one of V10. If you are already staked on a V10-active node, you will begin receiving rewards without any additional action.
{% endstep %}

{% step %}
### 20 April onward - Ongoing V10 Updates & Bounty Release

Following the V10 Mainnet launch, the development cadence continues with ongoing V10 updates and the launch of the ecosystem bounty programme. These updates address post-launch optimisations, additional features, and any issues identified during the initial launch period.

* Ongoing V10 updates will be communicated via the standard OriginTrail developer channels and documented in the DKG release notes. Node runners with auto-update enabled will receive patches automatically — it is recommended to review each update's release notes regardless.
* The bounty programme releases alongside V10 updates. Eligible activities, reward amounts, and submission requirements will be published in the official programme documentation. Publishers and developers actively building on V10 from day one are best positioned to qualify.
* Publisher conviction positions remain active and unaffected by V10 updates — no re-commitment is required. Conviction TRAC continues to emit to staker rewards each epoch throughout the update period.
{% endstep %}
{% endstepper %}
