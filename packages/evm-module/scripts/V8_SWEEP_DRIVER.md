# V8 → V10 sweep driver (migration cutover)

`scripts/v8-sweep-driver.ts` drains **every** V8 position into V10 migration
credit, signed by the Hub owner:

- **delegator stake** (+ pending withdrawals) → the delegator's credit, via
  `DKGStakingConvictionNFT.adminDrainBatch` over `(delegator, node)` pairs;
- **operator fees** (resting `operatorFeeBalance` + any open fee-withdrawal
  request) → the operator's **same** credit bucket, via
  `adminDrainOperatorFeesBatch` over `(node, operator)` pairs.

This driver is the only path that empties V8, so completeness is the whole game,
and the success criterion is a **physically empty StakingStorage vault**
(`balanceOf(SS) ≤ dust`) before the V8 `Staking` contract is unregistered.

## Why it's complete (not "enumerate and hope")

- **Delegator fast path:** `DelegatorsInfo.getDelegators(id)` — cheap, but **not
  guaranteed to list every delegator on its own**, so use it only as a fast first
  pass and rely on the complete recovery below to catch the rest.
- **Complete recovery:** every V8 stake did
  `token.transferFrom(staker, StakingStorage, …)` ([`archive/Staking.sol:148`](../contracts/archive/Staking.sol#L148)),
  so **`Token.Transfer(to = StakingStorage)` from the `StakingStorage` deploy
  block is the complete delegator-address universe** (a superset — non-delegator
  senders read 0 stake and are skipped). The driver scans it whenever there's an
  active-stake gap (`enumerated active < getTotalStake`) or leftover vault TRAC,
  collects the candidate `from` set, and probes each candidate's stake across all
  nodes. Set `EVENT_SCAN_FROM` to the SS deploy block; the full scan needs an
  **archive RPC** (public endpoints cap `getLogs` at ~2000 blocks).
- **Backstop for the residual tail:** a position grown *purely* from restaked
  rewards has no fresh deposit `Transfer` (reward TRAC comes from the epoch pool),
  so even the Transfer scan can miss it. The on-chain **`selfMigrate`** lets any
  such straggler drain their own stake (keyed by `keccak256(msg.sender)`) — so no
  one is ever stranded even if enumeration misses them. (Admin-push stays primary;
  `selfMigrate` is insurance, not a reason to ship a weaker scanner.)
- **Operator fees are enumerated id-keyed** over every node 1..`lastIdentityId`
  (`getOperatorFeeBalance` + `getOperatorFeeWithdrawalRequestAmount`), so
  *finding* a fee needs no address and is complete by construction. To *drain*
  one, the fee folds into the operator's `migrationCredit`, which is
  **address-keyed** — but `IdentityStorage` stores key *hashes*, not addresses,
  so the operator address is **supplied off-chain** (`OPERATOR_MAP`) and
  **validated on-chain** (`keyHasPurpose(id, keccak256(operator), ADMIN_KEY)`).
  A stale/wrong address reverts in the contract; a fee-bearing node with no
  resolvable current admin is a **preflight blocker** (see below).
- **Correctness oracle = the vault balance.** Stranded stake/pending/fee TRAC
  physically sits in the `StakingStorage` vault until `transferStake` moves it,
  so it is *always* inside `balanceOf(SS)`. The drain moves **all three**
  (stake + pending + fees) SS→CSS, so at completion `balanceOf(SS) == 0` (≤
  dust). This **empty-vault gate cannot be falsely-green** — its only failure
  mode is a non-empty vault, which the driver reports as INCOMPLETE.
- **Idempotent:** `drainV8ToCredit` / `drainOperatorFeeToCredit` zero the V8 slot
  and return 0 on re-drain; both batch fns skip zero. Chunks are re-run-safe
  across crashes/reorgs — no progress file is needed for correctness.

## Operator addresses (`OPERATOR_MAP`)

Operator fees credit an **address**, but the chain only stores
`keccak256(adminKey)`. Supply a curated `identityId → current-admin-address` map
(the known node set; admin keys may have rotated since `createProfile`, so use
the *current* admin). The driver validates each entry on-chain and **refuses to
credit** any address that is not a current `ADMIN_KEY` holder.

```bash
# inline JSON …
OPERATOR_MAP='{"3":"0xabc…","7":"0xdef…"}'
# … or a file
OPERATOR_MAP_FILE=./operators.base.json
```

Any fee-bearing node missing from the map (or whose mapped address fails the
on-chain admin check) is listed as an **unresolved operator** and blocks
`MODE=execute`. Resolve them (the cutover cannot complete with stranded fees) —
do not work around it.

## Run (per chain)

Plan first (no transactions — enumerate + decompose + report):

```bash
MODE=plan \
TARGET_HUB=0x<freezeHub> \
OPERATOR_MAP='{"<id>":"0x<admin>", …}' \
npx hardhat run scripts/v8-sweep-driver.ts --network <chain>
```

The plan prints the vault decomposition (active stake / pending / operator fees),
the drainable counts, the chunk counts, and — if anything is unenumerable or
unresolved — a 🔴 **ACTIVE-STAKE GAP**, **UNATTRIBUTED VAULT TRAC**, or
**UNRESOLVED OPERATOR(S)**. Resolve every flag before executing.

Then execute (signer **must** be the Hub owner / multisig owner):

```bash
MODE=execute [CHUNK_SIZE=150] \
TARGET_HUB=0x<freezeHub> \
OPERATOR_MAP='{"<id>":"0x<admin>", …}' \
npx hardhat run scripts/v8-sweep-driver.ts --network <chain>
```

`MODE=execute` **hard-fails preflight before sending any transaction** if there
is an active-stake gap, unattributed vault TRAC beyond `DUST_TOLERANCE`, a
degraded `DelegatorAdded` scan, or an unresolved operator — so a red plan can
never become a half-finished sweep needing manual reconciliation.
(`OVERRIDE_PREFLIGHT=1` forces a known-incomplete partial sweep; not
recommended.) After the chunks land it verifies: per-node `getNodeStake(id)==0`
**and** operator fee `==0` for all ids, `getTotalStake()==0`, the SS→CSS
reconcile (`drained == stake + pending + fees`), and the **empty-vault gate**
`balanceOf(SS) ≤ DUST_TOLERANCE`. It prints `✅ SWEEP COMPLETE` only when all
hold; otherwise `❌ INCOMPLETE` (re-run — idempotent — or resolve the residual).

**Hard prerequisite:** deploy onto each chain's **V8-stake-holding Hub** (the one
that already holds that chain's V8 stake), not a fresh Hub — else there's
no V8 stake to read. Address overrides (`TARGET_SS`, `TARGET_NFT`,
`TARGET_DELEGATORS_INFO`, `TARGET_IDENTITY_STORAGE`, `TARGET_TOKEN`) are accepted
when contracts aren't resolvable via the Hub.

## Cutover sequence (freeze-FIRST)

1. Deploy the migration contracts (CSS, StakingV10, DKGStakingConvictionNFT) onto
   the freeze Hub; set `convictionCreditSeconds`.
2. **Unregister the V8 `Staking` contract first** (freeze). The drain reads/writes
   `StakingStorage` directly via `StakingV10` (not through V8 `Staking` logic), so
   draining still works — but freezing first stops users from staking/withdrawing
   and operators from `finalize`/`restake`-ing fees **mid-sweep**, against the
   very balances being drained. The driver asserts `Staking` is unregistered and
   aborts otherwise.
3. `MODE=plan` per chain — review the decomposition; resolve every gap and every
   unresolved operator (fill `OPERATOR_MAP`).
4. `MODE=execute` per chain — sweep to `✅ COMPLETE`. The **empty-vault** gate
   `balanceOf(SS) ≤ dust` (which now includes operator fees) is the release
   gate: the vault being empty is what certifies the cutover may proceed.

## Limitations / not done

- **Signing:** the driver uses an **EOA** (`accounts[0]`). Production's Hub owner
  is a Custodian **multisig** — `buildCalldata` is intentionally separated from
  `submitChunk` so a propose-to-Safe adapter swaps in without a rewrite.
- **`OPERATOR_MAP` is curated input.** The driver validates each address on-chain
  but cannot itself enumerate operator addresses (they are not on-chain). The
  preflight blocker guarantees no fee is silently stranded, but assembling the
  current-admin map per chain is an operational prerequisite.
- **Validated on a local node only** (multi-delegator/multi-node incl. a
  recovered pending-only delegator + a node operator fee that drains the vault to
  0, a deliberately-injected unenumerable delegator flagged INCOMPLETE, and an
  unresolved-operator case that hard-blocks `execute` with no tx sent). Measured
  ~98–130k gas/pair on cold storage — real freeze-Hub drains get SSTORE refunds.
- **NOT run against production.** Deploy onto the real freeze Hubs + an external
  audit remain a gate before this moves real TRAC.
