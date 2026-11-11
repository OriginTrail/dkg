# OT-RFC-27 testnet deploy runbook (Base Sepolia)

How to deploy the OT-RFC-27 contract stack to Base Sepolia
(`base_sepolia_v10`), keep the query/inference pool running, and switch it off
and on again in an emergency.

The figures come from the fork rehearsal,
`scripts/rfc27-testnet-fork-rehearsal.ts`, which runs this deploy through the
repository's own pipeline against a local anvil fork of Base Sepolia, and sends
the Hub owner's transactions as the impersonated owner, at block 55,196,393.

The gas of a first claim grows with every epoch (step 4).

## What the deploy changes

| Contract | Version | Deploy step |
|---|---|---|
| `ServiceSubscriptionsStorage` | new, 1.2.0 | 052c |
| `ServiceSubscriptions` | new, 1.2.0 | 052d |
| `ServiceSubscriptionsWallet` | new, 1.0.0 | 052d |
| `QueryInferenceStorage` | new, 1.0.0 | 052e |
| `QueryInferenceSettlement` | new, 1.0.0 | 052f |
| `StakingV10Ledger` | new, 1.0.0 | 054a |
| `ConvictionWithdrawalStorage` | new, 1.0.0 | 054b |
| `PublishingConviction` | 10.0.8 → 10.2.0 | 052b |
| `StakingV10` | 10.0.4 → 10.1.0 | 055 |
| `StakingKPI` | 10.0.2 → 10.1.0 | 024 |

Step 998 registers and initializes all of them in one Hub transaction. Step
998b leaves the activation of the pool to the Hub owner, after that
transaction.

## 1. Before the deploy

1. Deploy from `main`, once the whole contract stack has merged.
2. Rerun the rehearsal on `main` at a fresh block first, and deploy only if
   every check passes. Its header lists the commands. It writes nothing
   tracked, its results land in `cache/rfc27-fork/`, and it gives the
   first-claim gas at that block (step 4).
3. Two wallets:
   - **the deployer**: a separate hot wallet with Base Sepolia ETH for about
     25.2M gas. The network reads its key from `EVM_PRIVATE_KEY_BASE_SEPOLIA_V10`
     (`utils/network.ts`; without it, it falls back to a mnemonic) and the
     endpoint from `RPC_BASE_SEPOLIA_V10` (`https://sepolia.base.org` when
     unset);
   - **the Hub owner**: a hardware wallet, for the two transactions of step 3.

## 2. The deploy

1. In `deployments/base_sepolia_v10_contracts.json`, set `"deployed": false`
   for `PublishingConviction`, `StakingV10` and `StakingKPI`, so that the run
   redeploys them.
   - If `StakingV10` is left deployed, the run's first step, 000, stops it
     before it deploys anything. StakingV10 10.0.4 splits every epoch without
     the query/inference pool, so each epoch's share of the pool would stay in
     the vault for good.
   - If `StakingKPI` is left deployed, 052e only warns. StakingKPI 10.0.2's
     reward views leave the pool out, so they read low; no TRAC is at risk.
     Redeploy it all the same.
2. From `packages/evm-module`, run `npm run deploy:testnet`, which is
   `hardhat deploy --network base_sepolia_v10 --config hardhat.node.config.ts`.
   Run every step, and never redeploy by `--tags` on testnet: a run by tag leaves
   out step 998, so what it deploys is recorded as deployed but never registered
   in the Hub, and a later full run does not register it either.
3. The run deploys 10 contracts from the deployer, 25,168,971 gas in all:

   | Contract | Gas |
   |---|---|
   | `StakingV10` | 5,019,220 |
   | `PublishingConviction` | 4,285,448 |
   | `ServiceSubscriptions` | 3,837,852 |
   | `QueryInferenceSettlement` | 2,774,458 |
   | `ServiceSubscriptionsStorage` | 2,142,540 |
   | `StakingV10Ledger` | 1,855,388 |
   | `ServiceSubscriptionsWallet` | 1,842,789 |
   | `StakingKPI` | 1,426,976 |
   | `QueryInferenceStorage` | 1,293,811 |
   | `ConvictionWithdrawalStorage` | 690,489 |

4. At the end, 998 checks whether the deployer may call
   `Hub.setAndReinitializeContracts`:
   - **The deployer is a separate hot wallet (the main path).** 998 does not
     send the Hub transaction. It prints it for the Hub owner: `to` (the Hub),
     `value: 0`, `data`, the decoded steps, and one line
     `[Hub] Hub owner transaction (JSON): {"to":…,"value":"0","data":…}`. The
     contracts are deployed and recorded in the deployments file, but nothing
     registers, initializes or parameterizes them until the Hub owner sends
     it. Send it before any further deploy run on the network: the deployments
     file already records these contracts as deployed, so a later run would
     neither deploy nor register them.
   - **The deployer is the Hub owner**, or one of the owners that a multisig
     Hub owner reports through `getOwners()`. 998 sends the Hub transaction
     itself, at the end of the same run, and prints nothing for the owner.
   - Either way, 998b leaves the activation epoch unset and prints that the Hub
     owner is to set it. The activation is always the Hub owner's own
     transaction (step 3).
5. Step 999 writes the new addresses into
   `deployments/base_sepolia_v10_contracts.json` (step 8).

## 3. The Hub owner's two transactions

From the Hub owner's wallet, one after the other, in the same epoch:

| | Transaction | Gas used | Smallest gas limit | Gas limit to set |
|---|---|---|---|---|
| 1 | The Hub transaction 998 printed: `Hub.setAndReinitializeContracts`, 3,716 bytes of calldata | 3,088,559 | 3,104,166 | 4,000,000 |
| 2 | `Hub.forwardCall(QueryInferenceStorage, setActivationEpoch(currentEpoch + 1))` | 98,109 | 99,679 | 200,000 |

- Transaction 1 registers the 7 new contracts, points the Hub at the 3
  redeployed ones, calls `initialize()` on 30 contracts, and forwards the
  parameters of `deployments/parameters.json` "testnet": 3 calls to
  `QueryInferenceStorage` and 1 to `ServiceSubscriptionsStorage`.
- Transaction 2 sets the activation epoch: the first epoch whose rewards
  include the pool, and the first in which subscriptions can be funded.
  - Before transaction 1 it reverts `InvalidTargetContract`, because the Hub
    does not hold `QueryInferenceStorage` yet.
  - The storage refuses it too (`PoolNotWired`) while the Hub's
    `QueryInferenceSettlement` or `StakingV10` does not read the storage.
  - Afterwards, `activationEpoch()` is the current epoch + 1.

### Signing on a hardware wallet

- Simulate each transaction first, read-only, from the Hub owner's address:
  `cast call … --from <Hub owner>` must return without reverting.
- Set the gas limit by hand, from the table above. Both limits are far under
  Base's per-transaction cap of 2^24 = 16,777,216 gas.
- The Hub transaction carries about 4 KB of calldata that the device cannot
  decode. The device's Ethereum app may need blind signing (contract data)
  enabled for it. Check on the device that the destination is the Hub before
  approving.

**With Foundry's `cast`** (the flags of cast 1.7.1), using `--ledger`, or
`--trezor` in its place:

```sh
cd packages/evm-module
RPC=https://sepolia.base.org   # or another Base Sepolia endpoint
HUB=$(node -p "require('./deployments/base_sepolia_v10_contracts.json').contracts.Hub.evmAddress")
HUB_OWNER=$(cast call $HUB 'owner()(address)' --rpc-url $RPC)
cast wallet address --ledger   # must print $HUB_OWNER

# 1. The Hub transaction. DATA is the "data" field that 998 printed.
DATA=0x...
cast call $HUB --data $DATA --from $HUB_OWNER --rpc-url $RPC
cast send $HUB --data $DATA --from $HUB_OWNER --ledger --gas-limit 4000000 --rpc-url $RPC

# 2. The activation, right after it, in the same epoch.
QIS=$(cast call $HUB 'getContractAddress(string)(address)' QueryInferenceStorage --rpc-url $RPC)
CHRONOS=$(cast call $HUB 'getContractAddress(string)(address)' Chronos --rpc-url $RPC)
E=$(cast call $CHRONOS 'getCurrentEpoch()(uint256)' --rpc-url $RPC | cut -d' ' -f1)
ACT=$(cast calldata 'setActivationEpoch(uint40)' $((E + 1)))
cast call $HUB 'forwardCall(address,bytes)' $QIS $ACT --from $HUB_OWNER --rpc-url $RPC
cast send $HUB 'forwardCall(address,bytes)' $QIS $ACT --from $HUB_OWNER --ledger --gas-limit 200000 --rpc-url $RPC
cast call $QIS 'activationEpoch()(uint40)' --rpc-url $RPC   # E + 1
```

- If the Hub owner is not the device's first account, add
  `--mnemonic-derivation-path "<its path>"` to each command that names the
  device. With `--from` given, cast refuses to sign when the device's account
  at that path is not the Hub owner.
- The rehearsal sends the same two transactions to its fork, from the
  impersonated owner through its own transaction runner, not with these
  commands.

**With MetaMask**, the hardware wallet connected and the Hub owner's account
selected:

- turn on hex data for sends (Settings, Advanced, Show hex data);
- send 0 ETH to the Hub, with `DATA` as the hex data for transaction 1, and the
  output of `cast calldata 'forwardCall(address,bytes)' $QIS $ACT` for
  transaction 2;
- before confirming, set the gas limit by hand in the transaction's advanced
  gas settings;
- simulate each one with `cast call` first, as above.

### The Hub's contract order

After transaction 1, `Hub.getAllContracts()` holds 57 entries.
`QueryInferenceSettlement` is at index 52, and `StakingV10Ledger` is the last
entry. So right after the deploy the settlement is not the last entry. Any
later registration of the settlement appends it, which makes it the last entry:
see step 6 before removing it.

## 4. First claims

Right after the two transactions, call `StakingV10.claimFor(tokenId)` on one
position per node, longest history first.

- The first claim on a node after the upgrade walks every epoch since that
  position's last claim, and splits each epoch's operator fee for the node.
  That makes it the most expensive claim; later claims on the node cost less.
- A claim costs about 95k gas per scored epoch on a node no claim has split yet,
  and about 28k on one already split, in the rehearsal. StakingV10 10.1.0
  documents about 92k per scored epoch before the pool, and about 110k after.
- Nothing has to run before it: a claim only reads the pool, and an epoch's
  numbers are final when it ends.
- Set the gas limit by hand, under Base's per-transaction cap of
  2^24 = 16,777,216: a few percent above the smallest gas limit that the
  rehearsal on `main` measures. Wallets that pad their own estimate can take a
  claim this size over the cap, and the network refuses such a transaction.
  anvil does not enforce the cap, so the rehearsal checks every transaction's
  estimate against it: one that does not fit fails its check, is not sent, and
  the phase exits nonzero.

The rehearsal at block 55,196,393 (epoch 662), each position's claim measured
as the first on its node, through `DKGStakingConvictionNFT.claim`, which runs
the same claim as `claimFor`:

| Node | Tokens | Scored epochs | Gas used | Smallest gas limit |
|---|---|---|---|---|
| 3 | 2, 6 | 120 | 11,423,654 | 11,605,290 |
| 1 | 3, 5 | 136 | 3,898,460 | 3,960,499 |
| 12 | 11 | 34 | 3,862,557 | 3,923,904 |
| 13 | 10 | 14 | 2,127,737 | 2,161,833 |
| 11 | 9 | 0 | 705,790 | 717,227 |
| 4 | 1 | 3 | 678,768 | 689,780 |
| 5 | 4 | 3 | 678,768 | 689,780 |

- For a node with two positions, the row gives the larger of the two.
- Node 3, the heaviest first claim, had about 5.17M gas of room under the cap:
  about 54 more scored epochs, at one epoch a day.
- Claims on testnet have already split most of the epochs of nodes 1, 4 and 5,
  so a first claim costs them less, whatever the position's history.
- The withdrawal of token 5, the longest unclaimed history, which claims first,
  took 4,121,684 gas, with a smallest gas limit of 4,229,476.

## 5. Upkeep

Once the upgrade is live, the cron makes these calls from any funded wallet.
All of them are permissionless.

An epoch's money, its counted value and its pool are final as soon as it ends, so
nothing has to run for the query/inference pool to pay: these calls only keep
positions and accounts up to date.

1. `PublishingConviction.settleMany(accountIds)`, new in 10.2.0: each epoch,
   over the Conviction Accounts.
   - It books every billing window that has closed. A window booked late keeps
     its curve, but the curve starts in the current epoch.
   - Rehearsal: 194,964 gas for one account (`settle`).
2. `StakingV10.claimFor(tokenId)`: each position at least every 100 scored
   epochs, so that no claim outgrows the 2^24 cap (step 4). Many fit one
   transaction through Multicall3 `aggregate3` with `allowFailure`, kept under
   the cap by estimating the batch; rewards go to the positions, whoever calls.
3. `StakingV10.claimWithdrawnEpoch(tokenId)`, new in 10.1.0: for each
   `WithdrawnEpochRecorded(tokenId, staker, epoch)` event, once that epoch has
   ended.
   - It pays the withdrawn position's share of the epoch that was in progress
     at its withdrawal, in TRAC, to the staker.
   - Before the epoch ends it reverts `WithdrawnEpochInProgress`; a second
     call reverts `NoWithdrawnEpoch`.
   - Rehearsal: 148,818 gas.

Sellers land their own receipt batches. A batch counts when it lands, up to what
the buyer's budget has left, and the seller's node needs a score in the epoch
first (`NoNodeScore`). A batch for a subscription of an epoch that has ended is refused
(`GroupFault` with `OutsideEpoch`) and never counts, so a seller lands its last
batch before the epoch ends. A group sets `minCounted`, so that it reverts rather
than spend its nonces when the budget has less left than that. With a `minCounted`
of 0 it lands for whatever is left, even nothing, and its nonces stay spent.
`budgetLeft` reads what the budget has left, and a top-up adds to it.

## 6. Emergency: switching the pool off

Replacing `QueryInferenceSettlement` with a fixed deployment is the first
choice. Register the fixed contract as "Switching on again" does below, and
nothing is stranded. The switch is the last resort, while no fix is ready.

### Switching off

1. Stop your own upkeep calls first (step 5), and any automatic claims.
2. From the Hub owner's wallet, `Hub.removeContractByName("QueryInferenceSettlement")`:
   64,416 gas. Never `removeContractByAddress` (below).
3. From the Hub owner's wallet,
   `Hub.forwardCall(QueryInferenceStorage, setPaused(true))`: 40,968 gas.

With the variables of step 3:

```sh
cast send $HUB 'removeContractByName(string)' QueryInferenceSettlement \
  --from $HUB_OWNER --ledger --gas-limit 150000 --rpc-url $RPC
cast send $HUB 'forwardCall(address,bytes)' $QIS $(cast calldata 'setPaused(bool)' true) \
  --from $HUB_OWNER --ledger --gas-limit 150000 --rpc-url $RPC
```

While it is off, as the rehearsal shows:

- `StakingV10` and `StakingKPI` read no pool. Claims and withdrawals go
  through, and pay the publishing pool alone.
- The removal alone leaves both wallet and Conviction Account funding open.
  The pause refuses both (`QueryInferencePaused`).
- No receipt batch goes through: `QueryInferenceStorage` refuses the removed
  settlement (`UnauthorizedAccess`), and with the pause on, the pause refuses it
  first (`QueryInferencePaused`). Every number of an ended epoch stays as it was.

What the switch strands:

- **Claims made while it is off lose the pool share for good.**
  - The first claim on a node splits each epoch of that node once, without the
    pool, and every later claim on the node reuses that split.
  - `claimFor` is permissionless, so one claim by anyone strands the pool share
    of a whole node.
  - In the rehearsal, one claim on node 1 during the outage fixed node 1's net
    of the pool epoch without its pool gross of 2.331 TRAC. That claim itself
    paid 0.0519 TRAC less than the same claim with the switch on.
- **Sellers lose R for work whose epoch ends during the outage.** No batch can
  be submitted, and a batch for an epoch that has ended never counts. The money
  is not lost: an epoch with no value rolls it forward to the next with value.

So keep the outage short.

### Switching on again

1. Any wallet deploys a fresh `QueryInferenceSettlement`, with the Hub's
   address as its only constructor argument: 2,774,458 gas.
   - A fresh deployment registers whatever the Hub's order.
   - The removed address cannot be registered again if it was the Hub's last
     entry when it was removed (`AddressAlreadyInSet`). After any earlier
     re-registration it always is.
2. From the Hub owner's wallet, one Hub transaction registers the fresh
   settlement, initializes it and unpauses the storage, the way 998 registers
   contracts: 450,011 gas. Unpausing in the same transaction leaves no moment
   with funding open and no settlement registered.

   ```sh
   FRESH=0x...   # the fresh deployment
   SIG='setAndReinitializeContracts((string,address)[],(string,address)[],address[],(string,bytes[])[])'
   ARGS=("[(QueryInferenceSettlement,$FRESH)]" "[]" "[$FRESH]" "[(QueryInferenceStorage,[$(cast calldata 'setPaused(bool)' false)])]")
   cast call $HUB "$SIG" "${ARGS[@]}" --from $HUB_OWNER --rpc-url $RPC
   cast send $HUB "$SIG" "${ARGS[@]}" --from $HUB_OWNER --ledger --gas-limit 600000 --rpc-url $RPC
   ```

The fresh settlement reads the same `QueryInferenceStorage`, so every count, all
the money and every ended epoch are kept, and nothing has to catch up. In the
rehearsal:

- the pool epoch's pool and each seller's gross read the same before the switch,
  during the outage and after it;
- a batch whose epoch ended during the outage was refused (`OutsideEpoch`);
- the next batch, on the fresh settlement, counted, and its epoch's pool took the
  money that had rolled through the outage;
- a claim on node 3 then split the pool epoch with node 3's pool share, while
  node 1's net of that epoch stayed without its 2.331 TRAC.

### Never remove the settlement by address

- When the removed entry is the Hub's last one, the Hub's contract set leaves
  its name pointing one past the end of the list.
- After `Hub.removeContractByAddress` on the settlement as the last entry,
  `Hub.isContract("QueryInferenceSettlement")` panics (`Panic(0x32)`).
  `StakingV10` makes that lookup on every claim, so every claim and withdrawal
  reverts: the opposite of what the switch is for. Registering the settlement
  again under its own name panics too.
- Right after the deploy, the settlement is not the last entry (index 52 of
  57). After any registration of it, it is.
- If it happens anyway, the Hub owner first registers an entry under another
  name, `Hub.setContractAddress("<new name>", <address>)`, with an address that
  holds no code and no key, such as `0x000000000000000000000000000000000000dEaD`
  (134,070 gas). That restores the lookup, and claims go through again,
  without the pool. Then the settlement can be registered again.
- `removeContractByName` has the mirror image of this, which is harmless to
  claims: when the removed entry was the last one, claims go on, but its
  address cannot be registered again (`AddressAlreadyInSet`), and
  `Hub.isContract(<that address>)` panics. Switching on with a fresh
  deployment avoids it.

The rehearsal's switch phase runs all of this on the fork, in a snapshot it
reverts.

## 7. Constants that stay as they are

- `ParametersStorage.protocolTreasury` stays the zero address. While a
  treasury is wired, `PublishingConviction` refuses every Conviction Account
  service spend (`ServiceFundingPausedTreasuryWired`), so Conviction Account
  funding of service subscriptions would stop.
- λ, `QueryInferenceStorage.lambdaBps` (5,000 on testnet), is taken by an epoch
  when its first value counts, and kept. A change through `setLambdaBps` applies
  to every epoch with no value yet, and moves no other.

## 8. After the deploy

- Open a PR with the `deployments/base_sepolia_v10_contracts.json` that the
  deploy wrote: the 10 new addresses and versions, with `deployed: true`.
- The rehearsal never writes that file. It works on a scratch copy under
  `cache/rfc27-fork/`.

## 9. After the deploy: the smoke test

`scripts/rfc27-testnet-smoke.ts` runs one marketplace cycle on the live
contracts, with real signers and real time, and plays every role. It makes no
Hub owner call. Its header lists every setting; its phases live in
`scripts/rfc27/smoke/`.

```sh
cd packages/evm-module
export RFC27_SMOKE_OWNER_KEY=...    # never printed or stored
export RFC27_SMOKE_SELLER_KEY=...
export RFC27_SMOKE_RUN=smoke-1
SMOKE="npx hardhat run scripts/rfc27-testnet-smoke.ts --network base_sepolia_v10 --config hardhat.node.config.ts"
PHASE=check $SMOKE                  # read-only; prints the plan
PHASE=setup $SMOKE                  # a dry run, as every phase is without SEND=1
PHASE=setup SEND=1 $SMOKE
```

The roles:

- **The owner**: a hot testnet wallet. It opens a new Conviction Account
  under PublishingConviction 10.2.0, opts it in, and adds a buyer. It
  funds a wallet-paid subscription, and stakes a small tier-0 position on the
  seller's node. It also claims that position.
- **The buyers and the session keys**: derived from the owner key and
  the run label, so no key is stored. The owner sends each buyer a little
  ETH.
- **The seller**: one of our testnet Core Nodes, by its operational key. Its
  node also sends proofs from that key. A dedicated second operational key on
  the same identity avoids nonce clashes with them.

What a run needs:

| Variable or balance | Default |
|---|---|
| `RFC27_SMOKE_OWNER_KEY` | required, from the owner wallet |
| `RFC27_SMOKE_SELLER_KEY` | required, an operational key of the seller node |
| `RFC27_SMOKE_RUN` | `smoke`; a new label for each run. The owner has one wallet subscription an epoch, so a second run of the same owner in the same epoch defers to the next, before it spends anything |
| `RPC_BASE_SEPOLIA_V10` | `https://sepolia.base.org` |
| The owner's TRAC | 124: a 72 TRAC account, a 2 TRAC wallet subscription and a 50 TRAC stake. A resumed run needs only what its remaining steps spend |
| The owner's ETH | about 0.001 at a 0.005 gwei base fee, 0.0002 of it for each buyer; `PHASE=check` prints it at the current fee |
| The seller key's ETH | about 0.0001: two receipt batches, about 0.6M gas |

The amounts are configurable: `RFC27_SMOKE_STAKE`, `RFC27_SMOKE_CA_VALUE`,
`RFC27_SMOKE_CA_TOPUP`, `RFC27_SMOKE_EDGE_VALUE`, `RFC27_SMOKE_WALLET_VALUE`,
`RFC27_SMOKE_COMMITTED` and `RFC27_SMOKE_KEY_ETH`.

The phases, with `SEND=1`, across one epoch boundary:

| Phase | When |
|---|---|
| `setup`, then `serve` | epoch E, with at least an hour of it left; `serve` once the seller has proved in E |
| `claim` | from the start of E+1, with nothing run first |
| `withdraw`, optional | in the middle of an epoch, then again once it has ended: another day |

- A phase run too early stops, deferred, and prints when it opens.
- `serve` checks that the seller has a node score in the current epoch, which a
  batch needs (`NoNodeScore`). Until it has, `serve` waits and says so. Run it
  again after the node's next proof, before E ends: a batch lands only during its
  subscription's epoch, so once E has ended `serve` stops, and the run goes no further.
  Start a new one.
- `serve` also shows a batch refused for what its budget has left, with its nonces
  unspent, and the same batch landing after a top-up.
- `claim` needs nothing to run first: an epoch's numbers are final when it ends. It
  requires each of the run's budgets to have counted all the seller claimed on it,
  by its own `ReceiptsLanded` events; the node's and the epoch's sums to be what
  all the groups counted in E add up to; the money booked in E to be exactly what
  the subscriptions of E were funded and topped up with; and every ended epoch's pool to
  be what the rollover rule gives. It checks this before it sends anything, and
  reads up to two epochs of logs to do it, which can take a few minutes on a public
  endpoint.
- These sums read the logs of the contracts registered now. An endpoint that
  serves incomplete logs fails a correct run: run the phase again. A settlement
  or service contract replaced during the run fails it too: start a new one.
- `withdraw` waits until the position holds score in the epoch: without it, a
  withdrawal burns the position and records nothing to claim.
- A phase stopped at any point is run again as it was: it sends nothing the
  journal holds, and its checks read what each transaction did from its own
  receipt, so other transactions in its block, or since, have no part in them.
- A phase with a failed check is not done. It exits nonzero, the phases after it
  refuse to start, and running it again sends nothing it sent already, until its
  checks pass.
- Every transaction's gas estimate must fit under 2^24, or its check fails.
- Each phase prints every check as PASS or FAIL, and writes
  `cache/rfc27-smoke/<run>.<phase>.json`. The run resumes from
  `cache/rfc27-smoke/<run>.json`.

The upkeep cron may run `claimFor` or `claimWithdrawnEpoch` first. The phase then
checks what the cron did, from the chain, and does not fail because another caller
went first.

The smoke test also runs on the fork, before the deploy reaches testnet, with
`--config scripts/rfc27-testnet-fork.config.ts`. Its header lists the fork-only
switches: `FORK_WARP=1` moves the clock, and `FORK_PROOFS=1` stands in for
the seller's proofs, both with `SEND=1` only; `FORK_STOP_AFTER=<step>` stops a
run as a crash would.

`test/rfc27-smoke-resume.test.ts` runs the phases, interrupted and resumed, on
the development deploy on the in-process chain, with no fork.
