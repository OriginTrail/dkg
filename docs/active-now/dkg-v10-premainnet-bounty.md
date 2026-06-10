---
icon: bug
---

# OriginTrail DKG V10 Pre-Mainnet Bug Bounty

**Trust the source — including the source code.** _Break the DKG V10 economic contracts before they go live. Open to anyone._

<table data-header-hidden><thead><tr><th width="199"></th><th></th></tr></thead><tbody><tr><td>Theme</td><td>Break the full DKG V10 on-chain contract set (<code>@origintrail-official/dkg-evm-module</code> @ <code>10.0.0-rc.17</code>) deployed as a public pre-mainnet</td></tr><tr><td>Total program value</td><td>300,000 $TRAC — a 200,000 capturable honeypot pool + a 100,000 severity-reward pool</td></tr><tr><td>Honeypot</td><td>Live on Base mainnet with real TRAC — one capped vault (~60,000) + cold reserve, redeployed across captures</td></tr><tr><td>Window</td><td>Phase 1 (Track 1 honeypot): June 10 → June 17, 2026</td></tr><tr><td>Submit</td><td><a href="https://github.com/OriginTrail/dkg/security/advisories/new">GitHub Private Vulnerability Reporting</a> or <a href="mailto:bounty@origin-trail.com">bounty@origin-trail.com</a></td></tr><tr><td>Issued by</td><td><a href="https://origintrail.io">OriginTrail</a></td></tr></tbody></table>

## The program in one line

The final V10 release candidate — the exact contract bytecode intended for mainnet — is deployed as a public **pre-mainnet**, funded with **300,000 TRAC: a 200,000 honeypot pool plus a 100,000 severity-reward pool**. Two tracks: **capture** real TRAC from the honeypot on the value-handling contracts, and **severity rewards for bugs in&#x20;**_**any**_**&#x20;V10 contract**. The honeypot runs as a single isolated, **capped** live vault — redeployed across captures so no single bug can take more than the cap. Anyone can attack it. What survives ships; what doesn't gets fixed first.

## Why

On 29 May 2026, a researcher using Claude Opus 4.8 found a critical, \~4-year-old soundness flaw in Zcash's Orchard pool — one that had passed repeated expert review — in about a day, with a working proof-of-concept. The lesson is plain: frontier AI now finds deep economic bugs faster than traditional review, and that power favors whoever uses it first. On-chain value-handling code launches once and mistakes are irreversible, so the V10 economic contracts are deployed as a pre-mainnet and attacked — by humans and AI — **before** user funds are committed. Passing this program is the gate to mainnet.

## Scope — the full V10 on-chain contract set (`@origintrail-official/dkg-evm-module`)

{% hint style="warning" %}
**Exact target:** npm package `@origintrail-official/dkg-evm-module`, version `10.0.0-rc.17` (or the pinned launch RC), in the `OriginTrail/dkg` monorepo under `packages/evm-module`. **Do not** confuse this with the legacy standalone `dkg-evm-module` (v8.1.0, repo `OriginTrail/dkg-evm-module`) — the frozen V8.1 module, which has **none** of these contracts.
{% endhint %}

**Every V10 on-chain contract is in scope, under two reward tracks.** Both pay the same severity bands; **capture** (drain real TRAC, keep it) is an additional bonus available only on the honeypot track.

### Track 1 — Honeypot: the value-handling contracts (capture + severity)

TRAC is fixed-supply with minting permanently disabled, so the target is not a counterfeit token — it is **forging an unbacked economic position**: a conviction NFT that claims rewards or principal without the stake behind it.

* **Conviction NFTs** — `DKGStakingConvictionNFT` and `DKGPublishingConvictionNFT` (+ `PublishingConviction` / `PublishingConvictionStorage`): the mint path, the wrapper↔position binding, lock tiers, transfer/burn, and the V8→V10 migration mint path.
* **Staking & rewards** — `StakingV10`, `ConvictionStakingStorage` (the canonical V10 store **and TRAC vault**): deposits, withdrawals, delegation, relock/redelegate, and claims. _(`StakingStorage` is V8 legacy, read only by the V8→V10 drain path — in scope for the migration cutover.)_
* **Reward accrual** — `RandomSampling` / `RandomSamplingStorage`: per-epoch score, score-per-stake settlement, and the delegator/operator reward split that funds claims.
* **Locks** — the lock-tier ladder in `ConvictionStakingStorage` and any path that mutates, bypasses, or unwraps a position early.
* **Access control** — mint authorization resolved through the **Hub**, the Hub registry itself (`setContractAddress`, `forwardCall`, `setAndReinitializeContracts`), `initialize()` guards, the `onlyContracts` set-membership gate (`HubDependent`), admin/pause roles, the multisig (`ICustodian`) + timelock, and the upgrade path (address-swap; **no delegatecall proxy**). _(Shared infra — also guards Track 2.)_

{% hint style="info" %}
**Primary invariant under test:** a conviction NFT exists **if and only if** a real, backed position of equal amount and tier exists in storage under the same owner — and minting is reachable only through the staking flow, never with caller-supplied amount/tier/multiplier. Break that binding and it's **Critical**. A value-draining bug here can **capture** the live honeypot vault (you keep it, up to the cap) on top of the severity reward.
{% endhint %}

### Track 2 — General audit: every other deployed contract (severity)

Every remaining V10 contract at the pinned RC is in scope for the **severity reward** — no honeypot (these don't custody the bounty pool, so there is nothing to "capture"), but paid by the same bands as Track 1:

* **Knowledge Assets** — `DKGKnowledgeAssets`, `KnowledgeAssetsStorage`, `KnowledgeAssetsLifecycle`, `KnowledgeCollection`, and the rc.17 per-KA memory-model contracts.
* **Context Graphs** — `ContextGraphStorage`, `ContextGraphValueStorage`, `ContextGraphs`, `ContextGraphNameRegistry`.
* **Identity & profiles** — `IdentityStorage`, `Identity`, `ProfileStorage`, `Profile`.
* **Network & accounting** — `ShardingTable(Storage)`, `Ask(Storage)`, `EpochStorage*`, `Chronos`, `DelegatorsInfo`, `PaymasterManager` / `Paymaster`, `WhitelistStorage`, `ParametersStorage`.

Any on-chain bug counts: asset/fund loss, access-control or mint-authorization bypass, incorrect settlement or accounting, permanent state corruption or freeze.

**Out of scope:** off-chain software / UI (unless it causes on-chain loss), the production network and real user funds, social engineering, pure off-chain DoS, and issues already in the public tracker.

### Verified lock-tier schedule

The contracts seed exactly **four locked tiers** plus a liquid rest state (`ConvictionStakingStorage` baseline ladder):

| Tier         | Lock (wall-clock) | Effective-stake multiplier | Withdrawable    |
| ------------ | ----------------- | -------------------------- | --------------- |
| **0** (rest) | none              | 1.0×                       | always (liquid) |
| **1**        | 30 days           | 1.5×                       | after expiry    |
| **3**        | 90 days           | 2.0×                       | after expiry    |
| **6**        | 180 days          | 3.5×                       | after expiry    |
| **12**       | 366 days          | 6.0×                       | after expiry    |

New tiers are append-only and governance-gated (`addTier`, Hub-owner / multisig). Multiplier is read from the tier table — **never** caller-supplied.

## The honeypots — 200,000 TRAC

Real staked principal across the lock tiers, active Publisher and Staker conviction positions, and seeded reward state — production economics mirrored at scale, deployed on **Base mainnet** with **real TRAC**, fully isolated from any live deployment (its own Hub + full stack). **If you can take it through a genuine bug, you keep it** — up to the live-vault cap, on top of the severity reward. Demonstrating a viable attack path is rewarded even if no funds move. The only TRAC at risk is this pool — by design.

**How it's funded — one capped live vault + cold reserve.** With real TRAC and no on-chain clawback, the only cap that holds against a malicious researcher is a _structural_ one: the live vault is funded with only its cap, so a drain can never exceed it. The 200,000 is deployed as a single isolated live vault plus a cold reserve that redeploys it after each capture:

| Allocation                          | TRAC           | Role                                                                         |
| ----------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| **Live vault** — one isolated stack | \~60,000 TRAC  | the active target; its balance **is** the cap on any single capture          |
| **Cold reserve**                    | \~140,000 TRAC | redeploys a fresh vault after each capture (topped up so re-arms are funded) |
| **Total committed**                 | **200,000**    | total downside, bounded here regardless of caps                              |

{% hint style="info" %}
**One vault, one ceiling.** All staker and publisher conviction route into a single `ConvictionStakingStorage` whose sole outflow is `transferStake`, so a binding-break drains the whole live vault in one tx — and the vault's \~60,000 balance is the structural ceiling on any single capture. After a valid drain the surface closes until the bug is patch-verified, then a fresh vault redeploys from reserve. The program runs across several sequential captures before the committed pool is exhausted.
{% endhint %}

**What's in the live vault.** A representative slice that keeps every bug class reachable at moderate magnitude:

* **Conviction staking across all four lock tiers** (1/3/6/12) spread over a few sharding-active nodes — a tier-12 "whale" position large enough to make a single-account drain worth real effort, plus mid and several small co-delegators that stress many-staker / shared-denominator / cross-node / dust-rounding interactions.
* **Publisher conviction** — `DKGPublishingConvictionNFT` accounts with committed TRAC and harness-published knowledge assets.
* **Seeded reward state** — so the "claim more than you're owed" path is live. Rewards are _accrual-based_ (random-sampling proofs that compound into positions), so this is **harness-seeded** (a published KA + computed proofs over a few short epochs), not a static balance.
* **Migration / transitional** — accounts awaiting V8→V10 migration and positions left mid-unstake / mid-claim.

## General audit rewards

A **100,000 TRAC reward pool** prices severity for findings in **any** V10 contract, on top of the 200,000 TRAC honeypot captured on the value-handling contracts (Track 1).

| Severity          | Example                                                                                                                                                                                                    | Reward (TRAC)                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Critical**      | Minting an unbacked / over-stated conviction NFT; decoupling an NFT from its stake; minting outside the staking flow; Hub-registry takeover; bypassing locks; permanent fund freeze                        | **20,000–40,000** + capture up to the live-vault cap (\~60,000) |
| **High**          | Conditional / partial loss; access-control or mint-authorization bypass without immediate theft; temporary freeze; breaking a contract's functionality (e.g. minting Knowledge Assets) in an impactful way | **10,000–15,000**                                               |
| **Medium**        | Bounded impact — reward / accounting drift, incorrect settlement, value leakage without large-scale theft                                                                                                  | **2,000–5,000**                                                 |
| **Low**           | Minor impact under narrow preconditions                                                                                                                                                                    | up to **1,000** (discretionary)                                 |
| **Informational** | No economic-loss path                                                                                                                                                                                      | recognition + credit                                            |

**Minimum bar.** Severity = economic impact × breaking intended system behavior; no-impact findings are credited but unpaid. All reported bugs require a **working PoC**: on the live honeypot for Track 1 (which additionally stacks the capture bonus), or against the pinned RC / a forked deployment for Track 2. These gate the launch.

## Participate

Open to anyone — independent researchers, audit firms, AI-augmented teams. No invitation or allowlist; attack the public pre-mainnet honeypots and submit what you find.

* **Submit:** GitHub Private Vulnerability Reporting — [https://github.com/OriginTrail/dkg/security/advisories/new](https://github.com/OriginTrail/dkg/security/advisories/new) (preferred), or email **bounty@origin-trail.com**.
* **Triage:** acknowledged within **48 hours**; severity assessed within **5 business days**.
* **Payout:** in TRAC after validation, subject to sanctions screening.
* **Disclosure:** coordinated — **no public disclosure before a fix ships** (hard requirement for bounty reward); credit on opt-in.
* **Safe harbor:** good-faith research within these rules will not be met with legal action. Full T\&C aligned with the project's Apache 2.0 license.

## Codebase

Code under audit: [`packages/evm-module` @ `1f4fa01b`](https://github.com/OriginTrail/dkg/tree/1f4fa01b41c689d641943a59b2bc3d7336ba2f1e/packages/evm-module)

Commit **`36d9daebee47ea0886a13e0d3b587f9ba512dc45`** (OriginTrail/dkg `main`, 2026-06-10) — the frozen RC the honeypot is deployed from.\
\
Pre mainnet deployment Hub contract address on Base Mainnet: [0x26146f51e31a95c075228a34cfc696f09e4c36c3](https://basescan.org/address/0x26146f51e31a95c075228a34cfc696f09e4c36c3)\
\
Token honeypot contract address: [0x27ff0e72552d7df824f0b561442f3a91a8f9e47e](https://basescan.org/address/0x27ff0e72552d7df824f0b561442f3a91a8f9e47e)

## Path to mainnet

DKG V10 reaches mainnet in four phases. **Phase 1 — the Frontier-AI Resilience Gate (this bounty) — is the pass/fail checkpoint:** what survives ships, what breaks gets fixed first.

<figure><img src="../.gitbook/assets/ChatGPT Image Jun 10, 2026, 09_07_57 PM.png" alt=""><figcaption></figcaption></figure>

| Phase | Milestone                                                 | Window                               | Gate to advance                                                                                                                     |
| ----- | --------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Final-RC freeze & pre-mainnet deployment                  | ✅ Completed                          | Exact mainnet bytecode (`@origintrail-official/dkg-evm-module` `10.0.0-rc.17`) live on Base mainnet as an isolated, capped honeypot |
| **1** | **Frontier-AI Resilience Gate** — Track 1 honeypot bounty | June 10 → **June 17, 2026** (1 week) | Honeypot survives; all Critical / High findings patch-verified                                                                      |
| **2** | **DKG V10 Mainnet Launch**                                | Week of June 17, 2026                | Bounty-hardened, feature-complete V10 goes live                                                                                     |
| **3** | **Continuous general audit** — Track 2                    | Ongoing, post-launch                 | Severity-priced findings across every V10 contract                                                                                  |
