# Profile 10.1.0 (`updateNodeId`) rollout

Profile 10.1.0 adds `updateNodeId(uint72 identityId, bytes nodeId)`, so an
identity can point its profile `nodeId` at the node's real libp2p peer id.
Upgraded daemons then fix their own nodeId (see "After the deploy").
It also bounds every nodeId Profile writes (`createProfile`,
`recreateProfile` and `updateNodeId`) at `MAX_NODE_ID_LENGTH` = 64 bytes.

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

Existing nodeIds (read 2026-09-24, every identity up to `lastIdentityId`, plus
the cached nodeId of every ring member):

| Network | Block | Identities | With a profile | Ring | Longest nodeId |
|---|---|---|---|---|---|
| `base_sepolia_v10` | 47,217,512 | 18 | 18 | 7 | 32 bytes |
| `base_mainnet` | 51,706,967 | 65 | 6 (60–65) | 5 | 32 bytes |
| `gnosis_mainnet` | 48,405,326 | 72 | 11 (62–72) | 11 | 32 bytes |

No nodeId, in ProfileStorage or in the ring cache, is longer than 64 bytes.
The identities without a profile (1–59 on Base, 1–61 on Gnosis) all have an
admin key and none is in the ring, so `recreateProfile` lets them choose any
nodeId up to 64 bytes. A ring member must repeat its cached nodeId in
`recreateProfile`; step 1 below re-checks that every cached value still fits.

On both mainnets the Hub owner is a classic multisig wallet (not a Safe): it
has 3 owners, requires 2 confirmations, and executes one call per transaction
through `submitTransaction(destination, value, data)`
(Base `0x4Cd6467b797846E63a27c92350d040C428394068`, Gnosis
`0xBF92638301f5d4c98c0B06750181B99E20F87F17`). `Hub.setAndReinitializeContracts`
is `onlyOwnerOrMultiSigOwner`, so an EOA that is one of the multisig's owners
can send it directly. Otherwise, submit it through the multisig (see the
manual path below).

## Order

1. `base_sepolia_v10` first. Let a few upgraded testnet cores restart and
   confirm their nodeIds become peer ids (`dkg identity node-id`).
2. `base_mainnet`.
3. `gnosis_mainnet`.

## Per network

Run from `packages/evm-module/` with the network's RPC and deploy key
configured (`RPC_<NETWORK>`, and the key `utils/network.ts` reads for it).

1. Re-check that no nodeId is longer than 64 bytes. Profile 10.0.2 stays
   unbounded until this deploy, so a longer one could have appeared since the
   read above. Read-only; use the network's `RPC_<NETWORK>` endpoint and Hub
   (public endpoints throttle bursts of calls):

   ```bash
   RPC="$RPC_BASE_MAINNET" HUB=0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13 node -e '
     const { ethers } = require("ethers");
     (async () => {
       const provider = new ethers.JsonRpcProvider(process.env.RPC);
       const hub = new ethers.Contract(process.env.HUB, ["function getContractAddress(string) view returns (address)"], provider);
       const at = async (name, abi) => new ethers.Contract(await hub.getContractAddress(name), abi, provider);
       const ids = await at("IdentityStorage", ["function lastIdentityId() view returns (uint72)"]);
       const ps = await at("ProfileStorage", ["function getNodeId(uint72) view returns (bytes)"]);
       const sts = await at("ShardingTableStorage", [
         "function nodesCount() view returns (uint72)",
         "function indexToIdentityId(uint72) view returns (uint72)",
         "function getNode(uint72) view returns (tuple(uint256 hashRingPosition, bytes nodeId, uint72 index, uint72 identityId))",
       ]);
       const over = [];
       let longest = 0;
       const check = (where, id, nodeId) => {
         const length = ethers.dataLength(nodeId);
         longest = Math.max(longest, length);
         if (length > 64) over.push(`${where} ${id}: ${length} bytes`);
       };
       const last = await ids.lastIdentityId();
       for (let id = 1n; id <= last; id++) check("ProfileStorage", id, await ps.getNodeId(id));
       const count = await sts.nodesCount();
       for (let i = 0n; i < count; i++) {
         const id = await sts.indexToIdentityId(i);
         check("ring cache", id, (await sts.getNode(id)).nodeId);
       }
       console.log(`identities ${last}, ring ${count}, longest nodeId ${longest} bytes`);
       if (over.length > 0) {
         console.error(over.join("\n"));
         process.exit(1);
       }
     })();
   '
   ```

   If it lists anything, record those identities; the deploy can go ahead.
   Nothing live breaks. The one path such a ring member loses is
   `recreateProfile` (which must repeat its cached nodeId) after a
   ProfileStorage redeploy, until it runs `updateNodeId` to a shorter value
   after this deploy, which also refreshes its ring entry. An upgraded core's
   startup reconcile does that by itself: a nodeId longer than 64 bytes is
   never a peer id, so it counts as legacy and is replaced.

2. Compile:

   ```bash
   npx hardhat compile
   ```

3. Force only `Profile` through the deploy helper (replace `NETWORK`):

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

4. Deploy:

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

5. Verify:

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

6. Commit the post-deploy registry (`deployments/<network>_contracts.json`
   with the new address, `version: "10.1.0"`, `deployed: true`) in a follow-up
   PR, as for earlier single-contract redeploys.

### Manual path (multisig transaction)

If the deploy wallet is not one of the multisig's owners:

1. Deploy the Profile artifact from any funded wallet with the Hub address as
   the only constructor argument.
2. Through the multisig (`submitTransaction(hub, 0, data)`, then a second
   owner confirms), call
   `Hub.setAndReinitializeContracts([["Profile", <newProfile>]], [], [<newProfile>], [])`.
   Only the new Profile needs `initialize()`.
3. Verify as in step 5, then record the address in the registry.

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

Through the multisig (or directly from one of its owners), re-register the
previous Profile:
`Hub.setAndReinitializeContracts([["Profile", <oldProfile>]], [], [<oldProfile>], [])`.
nodeIds that were already updated stay in `ProfileStorage`. That is harmless:
10.0.2 reads and writes them the same way, and the ring stays consistent
because every update re-inserted its node.

## Releasing a squatted nodeId (Hub owner)

Profile creation is not whitelisted on either mainnet, so anyone can register
a profile whose nodeId is someone else's peer id. The victim's `updateNodeId`
then reverts with `NodeIdAlreadyExists`, and `dkg identity node-id` shows the
conflict and, when the holder is in the sharding table, its identity.

The Hub owner can release the value without a new entry point.
`ProfileStorage.setNodeId` is `onlyContracts`, which also admits `hub.owner()`,
so it takes ONE multisig transaction:

- `ProfileStorage.setNodeId(squatterId, <unique placeholder>)`, for example
  the UTF-8 bytes of `revoked-<squatterId>`, after checking
  `nodeIdsList(placeholder)` is false.

This releases the peer id at once, and the victim then runs
`dkg identity sync-node-id`. If the squatter is a sharding-table member, its
cached ring entry (`ShardingTableStorage` nodeId and position) keeps the old
bytes until the squatter is next re-inserted: its own next `updateNodeId`, or
a stake exit and re-entry. That is harmless today. Ring position has no
effect in V10 Phase A, `getShardingTable()` reads nodeIds from ProfileStorage,
and `recreateProfile` for the squatter's own identity is the only reader of
the cache.

Do **not** send `ShardingTable.removeNode` / `insertNode` as separate multisig
transactions to "re-sync" the ring. `removeNode` does not check membership, so
if the squatter leaves the ring (for example by unstaking) before the multisig
transaction executes, it corrupts the index table. An atomic, membership-checked
`onlyHubOwner` entry point on Profile is the recommended follow-up.

The evm-module test "squatting remedy" (`test/unit/Profile.updateNodeId.test.ts`)
runs this single call from a Hub owner that is not a registered contract.
