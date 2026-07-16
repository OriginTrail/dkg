---
icon: rotate
---

# Staking & Migration (V8 → V10)

This is the operator companion to [Conviction & Economics](../how-dkg-works/conviction-and-economics.md). That page documents the contract model. This page walks you through the **staking dashboard end-to-end** and covers the two journeys most people arrive with:&#x20;

* [**Journey A**](#journey-a-migrate-your-v8-stake-to-v10) **— Migrate a V8 stake to V10:** You already have TRAC staked on V8 and want to move it into the new conviction model.&#x20;
* [**Journey B**](#journey-b-first-time-staking-fresh-trac) **— First-time staking:** You hold TRAC in a wallet and want to delegate it to a node for the first time.&#x20;

Both journeys end in the same place: a _**Staking Conviction**_ position — an ERC‑721 NFT that records:

* Your staked amount
* The node you back
* Your lock tier
* Your reward multiplier
* Your unlock behavior

{% hint style="info" %}
**Demo note.** The screenshots in the source walkthrough run on a testnet deployment (Base Sepolia / Gnosis). Chain labels, balances, dates, and the live Annualized Node Yield figure differ on mainnet. Tiers and multipliers are the same.
{% endhint %}

***

## What you are staking into&#x20;

Staking only makes sense once you know what your TRAC is securing. DKG V10 is a three‑layer memory system (see [Key Concepts](../how-dkg-works/key-concepts.md)):

```
Working Memory    ──►    Shared Working Memory    ──►    Verifiable Memory
(private drafts)         (peer-visible)                 (on-chain Knowledge Assets)
```

Knowledge worth keeping gets published as a _**Knowledge Asset**_ — durable, provenance-bearing graph data anchored on-chain. The infrastructure that stores, serves, and verifies that memory is run by _**nodes**:_

* DKG _Core Nodes_ carry the resilient backbone
* DKG _Edge Nodes_ are the local gateways for users, apps, and agents

_**Conviction**_ is how the network ties TRAC commitment to long-term use, and it has two sides:&#x20;

<table><thead><tr><th width="91">Side</th><th width="111">Who</th><th>What they commit</th><th>What they get</th></tr></thead><tbody><tr><td><strong>Demand</strong></td><td>Publishers</td><td>TRAC into a Publishing Conviction</td><td>Account Publishing allowance + price discount</td></tr><tr><td><strong>Supply</strong></td><td>Stakers</td><td>TRAC locked behind a specific node</td><td>Reward weighting + share of publishing fees</td></tr></tbody></table>

_**Staker conviction**_ **is the supply side.** When you stake, you pick a node and lock TRAC behind it for a chosen duration. That gives the node reward weighting and economic security, and it earns you a share of the publishing fees flowing through the network — proportional to your position's weight.

## The conviction ladder (lock → multiplier)&#x20;

Your lock duration sets a **reward multiplier**. The multiplier scales the _weight_ of your stake in the reward calculation. It does **not** mint or burn principal. The dashboard exposes five discrete tiers, which match the V10 contract model exactly:&#x20;

<table><thead><tr><th width="76">Tier</th><th width="221">Lock</th><th width="115">Multiplier</th><th>Dashboard label</th></tr></thead><tbody><tr><td>1</td><td>No lockup</td><td>1x</td><td>Withdraw anytime</td></tr><tr><td>2</td><td>1 month (30 days) </td><td>1.5x</td><td>Short-term</td></tr><tr><td>3</td><td>3 months (90 days)</td><td>2x</td><td>Balanced</td></tr><tr><td>4</td><td>6 months (180 days)</td><td>3.5x</td><td>Strong</td></tr><tr><td>5</td><td>12 months (365 days)</td><td>6x</td><td>Maximum</td></tr></tbody></table>

**Effective stake weight = staked amount × multiplier.**&#x20;

Example from the [video walkthrough of the Staking UI & migration](#dkg-v10-staking-ui-and-migration-walkthrough):&#x20;

* 8,000 TRAC locked at the 12-month tier → `8,000 × 6 = 48,000` effective weight.&#x20;

A longer lock buys a larger share of rewards in exchange for giving up liquidity until the unlock date.

{% hint style="info" %}
Rewards are routed from publishing fees to the stakers behind each node, weighted by effective stake. Two fees come off the top before stakers are paid: the **node operator fee** (set per node, shown in the dashboard) and the **protocol treasury fee** (governance-set, default **3%**, capped at **10%**, and dormant at 0% until wider consensus is achieved).
{% endhint %}

## The dashboard at a glance&#x20;

The staking dashboard has three tabs:&#x20;

<table><thead><tr><th width="131">Tab</th><th>Use it to</th></tr></thead><tbody><tr><td><strong>All Nodes</strong></td><td>Browse every node and compare yield, power, health, rewards, and operator fee before you delegate.</td></tr><tr><td><strong>My Positions</strong></td><td>See the NFT positions you already hold, plus any migrated TRAC still waiting to be staked.</td></tr><tr><td><strong>Migrate</strong></td><td>Move a V8 stake into V10 as a per-chain migrated balance.</td></tr></tbody></table>

The _**All Nodes**_ table columns:&#x20;

* _Annualized Node Yield:_ Indicative return for delegating to that node.&#x20;
* _Node Power:_ Relative weight/stake behind the node.&#x20;
* _Node Health:_ Operational signal of the node's reliability.&#x20;
* _Rewards:_ Rewards accrued/available on the node.&#x20;
* _Operator Fee:_ The cut the node operator takes before staker rewards.&#x20;

Supported chains throughout: Base, Gnosis, and NeuroWeb.

## DKG v10 Staking UI & migration walkthrough

{% embed url="https://youtu.be/RDksODY-T_s" %}

***

## Journey A — Migrate your V8 stake to V10&#x20;

### Why migrate, and why now&#x20;

Migration moves your existing V8 stake into the V10 conviction model **on the same chain — no bridging, no unstaking first, and without waiting out the 28-day cooldown**. Your V8 TRAC becomes a _migrated balance_ that you then stake into a conviction tier.&#x20;

There is also a one-time **migration credit** (the "sweetener"). TRAC that has been locked since the V8 snapshot — the point at which V8 paused reward distribution — earns roughly a **60-day credit** (the walkthrough cites 60–70 days).&#x20;

The credit **shortens the duration of the highest conviction tiers:** placing an eligible balance on a 6- or 12-month lock unlocks about **60 days sooner**. The exact daily credit is calculated on the day the network is fully deployed.&#x20;

### Step A1 — Open Migrate and connect your wallet&#x20;

On the dashboard, open the migration flow. The "Migrate your stake to V10" modal explains the model:

#### **Migrate your stake to V10**&#x20;

DKG V10 introduces **conviction staking**. Move your existing V8 stake into V10 — same chain, no bridging, and without unstaking first or waiting the 28-day cooldown.

1. **Migrate stake.** One transaction per chain drains your V8 stake.
2. **It becomes a migrated balance.** Per chain (Base, Gnosis, NeuroWeb\*), ready to stake or withdraw.
3. **Stake it like normal.** At the confirm step, you choose your TRAC source — either wallet or V8-migrated balance. Eligible balance on a 6/12-month lock unlocks 60 days sooner.

#### **NeuroWeb is exempt for now — no live nodes.**&#x20;

There are no nodes running on NeuroWeb yet, so there is nothing to delegate to on that chain, and its Migrate/Stake action is greyed out. Any migrated NeuroWeb balance can still be withdrawn.&#x20;

Until nodes come online there, do your migration and staking on **Base and Gnosis**.&#x20;

1. Choose _**Migrate stake**_ (or _**Not now — go to staking**_ to skip straight to fresh staking).&#x20;
2. **Pick a wallet from the connect prompt**. The dashboard uses EIP-6963 provider discovery, so it auto-detects any compatible browser extension wallet you have installed (MetaMask, Rabby, Coinbase Wallet, Brave, Phantom, …). There is no WalletConnect, so the connection is via a browser extension rather than a mobile QR pairing.&#x20;
3. **Approve the connection in your wallet.** The dashboard then reads your exact balances per chain from your migration account.&#x20;

### Step A2 — Review your migrated balances per chain&#x20;

The Migrate V8 → V10 screen lists _**Your migrated TRAC**_, one row per chain (Base, Gnosis, NeuroWeb), each showing that chain's migrated balance with **Stake** and **Withdraw** actions.

**Migration runs one transaction per chain** — each drains that chain's V8 stake into its migrated balance. You can migrate one chain, several, or all.&#x20;

### Step A3 — Confirm credit eligibility&#x20;

On the confirm step, you'll see **your eligibility spelled out** — your migrated balance on that chain, and how much of it is eligible for the 60-day credit.&#x20;

Eligible balance gets the shortened unlock when you place it on a 6- or 12-month tier. So if you intend to claim the credit, stake into the **3.5× (180-day)** or **6× (365-day)** tier.&#x20;

### Step A4 — Stake the migrated balance (Delegate TRAC)&#x20;

Click Stake on a chain row to open the Delegate TRAC wizard. It has four steps: **Conviction → Chain → Node → Confirm**.&#x20;

1. **Conviction.** Pick a tier from the ladder (1× / 1.5× / 2× / 3.5× / 6×). The walkthrough selects 6× — 365 Days — Maximum for the largest multiplier and the best reward share. Select and Continue.&#x20;
2. **Chain.** Confirm the chain for this position (e.g. Gnosis). Continue.&#x20;
3. **Node.** Choose a node from the searchable list (each row shows the node, its stake, and its fee, with a Select action). The walkthrough selects Anacreon. Continue.&#x20;
4. **Confirm —** the amount & confirm step:&#x20;
   1. **Stake from:** Toggle between "_Your wallet balance"_ and "_V8 migrated balance"_. For migration, choose "_V8 migrated balance"_.&#x20;
   2. **Amount to stake:** Type an amount or hit MAX.&#x20;
   3. **Review the summary:** _Conviction_, _Chain_, _Node_, _Unlock date_ (e.g. 17 Apr 2027), _Effective stake weight_ (your staked amount × the tier multiplier), and _Estimated Annualized Node Yield_ (the live figure is wired in once the protocol Annualized Node Yield formula is settled).&#x20;
   4. Tick "I have read and accept the terms", then **Stake migrated TRAC**.

{% hint style="info" %}
**You don't have to stake it all on one node.** You can split a migrated balance across nodes — put part on one node and the remainder on another — to spread across operators. Run the wizard once per slice.&#x20;
{% endhint %}

### Step A5 — Verify under My Positions&#x20;

Open **My Positions**. You'll see:&#x20;

* **Summary tiles:** Total TRAC Staked, Total Fees Earned, Claimable Now.&#x20;
* **A banner reminding you of any migrated TRAC still unallocated** across your chains: Stake it into V10 or withdraw it.&#x20;
*   **A position card for the stake you just created:**&#x20;

    * the position NFT (e.g. `#4596`, with View NFT),&#x20;
    * the node (Anacreon),&#x20;
    * the chain (Gnosis),&#x20;
    * a _Migrated from V8_ badge,&#x20;
    * the staked amount,&#x20;
    * the tier/multiplier, and&#x20;
    * the Started/Unlocks dates.&#x20;

    That position is now live and accruing.

***

## Journey B — First-time staking (fresh TRAC)&#x20;

If you have no V8 stake, you stake TRAC straight from your wallet. Connect a wallet first — any EIP-6963 browser-extension wallet you have installed (MetaMask, Rabby, Coinbase Wallet, …). The flow is then the same wizard as migration, with two differences: you start from _**All Nodes**_, and your source is _**Your wallet balance**_.&#x20;

### Step B1 — Pick a node on _All Nodes_&#x20;

Open _**All Nodes**_ and compare candidates. A reasonable first pass:&#x20;

* **Node Health:** Favor reliable nodes; an unhealthy node is a poor home for a long lock.&#x20;
* **Operator Fee:** A lower fee means more of the publishing fees reach you.&#x20;
* **Annualized Node Yield/Rewards:** The indicative return, read alongside the fee and health rather than in isolation.&#x20;

### Step B2 — Start staking → Delegate TRAC&#x20;

Click _**Stake TRAC**_ to open the same **Delegate TRAC** wizard (**Conviction → Chain → Node → Confirm**):&#x20;

1. **Conviction.** Pick your lock tier. If you want liquidity, start at 1× (No lock — withdraw anytime); for a larger reward share, lock longer.&#x20;
2. **Chain.** Pick Base or Gnosis — choose the chain where you hold TRAC and want the position to live. (No live nodes currently available on NeuroWeb)
3. **Node.** Select your node from the list.&#x20;
4. **Confirm.** On Amount & confirm:&#x20;
   1. Set _Stake from → Your wallet balance_
   2. Enter the amount (or MAX)
   3. Review the summary (multiplier, unlock date, effective weight)
   4. Accept the terms, and Stake.&#x20;

### Step B3 — Approve in your wallet and verify&#x20;

Your wallet will request token-spend approval, then the stake transaction. Approve both. The new NFT position then appears under _**My Positions**_, with no "Migrated from V8" badge.

***

## After you stake — managing a position&#x20;

Each position is an ERC-721 NFT. From My Positions you can:&#x20;

* **Withdraw matured locks:** Once a locked position reaches its unlock date (or immediately, for the 1× no-lock tier).&#x20;
* **Re-delegate the position** to a different node.&#x20;
* **Renew conviction** at a new tier.&#x20;

### Withdraw and locks&#x20;

<table><thead><tr><th width="265">Situation</th><th>Liquidity</th></tr></thead><tbody><tr><td>1x (no lock)</td><td>Withdraw any time from My Positions.</td></tr><tr><td>Locked tier, past unlock date</td><td>Withdraw normally.</td></tr><tr><td>Locked tier, before unlock date</td><td>TRAC stays locked until the unlock date. </td></tr></tbody></table>

A longer lock trades liquidity for a higher multiplier: there is **no early exit**, so pick a tier you are comfortable committing to for its full duration.

