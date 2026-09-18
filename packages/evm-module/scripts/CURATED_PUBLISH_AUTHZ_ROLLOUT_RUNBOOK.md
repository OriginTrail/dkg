# KnowledgeAssetsLifecycle 10.1.7 curated-publish authorization rollout

Procedure for rolling out `KnowledgeAssetsLifecycle` (KAL) **10.1.7**, which widens
curated-Context-Graph publish authorization (GH#1689): the gate is now satisfied by
**either** the paying principal (`msg.sender`) **or** the EIP-712-attested author
(`p.authorAddress`) — `KnowledgeAssetsLifecycle.sol:908-913`. `_VERSION` moves
`10.1.6` → `10.1.7` (`KnowledgeAssetsLifecycle.sol:190`), and the node client gates
its matching relaxation on that value, so **the fix is inert until this rotation is
executed**.

KAL is not upgradeable. "Upgrading" means deploying a new instance and repointing
the Hub name→address registry. That rotation has irreversible side effects on
outstanding cryptographic material. Read §1 before touching anything.

---

## 1. ⚠️ READ THIS BEFORE YOU DEPLOY

### 1.1 Rotating KAL invalidates every outstanding author attestation and every in-flight StorageACK

The KAL contract address is baked into **two** independent signature preimages:

- **EIP-712 author attestation** — the domain separator pins
  `verifyingContract = address(this)`:
  `KnowledgeAssetsLifecycle.sol:1170-1178` (publish),
  `KnowledgeAssetsLifecycle.sol:1221-1229` (update).
- **Raw StorageACK preimage** — `address(this)` is the third packed member of the
  `abi.encodePacked` digest: `KnowledgeAssetsLifecycle.sol:790-806` (publish, address
  at `:794`), `KnowledgeAssetsLifecycle.sol:1668-1685` (update, address at `:1672`).
  The off-chain builder mirrors that layout byte-for-byte and documents the intent —
  *"Replay across chains / forks / contract redeployments / field-set versions is
  rejected at signature verification"* (`packages/core/src/crypto/ack.ts:165-190`).

The instant the Hub points `KnowledgeAssetsLifecycle` at a new address, **every
author seal and every collected ACK signed against the old address becomes
unverifiable**. This is by design (anti-replay), not a bug to work around.

### 1.2 A queued VM publish carrying a stale seal HARD-FAILS, with no in-code re-seal path

`packages/agent/src/dkg-agent-publish.ts:5012-5017` compares the seal's persisted
`kav10Address` against the live Hub-resolved address and throws:

```
publishQueuedKnowledgeAssetVmPublish: seal binds KAv10=0x<old> but daemon
is configured for KAv10=0x<new>.
```

Re-running `finalize` does **not** fix it. `assertionFinalize` is idempotent: when a
seal already exists with a matching merkle root it returns that seal verbatim,
including the old `kav10Address` (`dkg-agent-publish.ts:2759`, `:2815-2822`, `:2877`).
The only sanctioned re-seal loops are the ones the code itself names at
`dkg-agent-publish.ts:2795-2797`: `pull-from` (re-opens a fresh draft and clears the
stale seal) or discard-and-recreate. See §6.

**⇒ Drain the async publisher queue to empty BEFORE rotating (§4). Skipping this
strands every queued publish and forces per-asset manual recovery.**

### 1.3 Rotation is a hard cutover — there is no coexistence window

Storage-write permission derives from Hub **set membership**, not from a flag:
`HubDependent._checkHubContract` reverts `UnauthorizedAccess("Only Contracts in Hub")`
unless `hub.isContract(msg.sender)` (`contracts/abstract/HubDependent.sol:46-50`;
`Hub.isContract(address)` at `Hub.sol:117-119`). Repointing the name removes the old
address from the by-address index —
`UnorderedNamedContractDynamicSet.update` does `delete self.addressIndexPointers[currentAddr]`
then rebinds the slot (`contracts/libraries/UnorderedNamedContractDynamicSet.sol:48-50`).

So the **old KAL loses all storage-write access in the same transaction that
registers the new one** (every `DKGKnowledgeAssets` mutator is `onlyContracts` —
`contracts/storage/DKGKnowledgeAssets.sol:229, 375, 487, 562, 639-730`). Old and new
KAL can never both publish. Plan for a single instantaneous switch.

### 1.4 `setStatus(false)` is NOT a rollout lever — do not try to stage the cutover with it

Two independent reasons:

1. `Hub._setContractAddress` reads `oldContractAddress` **after** `contractSet.update(...)`
   (`Hub.sol:178` then `Hub.sol:180`), so by the time it calls `setStatus(false)` the
   name already resolves to the **new** address. The disable lands on the contract you
   just installed. It is then immediately re-enabled by `setStatus(true)` at `Hub.sol:196-202`,
   which is the only reason this is inert rather than an outage.
2. KAL never reads `status` anyway. It inherits the flag from `ContractStatus`
   (`KnowledgeAssetsLifecycle.sol:107`, `contracts/abstract/ContractStatus.sol:8,13-15`)
   and there is no modifier or branch anywhere in `KnowledgeAssetsLifecycle.sol` that
   consults it.

The only real levers are: rotate, or rotate back.

---

## 2. What does NOT need to change

### 2.1 No node config edit, and no node restart

Every contract address is Hub-resolved at runtime. The **only** hard-coded chain
address in node config is `chain.hubAddress`:

| Network file | `hubAddress` |
| --- | --- |
| `network/testnet.json:34` | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` |
| `network/mainnet-base.json:28` | `0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13` |
| `network/mainnet-gnosis.json:30` | `0x882D0BF07F956b1b94BBfe9E77F47c6fc7D4EC8f` |

A running node self-heals within roughly one poll interval:

- `HubRotationPoller` scans Hub rotation events every **30 s**
  (`packages/chain/src/evm-adapter-base.ts:1157-1162`, interval constant at `:291`).
- On any observed rotation, `applyHubRotationEventName` flushes the whole resolved-address
  memo and, for a name with a binding policy — `KnowledgeAssetsLifecycle` is one
  (`evm-adapter-base.ts:99`) — calls `finalizeKnownHubRotation`, which sets
  `initialized = false` (`evm-adapter-base.ts:4003-4026`, `:4040-4052`). The next public
  call re-enters `init()`, which unconditionally re-resolves KAL from the Hub
  (`evm-adapter-base.ts:2693-2698`).
- Backstops if the poller misses the event: the 30 s address memo TTL
  (`RESOLVE_CONTRACT_ADDRESS_MEMO_TTL_MS`, `evm-adapter-base.ts:187`) and the write-side
  self-heal `withHubStaleRetry` (`evm-adapter-base.ts:3861`), which drops every bound
  handle when a write surfaces `UnauthorizedAccess(Only Contracts in Hub)`
  (`packages/chain/src/evm-adapter-errors.ts:93-94`).

**Do not tell operators to restart nodes.** Restarting mid-drain is worse than doing
nothing — it can re-admit work you were trying to quiesce.

### 2.2 No ABI change, no storage migration

The `UnauthorizedPublisher(contextGraphId, msg.sender)` revert is unchanged
(`KnowledgeAssetsLifecycle.sol:912`), so no ABI regeneration and no client digest
pinning update is required. KAL holds no durable user state — all state lives in the
storage contracts, which are **not** redeployed here.

---

## 3. Current recorded deployments

From `packages/evm-module/deployments/*.json` at the time this runbook was written.
`KnowledgeAssetsLifecycle` is the only contract this rollout touches.

| Network (hardhat name) | Hub | KnowledgeAssetsLifecycle | KAL version |
| --- | --- | --- | --- |
| `base_sepolia_v10` | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` | `0x835F921A0fC8D6365C34A0bB9b37D10C98C1B8c3` | `10.1.6` |
| `gnosis_mainnet` | `0x882D0BF07F956b1b94BBfe9E77F47c6fc7D4EC8f` | `0x38b54901f0ADE112Fd9002024dbdd0DB3D7321B5` | `10.1.6` |
| `base_mainnet` | `0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13` | `0x38b54901f0ADE112Fd9002024dbdd0DB3D7321B5` | `10.1.6` |

Unchanged by this rollout, listed because §7 verification reads them:
`ContextGraphs` `10.0.4`, `DKGKnowledgeAssets` `10.1.0` on all three.

**Record the pre-rotation KAL address for your target network now** — it is the
rollback target (§8) and the deployments JSON is overwritten in place by the deploy.

### Prerequisites

- Deployer key must be the **Hub owner**, or an owner of the multisig that owns the
  Hub (`Hub.setContractAddress` / `Hub.setAndReinitializeContracts` are
  `onlyOwnerOrMultiSigOwner` — `Hub.sol:46-51`, `:164-174`; check at
  `Hub.sol:295-300`). **Hub key custody is `TBD (ops-owned)`** — it is not recorded
  anywhere in this repository. Confirm who holds it, and their availability window,
  before starting.
- Environment, from `packages/evm-module/utils/network.ts:3-16, 18-29`:
  - Base Sepolia: `RPC_BASE_SEPOLIA_V10`, `EVM_PRIVATE_KEY_BASE_SEPOLIA_V10`
  - Gnosis mainnet: `RPC_GNOSIS_MAINNET`, `EVM_PRIVATE_KEY_GNOSIS_MAINNET`
  - Base mainnet: `RPC_BASE_MAINNET`, `EVM_PRIVATE_KEY_BASE_MAINNET`

  Mainnet networks refuse to fall back to a shared `MNEMONIC` and deploy from an empty
  account list instead (`utils/network.ts:67-75`) — a missing mainnet key fails fast
  rather than broadcasting from the wrong signer.
- Native gas on the deployer for one deploy + one Hub transaction.
- Dry run first: deploy and rotate on a local devnet, then run
  `packages/evm-module/test/v10-curated-publish-authz.test.ts` against it.

---

## 4. Step 1 — Drain the async publisher queue (MANDATORY, before deploying)

Run on **every** node that async-publishes to the target chain. Skipping this is what
strands publishes per §1.2.

Job states are `accepted, claimed, validated, broadcast, included, finalized, failed`;
only `finalized` and `failed` are terminal
(`packages/publisher/src/lift-job-states.ts:1-9`, `:21-23`).

1. **Stop admitting new work.** The runner reads `publisher.enabled` once at
   construction (`packages/cli/src/publisher-runner.ts:188`), so the setting only takes
   effect on daemon restart. Do this **first**, while the queue is still allowed to be
   non-empty:

   ```bash
   dkg publisher disable      # packages/cli/src/commands/publisher.ts:190-203
   dkg stop
   dkg start
   ```

   Also pause any upstream automation that calls `dkg publisher publish-async` /
   `dkg knowledge-asset publish-async`.

2. **Cancel what is still queued.** `cancel` only accepts jobs in `accepted`
   (`packages/publisher/src/async-lift-publisher-impl.ts:1013-1018`); anything already
   claimed must be allowed to reach a terminal state.

   ```bash
   dkg publisher jobs --status accepted        # → GET /api/publisher/jobs?status=accepted
   dkg publisher cancel <job-id>               # → POST /api/publisher/cancel
   ```

3. **Wait for the queue to reach zero non-terminal jobs.** Re-enable the publisher
   temporarily if in-flight jobs need the worker to finish them, then poll:

   ```bash
   dkg publisher stats                         # → GET /api/publisher/stats
   ```

   Gate: `accepted`, `claimed`, `validated`, `broadcast`, and `included` must all be
   `0`. `finalized` and `failed` may be non-zero.
   (Routes: `packages/cli/src/daemon/routes/publisher.ts:433-441`, `:515-518`,
   `:521-528`.)

4. **Clear terminal records** (optional, keeps the post-rotation signal clean):

   ```bash
   dkg publisher clear finalized               # POST /api/publisher/clear — only
   dkg publisher clear failed                  # "finalized" or "failed" are accepted
                                               # (routes/publisher.ts:544-555)
   ```

   For a single job by id, use `POST /api/publisher/clear-job` with `{ "jobId": ... }`
   (`routes/publisher.ts:562-572`).

5. **Inventory what is finalized-but-unpublished.** These are the assertions that will
   need re-sealing in §6. Capture the list now — after the rotation the seal mismatch
   is the only symptom you will see.

---

## 5. Step 2 — Deploy the new KAL and rotate the Hub (Base Sepolia)

Run from `packages/evm-module/`. `hre.helpers.deploy()` short-circuits and returns the
recorded address whenever `contracts.<name>.deployed` is `true`, and it never compares
the recorded `version` to the Solidity `_VERSION`
(`packages/evm-module/utils/helpers.ts:148-162`, `:376-382`). A plain deploy would
therefore keep 10.1.6. The flag must be flipped by hand.

```bash
npx hardhat compile
```

Force only `KnowledgeAssetsLifecycle` through the deploy helper:

```bash
node -e '
  const fs = require("fs");
  const p = "deployments/base_sepolia_v10_contracts.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const c = j.contracts.KnowledgeAssetsLifecycle;
  if (!c) throw new Error(`KnowledgeAssetsLifecycle missing from ${p}`);
  if (c.version !== "10.1.6") {
    throw new Error(`Expected Base Sepolia to start from 10.1.6, got ${c.version}`);
  }
  console.log("Rollback target (old KAL):", c.evmAddress);
  c.deployed = false;
  fs.writeFileSync(p, JSON.stringify(j, null, 4) + "\n");
  console.log("Marked KnowledgeAssetsLifecycle for redeploy.");
'
```

**Write down the printed rollback target.**

Deploy and rotate:

```bash
npx hardhat deploy --network base_sepolia_v10
```

What that single command does, in order:

1. `deploy/active/052_deploy_knowledge_assets_lifecycle.ts:5-8` deploys a fresh
   `KnowledgeAssetsLifecycle` with the Hub address as its constructor argument.
2. Because `base_sepolia_v10` is `environment: 'testnet'`, not `'development'`
   (`hardhat.node.config.ts:62-68`), the helper does **not** send its own
   `Hub.setContractAddress`; it queues the name→address pair into `newContracts`
   (`utils/helpers.ts:198-209`) and the address into `contractsForReinitialization`
   (`utils/helpers.ts:244`).
3. `deploy/active/998_initialize_contracts.ts:39-57` sends **one** owner-signed
   `Hub.setAndReinitializeContracts(...)` transaction that registers the new address and
   calls `initialize()` on it (`Hub.sol:164-174`; `KnowledgeAssetsLifecycle.initialize()`
   is `onlyHub` — `KnowledgeAssetsLifecycle.sol:498`). **Deploy, Hub repoint, and
   initialize are atomic in that one transaction.**

Expect that transaction to also re-`initialize()` other already-deployed contracts:
`helpers.deploy()` pushes every contract that exposes `initialize` into
`contractsForReinitialization` even on the short-circuit path
(`utils/helpers.ts:154-159`). This is the normal, precedented behaviour of
`hardhat deploy` on this repo, not a symptom of a problem. `initialize()` only
re-resolves Hub dependencies.

Commit the resulting post-deploy metadata **only after** the JSON records the new
address, `version: "10.1.7"`, and `deployed: true`.

> Equivalent packaged form: `pnpm --filter @origintrail-official/dkg-evm-module run deploy:testnet`.

---

## 6. Step 3 — Re-seal stranded assertions

Any assertion that was **finalized but not published** before the rotation now carries
a seal bound to the old KAL and will hard-fail on publish (§1.2). Per
`dkg-agent-publish.ts:2795-2797`, there are exactly two sanctioned recoveries:

- **Content already reached SWM or VM** — re-open a fresh draft, which clears the stale
  seal, then re-finalize against the new KAL:

  ```bash
  dkg knowledge-asset pull-from <name> --context-graph <cgId> --layer swm   # or --layer vm
  dkg knowledge-asset finalize  <name> --context-graph <cgId>
  ```

  `pull-from` itself requires a finalized v2 seal to exist, otherwise it rejects with
  `UNSEALED_PULL_FROM_BLOCKED` (`packages/publisher/src/dkg-publisher.ts:7784-7791`),
  and it seeds the new draft from the exact SWM/VM graph
  (`dkg-publisher.ts:7819-7834`).

- **Content only ever existed in Working Memory** — there is no SWM/VM source to pull
  from. Discard and re-create:

  ```bash
  dkg knowledge-asset discard <name> --context-graph <cgId>
  # then re-create / write / finalize as normal
  ```

Confirm the new seal binds the new address before re-publishing (`eip712Digest` printed
by `finalize` changes; the seal's `kav10Address` must equal the §7 value).

---

## 7. Step 4 — Post-rotation verification

Read the deployed addresses from the post-deploy
`deployments/base_sepolia_v10_contracts.json`:

```bash
KAL_ADDR=<contracts.KnowledgeAssetsLifecycle.evmAddress>
HUB_ADDR=<contracts.Hub.evmAddress>
```

**1. The new contract reports 10.1.7** (`KnowledgeAssetsLifecycle.sol:545-547`, backed
by `_VERSION` at `:190`) — this is the exact value the node-side capability gate reads:

```bash
cast call "$KAL_ADDR" 'version()(string)' --rpc-url "$RPC_BASE_SEPOLIA_V10"
```

Expected: `10.1.7`.

**2. The Hub points at it:**

```bash
cast call "$HUB_ADDR" 'getContractAddress(string)(address)' KnowledgeAssetsLifecycle \
  --rpc-url "$RPC_BASE_SEPOLIA_V10"
```

Expected: `$KAL_ADDR`. The old address must no longer be a Hub contract:

```bash
cast call "$HUB_ADDR" 'isContract(address)(bool)' <old KAL address> \
  --rpc-url "$RPC_BASE_SEPOLIA_V10"
```

Expected: `false` (this is §1.3 in observable form).

**3. The actual fix works end to end.** On a **curated** CG (`publishPolicy != 1`) in
EOA/Safe mode (`publishAuthorityAccountId == 0`, the branch at
`contracts/ContextGraphs.sol:577-582`) whose `publishAuthority` is agent wallet `A`:

- finalize a KA authored by `A`;
- publish it paying from a **distinct, funded** wallet `P` that is *not* the CG
  authority;
- the publish must **succeed**.

Confirm attribution did not move: `merkleRoots[0].publisher == P` (publisher-of-record
and payer, `KnowledgeAssetsLifecycle.sol:934-936`) while `ownerOf(kaId) == A`.

Sanity-check the negative direction too: a publish where **neither** the payer nor the
attested author is authorized on that CG must still revert `UnauthorizedPublisher`.

**4. No job is stuck in `authority_forbidden`:**

```bash
dkg publisher jobs --status failed
```

Expected: no job whose `failure.code` is `authority_forbidden`. That code is terminal
and non-retryable by policy (`packages/publisher/src/lift-job-failures.ts:99`), so a
job carrying it will never self-recover — every occurrence is a real authorization
problem to investigate, not transient noise.

**5. Nodes picked up the rotation without a restart** — re-run a publish on a node you
did not touch, ≥ 60 s after the rotation transaction confirmed (one 30 s poll interval
plus one 30 s memo TTL). No `Only Contracts in Hub` errors should appear in daemon logs.

---

## 8. Rollback

Rollback is a **second Hub rotation** back to the previous KAL address, owner-signed:

```bash
cast send "$HUB_ADDR" 'setContractAddress(string,address)' \
  KnowledgeAssetsLifecycle <old KAL address> \
  --rpc-url "$RPC_BASE_SEPOLIA_V10" --private-key "$EVM_PRIVATE_KEY_BASE_SEPOLIA_V10"
```

Then restore `deployments/base_sepolia_v10_contracts.json` to the pre-rotation entry so
the recorded metadata matches chain state.

**Trigger:** any unexpected publish revert class after rotation that is not explained by
a stale seal.

**Limitations — state these to whoever authorizes the rollback:**

- **KAs published in the window stay published.** Nothing is undone. The KAs, their
  NFTs, and every TRAC transfer are final.
- **Seals produced against the new KAL become invalid on rollback**, by exactly the
  mechanism in §1.1, in the opposite direction. Every assertion finalized after the
  rotation must be re-sealed again (§6). The drain in §4 has to be repeated before
  rolling back, or you strand a second batch.
- **`setStatus(false)` is not an alternative** — see §1.4.

**Forward-fix is preferred over rollback.** The change is a pure widening — the new
contract accepts a strict superset of what 10.1.6 accepted — so a rollback re-breaks
#1689 without fixing anything the rotation could plausibly have broken.

---

## 9. Mainnet rollout

Base Sepolia (`base_sepolia_v10`) is the canary. `gnosis_mainnet` and `base_mainnet`
follow **separately, after canary soak** — never in the same session.

Per mainnet network, the procedure is §4 → §5 → §6 → §7 with these substitutions:

| | `gnosis_mainnet` | `base_mainnet` |
| --- | --- | --- |
| Deployments file | `deployments/gnosis_mainnet_contracts.json` | `deployments/base_mainnet_contracts.json` |
| Current KAL (rollback target) | `0x38b54901f0ADE112Fd9002024dbdd0DB3D7321B5` | `0x38b54901f0ADE112Fd9002024dbdd0DB3D7321B5` |
| Hub | `0x882D0BF07F956b1b94BBfe9E77F47c6fc7D4EC8f` | `0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13` |
| Deploy command | `npx hardhat deploy --network gnosis_mainnet` | `npx hardhat deploy --network base_mainnet` |
| Env | `RPC_GNOSIS_MAINNET`, `EVM_PRIVATE_KEY_GNOSIS_MAINNET` | `RPC_BASE_MAINNET`, `EVM_PRIVATE_KEY_BASE_MAINNET` |

Both mainnets currently record the **same** KAL address; confirm you are reading the
right deployments file before flipping any flag.

Mainnet-specific additions:

- The drain in §4 must cover the full operator fleet publishing to that chain, not just
  one node. There is no way to enumerate third-party nodes from this repo — announce the
  rotation window ahead of time.
- `environment: 'mainnet'` (`hardhat.node.config.ts:69-84`) still routes through
  `998_initialize_contracts.ts`, so the Hub repoint is the same single owner-signed
  transaction. Gas price is pinned per network in that config.
- Hub ownership on mainnet is expected to be a multisig (`Hub._checkOwnerOrMultiSigOwner`
  accepts any owner of the owning multisig — `Hub.sol:281-300`). Collecting signatures
  takes time the drain window has to absorb. **Signer roster and threshold:
  `TBD (ops-owned)`.**
