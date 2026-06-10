---
icon: bug
---

# OriginTrail DKG V10 Pre-Mainnet Bug Bounty

**Trust the source — including the source code.** Break the V10 economic contracts before they go live. Open to anyone.

<table data-header-hidden><thead><tr><th width="199"></th><th></th></tr></thead><tbody><tr><td>Theme</td><td>Attack the final V10 release-candidate economic contracts (<code>dkg-evm-module</code>) deployed as a public pre-mainnet</td></tr><tr><td>Total program value</td><td>300,000 $TRAC — 200,000 in live honeypots &#x26; a 100,000 reward pool</td></tr><tr><td>Status</td><td>Open — public pre-mainnet, no allowlist</td></tr><tr><td>Issued by</td><td><a href="https://origintrail.io">OriginTrail</a></td></tr></tbody></table>

{% hint style="warning" %}
**This is a `v0.1` draft.** Items marked **TBD** — the submission contact, triage and payout SLAs, the per-tier capture cap, and exact dates — are finalized before the program opens. Full terms and conditions will be aligned with counsel under the project's Apache 2.0 / governing-law framework.
{% endhint %}

## The program in one line

The final V10 release candidate — the exact contract bytecode intended for mainnet — is deployed as a public pre-mainnet, funded with **300,000 TRAC**: **200,000 in live honeypots** plus a **100,000 reward pool**. Anyone can attack it. What survives ships; what doesn't gets fixed first.

## Why

On 29 May 2026, a researcher using Claude Opus 4.8 found a critical, \~4-year-old soundness flaw in Zcash's Orchard pool — one that had passed repeated expert review — in about a day, with a working proof-of-concept. The lesson is plain: frontier AI now finds deep economic bugs faster than traditional review, and that power favors whoever uses it first. On-chain value-handling code only launches once and mistakes are irreversible, so the V10 economic contracts are deployed as a pre-mainnet and attacked — by humans and AI — before user funds are committed. Passing this program is the gate to mainnet.

## Scope — the V10 economic contracts (`dkg-evm-module`)

TRAC is fixed-supply with minting permanently disabled, so the target is not a counterfeit token — it is forging an unbacked economic position: a conviction NFT that claims rewards or principal without the stake behind it.

* **Conviction NFTs** — `DKGStakingConvictionNFT` and the Publisher conviction wrapper: the mint path, the wrapper↔position binding, lock tiers, transfer/burn, and the V8→V10 migration mint path.
* **Staking & rewards** — `StakingV10`, `StakingStorage`, `ConvictionStakingStorage`: deposits, withdrawals, delegation, and claims from the finite pre-funded reward pool.
* **Locks** — the immutable lock spec and any path that mutates, bypasses, or unwraps a position early.
* **Access control** — mint authorization resolved through the Hub, the Hub registry itself, `initialize()` guards, admin/pause roles, upgrade paths, multisig + timelock.

{% hint style="info" %}
**Primary invariant under test:** a conviction NFT exists **if and only if** a real, backed position of equal amount and tier exists in storage under the same owner — and minting is reachable only through the staking flow, never with caller-supplied values. Break that binding and it's **Critical**.
{% endhint %}

**Out of scope:** off-chain software / UI unless it causes on-chain loss, the production network and real user funds, social engineering, DoS, and issues already in the public tracker.

## The honeypots — 200,000 TRAC

Real staked principal across the lock tiers, active Publisher and Staker conviction positions, and a funded reward pool — production economics mirrored exactly, fully isolated from any live deployment. Because a forged position drains a bounded target (principal + rewards), the prize is pre-funded. If you can take it through a genuine bug, you keep it — capped per tier and on top of the severity reward. Demonstrating a viable attack path is rewarded even if no funds move. The only TRAC at risk is this pool — by design.

| Bucket | TRAC | Share |
| --- | ---: | ---: |
| Conviction staking accounts | 120,000 | 60% |
| Publisher conviction accounts | 40,000 | 20% |
| Reward pool (claimable reserve) | 30,000 | 15% |
| Reserve / migration / transitional | 10,000 | 5% |
| **Total** | **200,000** | **100%** |

* **Conviction staking — 120,000 TRAC (\~12 accounts).** Barbell-shaped: a 40,000 whale (longest lock) and a 20,000 sub-whale make a single-account drain worth real effort; four 8,000 accounts cover one per lock tier; six near-minimum accounts (\~4,600 each) exercise the min-stake boundary, rounding, and many-staker interactions.
* **Publisher conviction — 40,000 TRAC (\~6 accounts).** One 16,000 publisher whale, two 8,000 mid publishers, and three near-minimum publishers (\~2,700 each) — all running active publishing flows.
* **Supporting pools — 40,000 TRAC.** A 30,000 reward reserve sized well above total honeypot claims (so the "claim more than you're owed" path is testable), plus 10,000 across accounts awaiting V8→V10 migration and accounts left mid-unstake / mid-claim.

{% hint style="info" %}
**Confirm against spec:** four lock tiers are assumed — adjust counts to the real schedule; near-minimum amounts are set to the chain's actual minimum stake / conviction-mint thresholds. Deployed on the primary RC chain (Base); Gnosis, if covered, is a separate incremental pool, not carved from these 200k.
{% endhint %}

## Rewards

A **100,000 TRAC reward pool** prices severity, on top of the **200,000 TRAC honeypot** paid via capture. Top-heavy by design — most of the pool sits behind the economically critical classes. Bands are in TRAC, USD-peggable at payout.

| Severity | Example | Reward (TRAC) |
| --- | --- | ---: |
| **Critical** | Minting an unbacked / over-stated conviction NFT; decoupling an NFT from its stake; minting outside the staking flow; draining principal or the reward pool; Hub-registry takeover; bypassing locks; permanent fund freeze | 25,000–45,000 + capture (cap **TBD**) |
| **High** | Conditional / partial loss; access-control or mint-authorization bypass without immediate theft; temporary freeze | 8,000–18,000 |
| **Medium** | Bounded impact — reward / accounting drift, incorrect settlement, value leakage without large-scale theft | 2,000–5,000 |
| **Low** | Minor impact under narrow preconditions | up to 1,000 (discretionary) |
| **Informational** | No economic-loss path | recognition + credit |

**Minimum bar.** Severity = economic impact × exploitability, not novelty; no-impact findings are credited but unpaid. Paid rewards begin at Medium; the economically critical floor is High and above — direct or conditional fund-loss classes, which require a working PoC on the honeypot, stack the capture and AI bonus, and gate the launch.

{% hint style="info" %}
**AI-assisted bonus.** Use Claude Opus 4.8 and agentic tooling freely — the threat model assumes an AI-capable adversary, and the point is to be that adversary first, under authorization. Critical / High findings with a reproducible AI-assisted methodology earn the multiplier.
{% endhint %}

## Participate

Open to anyone — independent researchers, audit firms, AI-augmented teams. No invitation or allowlist; attack the public pre-mainnet honeypots and submit what you find.

* **Submit:** the security contact / Immunefi listing (**TBD**), or the address in the repo's [`SECURITY.md`](https://github.com/OriginTrail/dkg/blob/main/SECURITY.md).
* **Triage:** acknowledged within **TBD** hours; severity assessed within **TBD** business days.
* **Payout:** in TRAC after validation, subject to sanctions screening.
* **Disclosure:** coordinated — no public disclosure before a fix ships; credit on opt-in.
* **Safe harbor:** good-faith research within these rules will not be met with legal action. Full T&C aligned with the project's Apache 2.0 / governing-law framework — to be finalized with counsel.

## Path to mainnet

1. Freeze the final-RC contracts → internal AI-assisted audit + invariant testing.
2. Deploy as the public pre-mainnet with honeypots live → open bounty.
3. Remediate, re-audit, and machine-verify the core invariants: every NFT backed 1:1; lock integrity; no over-withdrawal; claims ≤ reward pool.
4. Mainnet — launched from verified code, guarded with conservative caps, a pause guardian, and timelocked admin actions.

Step 3 is the gate. No program eliminates all risk — which is why mainnet stays capped and guarded even after a clean bounty.

***

_Issued by OriginTrail d.o.o. · Pre-Mainnet Bug Bounty · `v0.1` draft. For the current official channel and submission thread, see_ [_origintrail.io_](https://origintrail.io)_._
