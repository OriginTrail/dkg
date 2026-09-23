# Profile 10.1.0 (`updateNodeId`) rollout

Profile 10.1.0 adds `updateNodeId(uint72 identityId, bytes nodeId)`, so an
identity can point its profile `nodeId` at the node's real libp2p peer id.
Upgraded daemons then fix their own nodeId (see "After the deploy").

Only the **Profile logic contract** changes. `ProfileStorage` (which already has
`setNodeId`), `ShardingTable` and `ShardingTableStorage` stay as deployed, and
no state is migrated. Nothing else caches the Profile address: every caller
resolves it from the Hub, and the storage contracts check `onlyContracts`
against the Hub at call time. Registering the new Profile in the Hub and
initializing it is enough.

A `_VERSION` bump does not redeploy anything by itself. `hre.helpers.deploy()`
reuses any contract whose registry entry says `deployed: true`, so the entry
must be flipped by hand (same as `KA_HIGH_WATER_GETTER_ROLLOUT_RUNBOOK.md`).

## Live state before the rollout (read 2026-09-23)

| Network | Hub | Profile | ProfileStorage | ShardingTable |
|---|---|---|---|---|
| `base_sepolia_v10` | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` | `0x175f876984802e4e898a47A420ACD0107A5f4a0E` (10.0.2) | 10.0.4 | 10.0.3 |
| `base_mainnet` | `0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13` | `0x370943487c766633Da68DB4048E57674a7a6c076` (10.0.2) | `0x98B045daeFFDA88741EEa76C18abAecaF14175eF` (10.0.4) | `0xa4F4f1e61f2BE32E92Fd1D07558a3DB5b519D288` (10.0.3) |
| `gnosis_mainnet` | `0x882D0BF07F956b1b94BBfe9E77F47c6fc7D4EC8f` | `0x370943487c766633Da68DB4048E57674a7a6c076` (10.0.2) | `0x98B045daeFFDA88741EEa76C18abAecaF14175eF` (10.0.4) | `0xa4F4f1e61f2BE32E92Fd1D07558a3DB5b519D288` (10.0.3) |

On both mainnets the Hub owner is a contract (the Safe).
`Hub.setAndReinitializeContracts` is `onlyOwnerOrMultiSigOwner`, so the deploy
wallet must be one of the Safe's owners, or the registration step must be
submitted as a Safe transaction (see the manual path below).

## Order

1. `base_sepolia_v10` first. Let a few upgraded testnet cores restart and
   confirm their nodeIds become peer ids (`dkg identity node-id`).
2. `base_mainnet`.
3. `gnosis_mainnet`.

## Per network

Run from `packages/evm-module/` with the network's RPC and deploy key
configured (`RPC_<NETWORK>`, and the key `utils/network.ts` reads for it).

1. Compile:

   ```bash
   npx hardhat compile
   ```

2. Force only `Profile` through the deploy helper (replace `NETWORK`):

   ```bash
   NETWORK=base_mainnet node -e '
     const fs = require("fs");
     const p = `deployments/${process.env.NETWORK}_contracts.json`;
     const j = JSON.parse(fs.readFileSync(p, "utf8"));
     const c = j.contracts.Profile;
     if (!c) throw new Error(`Profile missing from ${p}`);
     if (c.version !== "10.0.2") throw new Error(`Expected Profile 10.0.2, got ${c.version}`);
     c.deployed = false;
     fs.writeFileSync(p, JSON.stringify(j, null, 4) + "\n");
     console.log("Marked Profile for redeploy.");
   '
   ```

3. Deploy:

   ```bash
   npx hardhat deploy --network base_mainnet --config hardhat.node.config.ts
   ```

   The helper deploys `Profile(hub)` and queues it as a new contract. Then
   `998_initialize_contracts` sends one
   `Hub.setAndReinitializeContracts([{ name: "Profile", addr }], [], <initializable contracts>, <parameter calls>)`.
   That transaction:

   - registers the new Profile under `"Profile"`. The Hub sets the old
     Profile's `status` to false, and because the Hub no longer lists the old
     address, it loses `onlyContracts` access to storage.
   - runs `initialize()` on the new Profile, which resolves `ShardingTable`
     for `updateNodeId`. The other initializable contracts are re-initialized
     too, which only re-reads the same Hub addresses.
   - applies any `deployments/parameters.json` value that differs from the
     chain. The deploy log prints `Encoded data for parameters settings`;
     that list must be empty, or contain only changes you intend.

4. Verify:

   ```bash
   PROFILE=<contracts.Profile.evmAddress from the updated registry>
   cast call "$HUB" 'getContractAddress(string)(address)' Profile --rpc-url "$RPC"   # == $PROFILE
   cast call "$PROFILE" 'version()(string)' --rpc-url "$RPC"                          # 10.1.0
   cast call "$PROFILE" 'MAX_NODE_ID_LENGTH()(uint256)' --rpc-url "$RPC"              # 64
   cast call "$PROFILE" 'shardingTable()(address)' --rpc-url "$RPC"                   # == Hub's ShardingTable
   cast call "$OLD_PROFILE" 'status()(bool)' --rpc-url "$RPC"                         # false
   ```

   From any upgraded node on that network, `dkg identity node-id` should report
   `Profile contract: v10.1.0 at <new address>, can update nodeIds`.

5. Commit the post-deploy registry (`deployments/<network>_contracts.json`
   with the new address, `version: "10.1.0"`, `deployed: true`) in a follow-up
   PR, as for earlier single-contract redeploys.

### Manual path (Safe transaction)

If the deploy wallet is not a Safe owner:

1. Deploy the Profile artifact from any funded wallet with the Hub address as
   the only constructor argument.
2. From the Safe, call
   `Hub.setAndReinitializeContracts([["Profile", <newProfile>]], [], [<newProfile>], [])`.
   Only the new Profile needs `initialize()`.
3. Verify as in step 4, then record the address in the registry.

## After the deploy

- Daemons from this release run a startup reconcile on core nodes: if the
  profile nodeId is not a peer id (the legacy random bytes), the node sends
  `updateNodeId` once with its operational key. It never overwrites a nodeId
  that already names a different peer id; it only warns.
  `syncProfileNodeId: false` in the node config disables it.
- Operators can check and fix the nodeId by hand with `dkg identity node-id`
  and `dkg identity sync-node-id`.
- Before the deploy, the same daemons log one info line
  (`needs Profile >= 10.1.0`) and send nothing.
- Each update of a sharding-table member removes and re-inserts the node:
  about 0.24M gas, plus about 11.5k per node shifted by the two re-index
  passes. At today's ring sizes (5 on Base, 11 on Gnosis) that is at most
  about 0.5M gas. The worst case at the 500-node cap is about 11.7M gas,
  which fits Gnosis's 17M block gas limit (measured in
  `test/unit/Profile.updateNodeId.test.ts`).

## Rollback

From the Safe, re-register the previous Profile:
`Hub.setAndReinitializeContracts([["Profile", <oldProfile>]], [], [<oldProfile>], [])`.
nodeIds that were already updated stay in `ProfileStorage`. That is harmless:
10.0.2 reads and writes them the same way, and the ring stays consistent
because every update re-inserted its node.

## Releasing a squatted nodeId (Hub owner)

Profile creation is not whitelisted on either mainnet, so anyone can register
a profile whose nodeId is someone else's peer id. The victim's `updateNodeId`
then reverts with `NodeIdAlreadyExists`, and `dkg identity node-id` shows the
conflict and, when the holder is in the sharding table, its identity.

The Hub owner can move the squatter off the value without a new entry point.
`ProfileStorage.setNodeId` and `ShardingTable.removeNode` / `insertNode` are
`onlyContracts`, which also admits `hub.owner()`. Batch these calls in ONE
Safe transaction (MultiSend) so the ring is never inconsistent:

1. `ShardingTable.removeNode(squatterId)`, only if
   `ShardingTableStorage.nodeExists(squatterId)` is true
2. `ProfileStorage.setNodeId(squatterId, <unique placeholder>)`, for example
   the UTF-8 bytes of `revoked-<squatterId>`, after checking
   `nodeIdsList(placeholder)` is false
3. `ShardingTable.insertNode(squatterId)`, only if step 1 ran

The victim then runs `dkg identity sync-node-id`. The evm-module test
"squatting remedy" (`test/unit/Profile.updateNodeId.test.ts`) exercises
exactly this sequence from a Hub owner that is not a registered contract.
