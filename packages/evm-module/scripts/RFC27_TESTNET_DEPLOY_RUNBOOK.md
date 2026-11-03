# OT-RFC-27 testnet deploy runbook (Base Sepolia)

How to deploy the OT-RFC-27 contract stack to Base Sepolia
(`base_sepolia_v10`), keep the query/inference pool running, and switch it off
and on again in an emergency.

The figures come from the fork rehearsal,
`scripts/rfc27-testnet-fork-rehearsal.ts`, which runs this deploy through the
repository's own pipeline against a local anvil fork of Base Sepolia, and sends
the Hub owner's transactions as the impersonated owner:

- the deploy, the Hub owner's transactions and the emergency switch at block
  54,034,008;
- the first claims and the upkeep calls at block 53,990,314.

The gas of a first claim grows with every epoch (step 4). The deploy and the
Hub owner's transactions cost the same at both blocks.

## What the deploy changes

| Contract | Version | Deploy step |
|---|---|---|
| `ConvictionServiceStorage` | new, 1.2.0 | 052c |
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
     26.2M gas. The network reads its key from `EVM_PRIVATE_KEY_BASE_SEPOLIA_V10`
     (`utils/network.ts`; without it, it falls back to a mnemonic) and the
     endpoint from `RPC_BASE_SEPOLIA_V10` (`https://sepolia.base.org` when
     unset);
   - **the Hub owner**: a hardware wallet, for the two transactions of step 3.

## 2. The deploy

1. In `deployments/base_sepolia_v10_contracts.json`, set `"deployed": false`
   for `PublishingConviction`, `StakingV10` and `StakingKPI`, so that the run
   redeploys them.
   - If `StakingV10` is left deployed, 052e stops the run before any
     transaction. StakingV10 10.0.4 splits every epoch without the
     query/inference pool, so each epoch's share of the pool would stay in the
     vault for good.
   - If `StakingKPI` is left deployed, 052e only warns. StakingKPI 10.0.2's
     reward views leave the pool out, so they read low; no TRAC is at risk.
     Redeploy it all the same.
2. From `packages/evm-module`, run `npm run deploy:testnet`, which is
   `hardhat deploy --network base_sepolia_v10 --config hardhat.node.config.ts`.
3. The run deploys 10 contracts from the deployer, 26,159,642 gas in all:

   | Contract | Gas |
   |---|---|
   | `StakingV10` | 5,065,799 |
   | `PublishingConviction` | 4,285,448 |
   | `QueryInferenceSettlement` | 3,791,691 |
   | `ServiceSubscriptions` | 3,790,729 |
   | `QueryInferenceStorage` | 1,886,655 |
   | `StakingV10Ledger` | 1,855,388 |
   | `ServiceSubscriptionsWallet` | 1,845,093 |
   | `ConvictionServiceStorage` | 1,698,612 |
   | `StakingKPI` | 1,426,952 |
   | `ConvictionWithdrawalStorage` | 513,275 |

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
| 1 | The Hub transaction 998 printed: `Hub.setAndReinitializeContracts`, 3,972 bytes of calldata | 3,139,196 | 3,154,484 | 4,000,000 |
| 2 | `Hub.forwardCall(QueryInferenceStorage, setActivationEpoch(currentEpoch + 1))` | 120,604 | 122,551 | 200,000 |

- Transaction 1 registers the 7 new contracts, points the Hub at the 3
  redeployed ones, calls `initialize()` on 30 contracts, and forwards the
  parameters of `deployments/parameters.json` "testnet": 5 calls to
  `QueryInferenceStorage` and 1 to `ConvictionServiceStorage`.
- Transaction 2 sets the activation epoch: the first epoch whose rewards
  include the pool, and the first in which periods can be funded.
  - Before transaction 1 it reverts `InvalidTargetContract`, because the Hub
    does not hold `QueryInferenceStorage` yet.
  - The storage refuses it too (`PoolNotWired`) while the Hub's
    `QueryInferenceSettlement` or `StakingV10` does not read the storage.
  - Afterwards, `activationEpoch()` is the current epoch + 1 and
    `closedThrough()` is the current epoch.

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
- The rehearsal sends these same commands to its fork, with `--unlocked
  --from` the impersonated owner in place of `--ledger`.

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
- A claim costs about 94k gas per scored epoch in the rehearsal. StakingV10
  10.1.0 documents about 92k per scored epoch before the pool, and about 107k
  after.
- Set the gas limit by hand, under Base's per-transaction cap of
  2^24 = 16,777,216: a few percent above the smallest gas limit that the
  rehearsal on `main` measures. Wallets that pad their own estimate can take a
  claim this size over the cap, and the network refuses such a transaction.
  anvil does not enforce the cap, so the rehearsal compares every transaction
  with it.

The rehearsal at block 53,990,314 (epoch 659), each position's claim measured
as the first on its node, through `DKGStakingConvictionNFT.claim`, which runs
the same claim as `claimFor`:

| Node | Tokens | Scored epochs | Gas used | Smallest gas limit |
|---|---|---|---|---|
| 1 | 3, 5 | 133 | 12,518,656 | 12,716,878 |
| 4 | 1 | 128 | 12,023,836 | 12,214,606 |
| 5 | 4 | 125 | 11,746,066 | 11,932,820 |
| 3 | 2, 6 | 117 | 11,151,222 | 11,328,081 |
| 12 | 11 | 34 | 3,850,242 | 3,911,096 |
| 13 | 10 | 14 | 2,115,384 | 2,149,025 |
| 11 | 9 | 0 | 693,423 | 704,418 |

- For a node with two positions, the row gives the larger of the two.
- Node 1, the longest history, had about 4.06M gas of room under the cap:
  about 43 more scored epochs, at one epoch a day.
- Its withdrawal, which claims first, took 12,838,969 gas, with a smallest gas
  limit of 13,109,364.

## 5. Upkeep

Once the upgrade is live, the cron makes these calls from any funded wallet.
All of them are permissionless.

1. **`QueryInferenceSettlement.closeEpochs(maxSteps)`: new, and required at
   least every 32 epochs.**
   - A claim closes at most `maxCloseStepsPerClaim` epochs on its way (32 on
     testnet). Once the close is further behind, every claim and withdrawal
     reverts `QueryInferenceCloseBehind` until someone calls `closeEpochs`.
   - Call it each epoch, after the epoch starts, with `maxSteps` of 32 or
     more.
   - Rehearsal: 94,419 gas for 2 epochs, and 1,447,535 gas for 35.
2. `PublishingConviction.settleMany(accountIds)`, new in 10.2.0: each epoch,
   over the Conviction Accounts.
   - It books every billing window that has closed. A window booked late keeps
     its curve, but the curve starts in the current epoch.
   - Rehearsal: 235,237 gas for one account (`settle`).
3. `QueryInferenceSettlement.finalizeClaims(refs)`, new: each epoch.
   - In epoch e + 1, finalize the claims on the periods of epoch e, after
     their batch deadline (the end of e plus the receipt grace, 3,600 s) and
     before e + 1 ends. A seller's claim that is not finalized by the end of
     e + 1 is void.
   - The refs are the `(subscriptionId, bucketIndex, seller)` of the
     `ReceiptsClaimed` events of e's periods.
   - Rehearsal: 296,404 gas for 4 claims.
4. `StakingV10.claimFor(tokenId)`: each position at least every 100 scored
   epochs, so that no claim outgrows the 2^24 cap (step 4).
5. `StakingV10.claimWithdrawnEpoch(tokenId)`, new in 10.1.0: for each
   `WithdrawnEpochRecorded(tokenId, staker, epoch)` event, once that epoch has
   ended.
   - It pays the withdrawn position's share of the epoch that was in progress
     at its withdrawal, in TRAC, to the staker.
   - Before the epoch ends it reverts `WithdrawnEpochInProgress`; a second
     call reverts `NoWithdrawnEpoch`.
   - Rehearsal: 156,412 gas.

## 6. Emergency: switching the pool off

Replacing `QueryInferenceSettlement` with a fixed deployment is the first
choice. Register the fixed contract as "Switching on again" does below, and
nothing is stranded. The switch is the last resort, while no fix is ready.

### Switching off

1. Stop your own upkeep calls first (step 5), and any automatic claims.
2. From the Hub owner's wallet, `Hub.removeContractByName("QueryInferenceSettlement")`:
   64,416 gas. Never `removeContractByAddress` (below).
3. From the Hub owner's wallet,
   `Hub.forwardCall(QueryInferenceStorage, setPaused(true))`: 40,978 gas.

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
- No receipt batch or finalization goes through, and no epoch closes:
  `QueryInferenceStorage` refuses the removed settlement
  (`UnauthorizedAccess`). `closedThrough` and the carry stay as they were.

What the switch strands:

- **Claims made while it is off lose the pool share for good.**
  - The first claim on a node splits each epoch of that node once, without the
    pool, and every later claim on the node reuses that split, closed epochs
    included.
  - `claimFor` is permissionless, so one claim by anyone strands the pool share
    of a whole node.
  - In the rehearsal, one claim on node 1 during the outage fixed node 1's net
    of the pool epoch without its pool gross of 2.331 TRAC. That claim itself
    paid 0.0519 TRAC less than the same claim with the switch on.
- **Sellers lose R for work whose deadline passes during the outage.** No
  batch can be submitted, and a seller's claim that is not finalized by the
  end of its due epoch is void. The money is not lost: it carries forward.

So keep the outage short.

### Switching on again

1. Any wallet deploys a fresh `QueryInferenceSettlement`, with the Hub's
   address as its only constructor argument: 3,791,691 gas.
   - A fresh deployment registers whatever the Hub's order.
   - The removed address cannot be registered again if it was the Hub's last
     entry when it was removed (`AddressAlreadyInSet`). After any earlier
     re-registration it always is.
2. From the Hub owner's wallet, one Hub transaction registers the fresh
   settlement, initializes it and unpauses the storage, the way 998 registers
   contracts: 450,187 gas. Unpausing in the same transaction leaves no moment
   with funding open and no settlement registered.

   ```sh
   FRESH=0x...   # the fresh deployment
   SIG='setAndReinitializeContracts((string,address)[],(string,address)[],address[],(string,bytes[])[])'
   ARGS=("[(QueryInferenceSettlement,$FRESH)]" "[]" "[$FRESH]" "[(QueryInferenceStorage,[$(cast calldata 'setPaused(bool)' false)])]")
   cast call $HUB "$SIG" "${ARGS[@]}" --from $HUB_OWNER --rpc-url $RPC
   cast send $HUB "$SIG" "${ARGS[@]}" --from $HUB_OWNER --ledger --gas-limit 600000 --rpc-url $RPC
   ```

3. If more than 32 epochs passed, call `closeEpochs` before claims resume:
   until then every claim reverts `QueryInferenceCloseBehind`.

The fresh settlement reads the same `QueryInferenceStorage`, so the closes,
the carry and every frozen epoch are kept. In the rehearsal:

- closed through epoch 662 with a carry of 2 TRAC, before the switch, during
  the outage and after it;
- the next `closeEpochs` (94,401 gas) closed the epoch that ended during the
  outage, with that carry carried in;
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
  service draw (`ServiceFundingPausedTreasuryWired`), so Conviction Account
  funding of service periods would stop.
- The receipt grace, `QueryInferenceStorage.receiptGraceSeconds` (3,600 s on
  testnet), stays at or under half an epoch (an epoch is 86,400 s on
  testnet). A period's batch deadline, its end plus the grace, has to fall in
  the first half of its due epoch, so that its claims are finalized in the
  second half. `setReceiptGraceSeconds` refuses more (`InvalidParameter`).

## 8. After the deploy

- Open a PR with the `deployments/base_sepolia_v10_contracts.json` that the
  deploy wrote: the 10 new addresses and versions, with `deployed: true`.
- The rehearsal never writes that file. It works on a scratch copy under
  `cache/rfc27-fork/`.
