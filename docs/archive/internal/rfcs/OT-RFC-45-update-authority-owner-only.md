# OT-RFC-45: Update authority is owner-only — ratify the runtime and fix the contract documentation

| Field | Value |
|-------|-------|
| **RFC** | OT-RFC-45 |
| **Title** | Update authority is owner-only — ratify the runtime and fix the contract documentation |
| **Status** | Draft (for discussion) |
| **Created** | 2026-06-03 |
| **Track** | Protocol Core (on-chain authorization, contract documentation) |
| **Packages** | `evm-module` (documentation; **no runtime change**) |
| **Chain change** | **None to runtime.** The live code already enforces owner-only; this RFC ratifies that and fixes the NatSpec that contradicts it. |
| **Parent** | [OT-RFC-43 — Deterministic KA identity & the SWM→VM publish model](OT-RFC-43-deterministic-ka-identity.md) (§8.7, Open #9) |
| **Related** | [OT-RFC-44 — File = Knowledge Asset](OT-RFC-44-file-equals-ka.md) |

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

> **In one sentence.** The contract's documentation promises that a delegated team agent can *update* any Knowledge Asset in a curated context graph; the contract's code only lets the *current NFT owner* update. Integrators who trust the docs build workflows that revert on a live node. This RFC fixes the documentation to match the code, ratifies "owner-only" as the intended rule, shows how the real team workflows are built on it, and defines what it would take to add delegated update *later* as a deliberate feature.

---

## 1. Background — the actors and terms you need

This RFC is about *who is allowed to write to a Knowledge Asset on chain.* Three roles are easy to conflate; the whole issue comes from conflating them.

- **Context Graph (CG).** A namespace/collection that holds KAs. A CG is either **open** (`publishPolicy == 1`, anyone may publish) or **curated** (`publishPolicy == 0`, only authorized principals may publish). Think "public wiki" vs "private repo."
- **Curator.** The authority of a curated CG — like a repo admin. Sets the allowlist and delegation. May be an EOA, a Safe, or a **PCA** (below).
- **PCA — Publishing Conviction Account.** An account represented by the `DKGPublishingConvictionNFT` (symbol `DKGPC`). A curated CG can name a PCA account as its publish authority. A PCA account **commits TRAC into the V10 vault** (`createAccount(committedTRAC)` / `topUp`) and **registers agent wallets** (`agentToAccountId`), so the curator can let several bots/teammates *publish on the account's TRAC budget* without sharing the curator key. Publishing draws against the account's allowance (`coverPublishingCost`, per-window billing). (Codex-hardened so a PCA NFT transfer auto-revokes stale agents.)

  > **PCA is a "who-may-publish-and-who-pays" layer, not an authorship layer — and that is the root of the conflation.** A PCA's registered agents are EOAs authorized to *spend the account's committed TRAC to publish*; they do **not** thereby author or own anything. Authorship/ownership is a separate, per-KA fact set by the EIP-712 **author** attestation (`_safeMint(author, kaId)`), and update authority follows that owner. The contract header wrongly assumed the publish-payment delegation (multiple agents per account) also conferred *update* rights — but those are orthogonal: one is "may this key fund a publish into this CG," the other is "does this key own this specific KA." Your intuition is correct: PCA agents are for the TRAC-funded publish path, not for authorship.
- **`isAuthorizedPublisher(cgId, caller)`.** The gate for **publishing** (creating a *new* KA) into a curated CG. It returns true for: the live PCA NFT owner, **or any registered agent of that PCA account**, or (in EOA/Safe mode) the stored authority address. *(Verified — [ContextGraphs.sol:338-393](https://github.com/OriginTrail/dkg/blob/main/packages/evm-module/contracts/ContextGraphs.sol).)*
- **Publisher vs. Author vs. Owner — the three that get conflated.**
  - **Publisher** = `msg.sender` of the transaction; the principal that pays gas and is checked by `isAuthorizedPublisher`. Can be a PCA agent.
  - **Author** = the EIP-712-attested signer passed in the publish call; the KA NFT is minted **to the author** (`_safeMint(author, kaId)`). May differ from the publisher.
  - **Owner** = whoever currently holds the NFT (`ownerOf(kaId)`). Starts as the author; **changes on transfer**. The NFTs are standard transferable ERC-721 (no soulbinding).

**The two write paths, and the asymmetry at the heart of this RFC:**

| Path | What it does | Who is allowed (runtime) |
|---|---|---|
| **Publish** (`Lifecycle.publish` → `createKnowledgeAsset`) | mints a **new** KA | `isAuthorizedPublisher(cgId, msg.sender)` — **PCA agents CAN publish on behalf of the curator** (verified, [KnowledgeAssetsLifecycle.sol](https://github.com/OriginTrail/dkg/blob/main/packages/evm-module/contracts/KnowledgeAssetsLifecycle.sol) ~619) |
| **Update** (`Lifecycle.update` → `updateKnowledgeAsset`) | pushes a **new version** under an existing KA | `ownerOf(kaId) == attestedAuthor` — **owner-only; PCA agents CANNOT update** (verified, [`_executeUpdateCore`](https://github.com/OriginTrail/dkg/blob/main/packages/evm-module/contracts/KnowledgeAssetsLifecycle.sol) ~1322-1327) |

Publish delegates to agents; update does not. **The contract's own header documentation says update delegates too. It does not. That gap is this RFC.**

## 2. The discrepancy (verified against `main`@`1ae3ffd7`)

The **header NatSpec** of `KnowledgeAssetsLifecycle.sol` (lines ~71–84) documents a **two-branch, policy-dependent** update gate:

```
 * Authorization:
 *   - update:  policy-branch gate in `_executeUpdateCore`. Curated CGs
 *              (`publishPolicy == 0`) delegate to
 *              `isAuthorizedPublisher(cgId, msg.sender)` via the facade so
 *              EOA / Safe curators and PCA agents inherit update rights
 *              automatically. Open CGs (`publishPolicy == 1`) have no curator
 *              authority to delegate to, so update auth pins to the ORIGINAL
 *              publisher (`merkleRoots[0].publisher`) — the paying principal
 *              recorded at publish time.
```

The **live runtime** in `_executeUpdateCore` (~1322–1327) does **neither** branch — it is a single, unconditional **owner-only** check:

```solidity
_verifyUpdateAuthorAttestation(p);

address kaOwner = kcs.ownerOf(p.id);
if (kaOwner != p.authorAddress) {
    revert NotKnowledgeAssetOwner(p.id, kaOwner, p.authorAddress);
}
```

No `isAuthorizedPublisher` call, no `publishPolicy` branch, no `merkleRoots[0].publisher` pin. So **both** documented branches are wrong:

| CG type | Header says update auth is… | Runtime actually enforces |
|---|---|---|
| Curated (`publishPolicy==0`) | curator + delegated PCA agents | `ownerOf(kaId) == attestedAuthor` (owner-only) |
| Open (`publishPolicy==1`) | original publisher (`merkleRoots[0].publisher`) | `ownerOf(kaId) == attestedAuthor` (owner-only) |

The publish path *does* implement the delegation machinery, which is almost certainly why the header assumed update mirrored it. It does not. *(A second tell that the NatSpec here is stale: a comment at ~1275–1277 claims "the update path has no on-chain author verification," immediately before line 1322 calls `_verifyUpdateAuthorAttestation`.)*

## 3. How the problem manifests today — three concrete scenarios

### Scenario A — "CI bot keeps the team's code graph current" reverts in production

This is the canonical team workflow from RFC-43 §8: a curated CG (the lead is curator) holds a `code-structure` Knowledge Asset that should be re-published on every merge to `main`.

A developer reads the contract header — *"curated CGs delegate to `isAuthorizedPublisher` … PCA agents inherit update rights automatically"* — and builds the obvious thing:

1. Mint the `code-structure` KA with **author = the curator** (so "the project" owns it).
2. Register the **CI bot** as a PCA agent of the curator's account, so `isAuthorizedPublisher(cg, ciBot) == true`.
3. Wire CI to call `vm/publish` on each merge, signing as the CI bot.

**What actually happens:**

- The **first publish** (create) by the CI bot **succeeds** — the publish path consults `isAuthorizedPublisher`, and the CI bot is a registered agent, so it is authorized to create. ✅ This reinforces the wrong mental model.
- The **first update** (the next merge) **reverts** with `NotKnowledgeAssetOwner(kaId, owner = curator, attestedAuthor = ciBot)` — because `_executeUpdateCore` checks `ownerOf(kaId) == attestedAuthor`, and the CI bot is a *registered agent*, not the *owner*. ❌

The capability the docs promised does not exist. Worse, the failure is **late-binding**: create works, tests that mock the chain or only exercise create pass, and the revert only shows up on a real update against the real contract — after the integration is built. The developer must now re-architect ownership (§4 shows how).

### Scenario B — two teammates, two contradictory mental models

Dev A reads `_executeUpdateCore`, sees owner-only, and designs correctly: mint the code-graph KA **to the CI bot** so CI owns and can update it. Dev B reads the header, insists PCA delegation handles updates, and flags A's ownership choice as unnecessary. They burn a review cycle arguing — and the contract documentation is the source of the disagreement, so neither can "just read the docs" to settle it. Every team that touches this hits the same fork.

### Scenario C — the auditor cannot tell intent from bug

During the contract audit that RFC-43 Option 1 requires, the auditor sees a header promising a two-branch delegation gate and code doing a single owner-only check. They cannot tell whether owner-only is a **deliberate security decision** or a **bug** where someone forgot to wire the delegation branch. Either way it is a finding; reconciling it costs audit time and back-and-forth — for what is, in reality, just stale documentation. Shipping the fix *before* the audit removes the finding entirely.

## 4. Why owner-only is the right default (not just the accidental one)

It would be tempting to "fix" the mismatch by making the code match the docs (implement delegated update). That is the wrong direction, because the two paths have very different blast radius:

- **Delegated publish is additive.** A registered agent creating a *new* KA adds something; it cannot silently rewrite existing canonical content. Low risk → delegation is fine.
- **Delegated update is destructive.** An agent updating a KA it does not own can **overwrite the current, canonical version** of someone else's content — under an author attestation — across the whole storage fleet. High risk → it should require the owner's explicit authority, not a CG-level allowlist membership.

Owner-only also composes cleanly with the patterns teams actually want (§5), and it is *stricter*, so ratifying it now and relaxing later (if ever) is the safe ordering. This RFC therefore recommends **ratifying owner-only as canonical** and fixing the docs to match — not changing the runtime.

## 5. How the real team workflows are built on owner-only

Owner-only is not a limitation, because **ownership is selectable at publish, transferable afterward, and may be a smart account.** Each RFC-43 §8 pattern has a clean owner-only construction:

| Goal | Owner-only construction | Mechanism |
|---|---|---|
| **CI keeps the canonical code graph current** | Publish with **author = the CI/project agent** (not the curator). CI then *owns* the KA and is the sole updater. | `_safeMint(ciAgent, kaId)`; update passes because `ownerOf == ciAgent == attestedAuthor`. No transfer needed — just pick the right author at create. |
| **The team collectively owns + updates a KA** | Mint the KA **to a team Safe**. Updates then require the Safe's **N-of-M quorum**. | Owner is a Gnosis Safe; `_verifyUpdateAuthorAttestation` accepts the Safe's EIP-1271 signature. This is the "multisig to update" pattern with **zero new contract code**. **Requirement:** the owner contract MUST implement EIP-1271 `isValidSignature(bytes32,bytes)` returning `0x1626ba7e` — a Safe does so **via its `CompatibilityFallbackHandler`**, which must be set as the Safe's `fallbackHandler` at `setup()` (default deployments set it; a raw `SafeProxyFactory` deploy must pass it explicitly). A **pre-1271 multisig such as the classic Gnosis `MultiSigWallet` will NOT work** — it has no `isValidSignature`, so the EIP-1271 branch has nothing to call and updates revert. |
| **Hand update rights to a different key later** | **Transfer the NFT** to the new key/Safe. Update authority follows the new owner immediately. | Standard ERC-721 transfer; `_executeUpdateCore` reads `ownerOf` live. |
| **A human proposes; the team reviews** | Each dev **owns their own** planning KAs. The curator reviews what devs *share to SWM* (off-chain), not by holding update rights over everyone's KAs. | Decentralized authorship; review happens at the SWM/CCL layer, not via on-chain update delegation. |

The takeaway integrators need: **choose the owner at publish to match who should be able to update** (the CI agent, a Safe, or yourself) — don't mint to the curator and expect delegates to update it.

### 5.1 Key loss is a real single point of failure — own long-lived KAs with a Safe, not a bare EOA

The "author = a single CI/project EOA" pattern has a sharp failure mode: **owner-only gives no protocol-level recovery, so if that one key is lost, the KA can never be updated again — the canonical graph is permanently frozen.** This is not hypothetical for a project's `code-structure` KA that must outlive any individual key.

Because an EOA is, by definition, one key, **surviving key loss requires a smart-contract owner.** The protocol deliberately offers no KA-level delegation/recovery (that is the whole point of owner-only, §4), so the resilience must live in the *owner account*:

- **Safe (recommended default for any canonical / shared / long-lived KA).** An **M-of-N** Safe survives the loss of up to N−M keys. A useful shape for the CI case: own the code-graph KA with a Safe whose signers are **the CI bot key plus human backup keys** — e.g. 1-of-N so CI can update routinely while humans retain control, or 2-of-N (CI + one human) for tighter control. Lose the CI key → the humans still control the KA through the Safe. The project does **not** die.
- **Any recovery-enabled EIP-1271 smart account.** It does not have to be a Gnosis Safe — any contract wallet that implements EIP-1271 and has a social-recovery / guardian module works the same way (the contract only ever calls `isValidSignature`). Same fallback-handler/EIP-1271 requirement as the Safe row above.
- **Proactive rotation does not help *after* loss.** Transferring the NFT to a new key (§5 row 3) requires signing with the *current* key — so it is a tool for planned rotation or a *suspected* compromise, not for a key already lost. Resilience must be in place **before** loss, which is why canonical KAs should be Safe-owned from the first publish.

**Guidance:** a bare hot EOA is fine for *personal, low-stakes, or ephemeral* KAs. For anything the project's continuity depends on, **mint to a Safe (or recovery-enabled smart account) from the start.** (If protocol-level recovery is ever wanted as an alternative, that is exactly the kind of capability the §7 explicit-opt-in delegated-update flag could provide — at the §4 cost of allowing a non-owner to overwrite canonical content — which is why the safe-account route is preferred.)

## 6. The fix

This is a **documentation + decision** change. The runtime is already correct, so it carries **no chain risk** and can land immediately.

1. **Ratify owner-only** as the canonical update-authorization rule (sign-off from the contract owner).
2. **Rewrite the header NatSpec** (lines ~71–84) to describe the actual rule. Concretely, replace the two-branch description with:

   > *update: enforced in `_executeUpdateCore` as **owner-only** — the EIP-712-attested author MUST equal `ownerOf(kaId)`, independent of CG publish policy. There is no curator/PCA delegation on the update path (delegation applies to **publish** only). To change who may update a KA, transfer the NFT (an owner may be an EOA, a Safe via EIP-1271 for N-of-M, or an EIP-7702-delegated EOA).*

3. **Fix the stale in-function comments** (e.g. the "no on-chain author verification" note that precedes the attestation call).
4. **Add integrator guidance** (the §5 table) to the contract docs / node API docs so the owner-selection pattern is discoverable.

## 7. "Treat PCA-delegated update as a future, explicit opt-in" — what that means

This is the line from the parent RFC that needed unpacking. Plainly:

- **Today:** delegated update — a PCA agent (or curator) updating a KA it does **not** own — is **not possible**. The recommendation is to stop the documentation from implying it exists, **not** to build it.
- **If the team ever genuinely wants it** (e.g. "any of the curator's registered agents may update any KA in this CG"), it is a **deliberate, separately-audited feature**, not a documentation reinterpretation. Shape it as:
  - A new authorization branch in `_executeUpdateCore` that, *in addition to* the owner check, accepts `isAuthorizedPublisher(cgId, msg.sender)` — mirroring publish.
  - **Gated by an explicit per-CG policy flag that defaults to OFF** — e.g. `allowDelegatedUpdate` on the CG config. "Opt-in" means a CG must *consciously turn it on*, accepting the §4 tradeoff (a delegate can overwrite canonical content under another author's name), rather than the capability being silently on because the docs implied it or because a code path was left ambiguous.

  *Illustrative shape (not adopted here):*
  ```solidity
  // future, behind CG.allowDelegatedUpdate == true
  bool ownerOk     = (kaOwner == p.authorAddress);
  bool delegateOk  = cg.allowDelegatedUpdate
                     && contextGraphs.isAuthorizedPublisher(contextGraphId, msg.sender);
  if (!ownerOk && !delegateOk) revert NotKnowledgeAssetOwner(...);
  ```

The point of "explicit opt-in" is **safe defaults**: owner-only everywhere unless a CG deliberately, visibly relaxes it. This RFC adopts the safe default and leaves the relaxation as a scoped future option (§8 Open #2).

## 8. Action items & open questions

**Action items**

1. **Decision sign-off** from the contract owner: ratify owner-only as canonical update authority.
2. **Doc PR** against `KnowledgeAssetsLifecycle.sol`: rewrite the update-authorization NatSpec (§6.2) and fix the stale in-function comments.
3. **Surface freeze:** complete (1)–(2) **before** RFC-43 Phase 1 freezes the public surface and **before** any RFC-43 Option 1 contract change goes to audit — so the auditor reviews a contract whose docs match its code (removes Scenario C).
4. **Docs:** publish the §5 owner-selection guidance for integrators.

**Open questions**

1. Confirm owner-only (recommended) vs. the alternative of *implementing* the documented delegated-update model (larger change, audit, security review per §4).
2. Should the future delegated-update opt-in (§7) be scoped now as a named follow-on with the `allowDelegatedUpdate` flag, or left unscheduled until a concrete need appears?
3. Should "open CG" updates pin to the original publisher (as the header claims) rather than owner-only? Recommendation: **no** — keep owner-only uniform across policies; it is simpler and matches the runtime. Confirm.
