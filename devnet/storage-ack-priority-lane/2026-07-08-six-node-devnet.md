# StorageACK Priority Lane Six-Node Devnet Receipt

Date: 2026-07-08

Worktree: `/private/tmp/dkg-v9-storageack-priority-lane`
Branch: `codex/storageack-priority-lane`
Code under test: `6dd150e16 feat(agent): add sync backpressure controls`
Node runtime: `/Users/otlegend/.nvm/versions/node/v24.11.1/bin/node`

## Local Validation Before Devnet

- `node_modules/.bin/tsc -p packages/core/tsconfig.json`: passed
- `node_modules/.bin/tsc -p packages/storage/tsconfig.json`: passed
- `node_modules/.bin/tsc -p packages/publisher/tsconfig.json`: passed
- `node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit`: passed
- `node_modules/.bin/tsc -p packages/storage/tsconfig.json --noEmit`: passed
- `node_modules/.bin/tsc -p packages/publisher/tsconfig.json --noEmit`: passed
- `node_modules/.bin/tsc -p packages/agent/tsconfig.json --noEmit`: passed
- `node_modules/.bin/tsc -p packages/cli/tsconfig.json --noEmit`: passed
- `packages/publisher` focused Vitest suite: 4 files, 33 tests passed
- `packages/agent` focused Vitest suite: 3 files, 30 tests passed
- `packages/storage` scheduler/Blazegraph focused Vitest suite: 2 files, 24 tests passed
- `packages/storage/test/sparql-http.test.ts`: 1 file, 24 tests passed
- `pnpm run build:runtime`: passed

## Six-Node Devnet Startup

Command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DEVNET_DIR=/private/tmp/dkg-v9-storageack-priority-lane-devnet5 \
HARDHAT_PORT=18685 \
API_PORT_BASE=20001 \
LIBP2P_PORT_BASE=21001 \
DEVNET_OXIGRAPH_BASE=30000 \
UI_PORT=58713 \
./scripts/devnet.sh start 6
```

Result:

- Hardhat RPC: `http://127.0.0.1:18685`
- `minimumRequiredSignatures` set to `3`
- Docker was unavailable, so the run used the no-Docker fallback matrix:
  - Nodes 1-2: managed `oxigraph-server`
  - Nodes 3-4: in-process `oxigraph`
  - Nodes 5-6: in-process `oxigraph-worker`
- Four core nodes were staked with 50k TRAC and had asks set.
- `devnet-test` registered on-chain as context graph `v10Id=1`.
- `devnet-isolation` registered on-chain as context graph `v10Id=2`.
- Both registered context graphs were visible from all six nodes before the smoke publish.

Node status after publish:

| Node | Role | API | Peer suffix | Connected peers | Chain |
| --- | --- | --- | --- | ---: | --- |
| 1 | core | `20001` | `CnhQvHFH` | 5 | `evm:31337` |
| 2 | core | `20002` | `zQdL1pH` | 5 | `evm:31337` |
| 3 | core | `20003` | `By1yjSgXn` | 5 | `evm:31337` |
| 4 | core | `20004` | `Whm4M8AB` | 5 | `evm:31337` |
| 5 | edge | `20005` | `9RGCRWSM` | 5 | `evm:31337` |
| 6 | edge | `20006` | `v4CaCzjo` | 5 | `evm:31337` |

## Publish Smoke

Create, finalize, and share command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DKG_HOME=/private/tmp/dkg-v9-storageack-priority-lane-devnet5/node1 \
node packages/cli/dist/cli.js ka create storageack-priority-smoke-20260708-devnet5 \
  --context-graph-id devnet-test \
  --share \
  --subject urn:test:storageack-priority:20260708 \
  --predicate urn:test:predicate \
  --object storageack-priority-devnet-smoke
```

Create/share result:

- Name: `storageack-priority-smoke-20260708-devnet5`
- Status: `swm-shared`
- Merkle root: `0x01f84ecd6a2f0893780d9e6a1a5c9881a220e3ed15394427ed6b8cc1c3446fad`
- Share operation: `mrc6q4iy-ruomds`

Publish command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DKG_HOME=/private/tmp/dkg-v9-storageack-priority-lane-devnet5/node1 \
node packages/cli/dist/cli.js ka publish storageack-priority-smoke-20260708-devnet5 \
  --context-graph-id devnet-test \
  --json
```

Publish result:

- Status: `confirmed`
- Block: `511`
- KA ID: `60925804536711341357542305993070848128372638707196826702571953143795106709504`
- UAL: `did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/60925804536711341357542305993070848128372638707196826702571953143795106709504`
- Transaction: `0x57561fe1043ebbcb9f9ac827e5173b2c575234cd40ed562960e641f1d3f6ebbd`

## StorageACK Evidence

Node 1 log evidence:

```text
2026-07-08 16:40:34 [ACKCollector] Collecting ACKs via direct P2P (merkleRoot=0x01f84ecd6a2f0893...)
2026-07-08 16:40:34 [ACKCollector] Selected 5/5 ACK candidate peer(s) (protocol=/dkg/10.0.1/storage-ack, need=3).
2026-07-08 16:40:34 [ACKCollector] Requesting ACKs from 5 core peers (need 3)
2026-07-08 16:40:35 [ACKCollector] Valid ACK from y1yjSgXn (identity=3, signer=0x3A024529... source=member)
2026-07-08 16:40:35 [ACKCollector] Valid ACK from Whm4M8AB (identity=4, signer=0x13CE2c5e... source=member)
2026-07-08 16:40:35 [ACKCollector] Valid ACK from YzQdL1pH (identity=2, signer=0xC970B47E... source=member)
2026-07-08 16:40:35 [ACKCollector] Collected 3 ACKs successfully
2026-07-08 16:40:35 [DKGPublisher] V10: Collected 3 core node ACKs [y1yjSgXn:member, Whm4M8AB:member, YzQdL1pH:member]
2026-07-08 16:40:35 [DKGPublisher] On-chain confirmed: UAL=did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/60925804536711341357542305993070848128372638707196826702571953143795106709504 batchId=60925804536711341357542305993070848128372638707196826702571953143795106709504 tx=0x57561fe1043ebbcb9f9ac827e5173b2c575234cd40ed562960e641f1d3f6ebbd
```

Handler registration evidence:

- Node 1 registered V10 StorageACK handler with identity `1`.
- Node 2 registered V10 StorageACK handler with identity `2`.
- Node 3 registered V10 StorageACK handler with identity `3`.
- Node 4 registered V10 StorageACK handler with identity `4`.
- Nodes 5 and 6 were edge nodes and skipped StorageACK handler registration as expected.

## Six-Node Read-Back

Read-back command shape:

```json
{
  "contextGraphId": "devnet-test",
  "view": "verifiable-memory",
  "sparql": "ASK WHERE { <urn:test:storageack-priority:20260708> <urn:test:predicate> ?o . }"
}
```

Result from all six node APIs:

| Node | HTTP | ASK result |
| --- | ---: | --- |
| 1 | 200 | `true` |
| 2 | 200 | `true` |
| 3 | 200 | `true` |
| 4 | 200 | `true` |
| 5 | 200 | `true` |
| 6 | 200 | `true` |

## Post-ACK-Fallback Fix Devnet Rerun - 2026-07-08

Purpose: validate branch commit `05b2af1d2` after restoring ACK fallback candidate retention. This specifically checks that a quorum-sized confirmed tier is ranked first but does not truncate connected fallback candidates out of the live collector pool.

Local validation before devnet:

- `pnpm --filter @origintrail-official/dkg-publisher build`: passed
- `pnpm exec vitest run test/ack-peer-selection.test.ts` from `packages/publisher`: passed, 12 tests
- `pnpm exec vitest run test/ack-candidate-pool.test.ts` from `packages/agent`: passed, 14 tests
- `pnpm run build:runtime`: passed; Vite emitted the existing `MOCK_SUBGRAPHS` export/chunk-size warnings only

Fresh devnet command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DEVNET_DIR=/private/tmp/dkg-v9-storageack-priority-lane-devnet9 \
HARDHAT_PORT=18725 \
API_PORT_BASE=20401 \
LIBP2P_PORT_BASE=21401 \
DEVNET_OXIGRAPH_BASE=30400 \
UI_PORT=58753 \
./scripts/devnet.sh start 6
```

Startup result:

- Hardhat RPC: `http://127.0.0.1:18725`
- Auth token: `Yr9h6eSuOt84zjPqAga6VNtKPkJwcUNSKZCIoDGh0`
- Hub: `0x5FbDB2315678afecb367f032d93F642f64180aa3`
- `minimumRequiredSignatures` set to `3`
- Docker was unavailable, so the run used the no-Docker fallback matrix:
  - Nodes 1-2: managed `oxigraph-server`
  - Nodes 3-4: in-process `oxigraph`
  - Nodes 5-6: `oxigraph-worker`
- `devnet-test` registered on-chain as context graph `v10Id=1`.
- `devnet-isolation` registered on-chain as context graph `v10Id=2`.
- Both registered context graphs were visible from all six nodes before the smoke publish.

Node status:

| Node | Role | API | Peer suffix | Connected peers | Store backend | Commit |
| --- | --- | --- | --- | ---: | --- | --- |
| 1 | core | `20401` | `3jAyK8cz` | 5 | `oxigraph-server` | `05b2af1d` |
| 2 | core | `20402` | `uKTthcYN` | 5 | `oxigraph-server` | `05b2af1d` |
| 3 | core | `20403` | `1nq5es1C` | 5 | `oxigraph` | `05b2af1d` |
| 4 | core | `20404` | `vPUZ5Edr` | 5 | `oxigraph` | `05b2af1d` |
| 5 | edge | `20405` | `PVYptTBg` | 5 | `oxigraph-worker` | `05b2af1d` |
| 6 | edge | `20406` | `nKekMwUz` | 5 | `oxigraph-worker` | `05b2af1d` |

Handler registration evidence:

- Nodes 1-4 registered V10 StorageACK handlers with identities `1`, `2`, `3`, and `4`.
- Nodes 5 and 6 skipped StorageACK handler registration because they are edge nodes.

First publish smoke:

- KA name: `storageack-fallback-smoke-20260708-devnet9`
- Subject: `urn:test:storageack-priority:20260708:devnet9`
- Merkle root: `0x0a8ecaa7ea1e2b5dbb50d7ff6f9d0284c94e2ec51936512673729926668ae182`
- Status: `confirmed`
- Block: `470`
- KA ID: `78842365123416863761786640173251160541596886427289119031537627204190675664896`
- UAL: `did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/78842365123416863761786640173251160541596886427289119031537627204190675664896`
- Transaction: `0x3ddb24a1243700e3ef7f3fe3398e8481e71c51517da548518614f96cb123861f`

StorageACK evidence from node 1:

```text
2026-07-08 19:41:53 [ACKCollector] Selected 5/5 ACK candidate peer(s) (required=3, protocol=/dkg/10.0.1/storage-ack, selected=uKTthcYN:rest,1nq5es1C:rest,vPUZ5Edr:rest,PVYptTBg:rest,nKekMwUz:rest, filtered=none)
2026-07-08 19:41:53 [ACKCollector] Requesting ACKs from 5 core peers (need 3)
2026-07-08 19:41:53 [ACKCollector] Valid ACK from 1nq5es1C (identity=3, signer=0x6b84Eb7e... source=member)
2026-07-08 19:41:53 [ACKCollector] Valid ACK from vPUZ5Edr (identity=4, signer=0xa459Ed0d... source=member)
2026-07-08 19:41:53 [ACKCollector] Valid ACK from uKTthcYN (identity=2, signer=0x6E6F84B2... source=member)
2026-07-08 19:41:53 [ACKCollector] Collected 3 ACKs successfully
2026-07-08 19:41:53 [DKGPublisher] V10: Collected 3 core node ACKs [1nq5es1C:member, vPUZ5Edr:member, uKTthcYN:member]
2026-07-08 19:41:53 [DKGPublisher] On-chain confirmed: UAL=did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/78842365123416863761786640173251160541596886427289119031537627204190675664896 batchId=78842365123416863761786640173251160541596886427289119031537627204190675664896 tx=0x3ddb24a1243700e3ef7f3fe3398e8481e71c51517da548518614f96cb123861f
2026-07-08 19:41:55 [ACKCollector] Quorum already settled - abandoning transport retry for PVYptTBg: substrate queued (transport): Protocol selection failed - could not negotiate /dkg/10.0.1/storage-ack
2026-07-08 19:41:55 [ACKCollector] Quorum already settled - abandoning transport retry for nKekMwUz: substrate queued (transport): Protocol selection failed - could not negotiate /dkg/10.0.1/storage-ack
```

Read-back for the first asset initially returned `false` on node 3 while sync was still settling. A retry after five seconds returned `true` from all six node APIs.

Second publish smoke, after mesh/identify settle:

- KA name: `storageack-fallback-smoke-20260708-devnet9b`
- Subject: `urn:test:storageack-priority:20260708:devnet9b`
- Merkle root: `0x4e804b67902c8857329c4e83dc05ed9dd2df3d148af9039131ed57f3163cc9ff`
- Status: `confirmed`
- Block: `569`
- KA ID: `78842365123416863761786640173251160541596886427289119031537627204190675664897`
- UAL: `did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/78842365123416863761786640173251160541596886427289119031537627204190675664897`
- Transaction: `0x7a85852cb8b664e2e046ebcf46af45c15f9e950e3a39621a664691b4f06ec6a6`

StorageACK evidence from node 1:

```text
2026-07-08 19:43:20 [ACKCollector] Selected 5/5 ACK candidate peer(s) (required=3, protocol=/dkg/10.0.1/storage-ack, selected=uKTthcYN:confirmedCore,1nq5es1C:confirmedCore,vPUZ5Edr:confirmedCore,PVYptTBg:rest,nKekMwUz:rest, filtered=none)
2026-07-08 19:43:20 [ACKCollector] Requesting ACKs from 5 core peers (need 3)
2026-07-08 19:43:21 [ACKCollector] Valid ACK from 1nq5es1C (identity=3, signer=0x6b84Eb7e... source=member)
2026-07-08 19:43:21 [ACKCollector] Valid ACK from vPUZ5Edr (identity=4, signer=0xa459Ed0d... source=member)
2026-07-08 19:43:21 [ACKCollector] Valid ACK from uKTthcYN (identity=2, signer=0x6E6F84B2... source=member)
2026-07-08 19:43:21 [ACKCollector] Collected 3 ACKs successfully
2026-07-08 19:43:21 [DKGPublisher] V10: Collected 3 core node ACKs [1nq5es1C:member, vPUZ5Edr:member, uKTthcYN:member]
2026-07-08 19:43:21 [DKGPublisher] On-chain confirmed: UAL=did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/78842365123416863761786640173251160541596886427289119031537627204190675664897 batchId=78842365123416863761786640173251160541596886427289119031537627204190675664897 tx=0x7a85852cb8b664e2e046ebcf46af45c15f9e950e3a39621a664691b4f06ec6a6
2026-07-08 19:43:22 [ACKCollector] Quorum already settled - abandoning transport retry for PVYptTBg: substrate queued (transport): Protocol selection failed - could not negotiate /dkg/10.0.1/storage-ack
2026-07-08 19:43:22 [ACKCollector] Quorum already settled - abandoning transport retry for nKekMwUz: substrate queued (transport): Protocol selection failed - could not negotiate /dkg/10.0.1/storage-ack
```

Read-back for the second asset:

| Node | HTTP | ASK result |
| --- | ---: | --- |
| 1 | 200 | `true` |
| 2 | 200 | `true` |
| 3 | 200 | `true` |
| 4 | 200 | `true` |
| 5 | 200 | `true` |
| 6 | 200 | `true` |

Disposition:

- The second publish exercised the relevant live behavior: `confirmedCore` peers were ranked first, but the connected fallback candidates remained selected (`5/5`, required `3`) instead of being truncated at quorum.
- Edge nodes do not implement `/dkg/10.0.1/storage-ack`; their transport retries failed after quorum had already settled, which is expected in this no-Docker six-node fallback topology.
- The exact stale/quorum-sized identify metadata regression is covered by the focused selector and agent tests. This devnet receipt proves the built runtime uses the retained-fallback candidate pool and still completes V10 StorageACK publish/readback across all six nodes.
- Devnet was stopped after the run; `./scripts/devnet.sh status` reported Hardhat and nodes 1-6 `STOPPED`.

## Post-#1532 Rebase Rerun - 2026-07-08

Purpose: repeat the six-node StorageACK priority-lane smoke after rebasing
`codex/storageack-priority-lane` onto `main` at
`6a91a16db fix(sync,storage): oversize-literal boot sweep + producer guards (OT-RFC-56 Fix 2 & 3 -> main) (#1532)`.

Code under test:

- `6822b622b fix(publisher): bound ack decline log messages`
- Branch: `codex/storageack-priority-lane`
- Runtime commit reported by all six node APIs: `6822b622`

Conflict disposition during rebase:

- `packages/agent/src/dkg-agent-base.ts` kept the main branch oversize-literal guard and preserved priority-aware store insertion options.
- `packages/agent/src/dkg-agent-lifecycle.ts` kept the main branch oversize-literal guard/tombstoning and preserved background-priority sync/backpressure wrappers.

Validation before rerun:

- `pnpm run build:runtime`: passed

Fresh devnet command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DEVNET_DIR=/private/tmp/dkg-v9-storageack-priority-lane-devnet8 \
HARDHAT_PORT=18715 \
API_PORT_BASE=20301 \
LIBP2P_PORT_BASE=21301 \
DEVNET_OXIGRAPH_BASE=30300 \
UI_PORT=58743 \
./scripts/devnet.sh start 6
```

Startup result:

- Hardhat RPC: `http://127.0.0.1:18715`
- `minimumRequiredSignatures` set to `3`
- Docker was unavailable, so the run used the no-Docker fallback matrix:
  - Nodes 1-2: managed `oxigraph-server`
  - Nodes 3-4: in-process `oxigraph`
  - Nodes 5-6: in-process `oxigraph-worker`
- Four core nodes were staked with 50k TRAC and had asks set.
- `devnet-test` registered on-chain as context graph `v10Id=1`.
- `devnet-isolation` registered on-chain as context graph `v10Id=2`.
- Both registered context graphs were visible from all six nodes before the smoke publish.

Node status after publish:

| Node | Role | API | Peer suffix | Connected peers | Store backend | Chain | Commit |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 1 | core | `20301` | `uimtogc1` | 5 | `oxigraph-server` | `evm:31337` | `6822b622` |
| 2 | core | `20302` | `wCbgnTri` | 5 | `oxigraph-server` | `evm:31337` | `6822b622` |
| 3 | core | `20303` | `rbnVq8JY` | 5 | `oxigraph` | `evm:31337` | `6822b622` |
| 4 | core | `20304` | `7UZyGrBi` | 5 | `oxigraph` | `evm:31337` | `6822b622` |
| 5 | edge | `20305` | `naXCrH93` | 5 | `oxigraph-worker` | `evm:31337` | `6822b622` |
| 6 | edge | `20306` | `DYuVLxzQ` | 5 | `oxigraph-worker` | `evm:31337` | `6822b622` |

Create, finalize, and share command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DKG_HOME=/private/tmp/dkg-v9-storageack-priority-lane-devnet8/node1 \
DKG_API_PORT=20301 \
DKG_NO_BLUE_GREEN=1 \
node packages/cli/dist/cli.js ka create storageack-priority-smoke-20260708-devnet8 \
  --context-graph-id devnet-test \
  --share \
  --subject urn:test:storageack-priority:20260708:devnet8 \
  --predicate urn:test:predicate \
  --object storageack-priority-devnet-smoke-rerun-post-1532
```

Create/share result:

- Name: `storageack-priority-smoke-20260708-devnet8`
- Status: `swm-shared`
- Merkle root: `0xfe3da759580d4e6f1509980b26cc8d7e8498555f2f357f9f915ee3d3aa062da7`
- Share operation: `mrcbgszd-j7a7s2`

Publish command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DKG_HOME=/private/tmp/dkg-v9-storageack-priority-lane-devnet8/node1 \
DKG_API_PORT=20301 \
DKG_NO_BLUE_GREEN=1 \
node packages/cli/dist/cli.js ka publish storageack-priority-smoke-20260708-devnet8 \
  --context-graph-id devnet-test \
  --json
```

Publish result:

- Status: `confirmed`
- Block: `457`
- KA ID: `31802553612409110147400160117539291587049415395332293760138796083312079142912`
- UAL: `did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/31802553612409110147400160117539291587049415395332293760138796083312079142912`
- Assertion URI: `did:dkg:context-graph:devnet-test/assertion/0x464f9B82aAc9e973Fb97C444963150Ff92F799B2/storageack-priority-smoke-20260708-devnet8`
- Transaction: `0x1b02a007801cb7578a91a00d7b72c98f31e70395a92a2b6bee58b89055241e24`

StorageACK evidence from node 1:

```text
2026-07-08 18:53:18 [ACKCollector] Collecting ACKs via direct P2P (merkleRoot=0xfe3da759580d4e6f...)
2026-07-08 18:53:18 [ACKCollector] Selected 5/5 ACK candidate peer(s) (required=3, protocol=/dkg/10.0.1/storage-ack, selected=wCbgnTri:rest,rbnVq8JY:rest,7UZyGrBi:rest,naXCrH93:rest,DYuVLxzQ:rest, filtered=none)
2026-07-08 18:53:18 [ACKCollector] Requesting ACKs from 5 core peers (need 3)
2026-07-08 18:53:18 [ACKCollector] Valid ACK from 7UZyGrBi (identity=4, signer=0x1E35CF4D... source=member)
2026-07-08 18:53:18 [ACKCollector] Valid ACK from rbnVq8JY (identity=3, signer=0xe9cB2C1c... source=member)
2026-07-08 18:53:18 [ACKCollector] Valid ACK from wCbgnTri (identity=2, signer=0x96c06436... source=member)
2026-07-08 18:53:18 [ACKCollector] Collected 3 ACKs successfully
2026-07-08 18:53:18 [DKGPublisher] V10: Collected 3 core node ACKs [7UZyGrBi:member, rbnVq8JY:member, wCbgnTri:member]
2026-07-08 18:53:18 [DKGPublisher] On-chain confirmed: UAL=did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/31802553612409110147400160117539291587049415395332293760138796083312079142912 batchId=31802553612409110147400160117539291587049415395332293760138796083312079142912 tx=0x1b02a007801cb7578a91a00d7b72c98f31e70395a92a2b6bee58b89055241e24
```

Handler registration evidence:

- Node 1 registered V10 StorageACK handler with identity `1`.
- Node 2 registered V10 StorageACK handler with identity `2`.
- Node 3 registered V10 StorageACK handler with identity `3`.
- Node 4 registered V10 StorageACK handler with identity `4`.
- Nodes 5 and 6 were edge nodes and skipped StorageACK handler registration as expected.

Read-back command shape:

```json
{
  "contextGraphId": "devnet-test",
  "view": "verifiable-memory",
  "sparql": "ASK WHERE { <urn:test:storageack-priority:20260708:devnet8> <urn:test:predicate> ?o . }"
}
```

Result from all six node APIs:

| Node | HTTP | ASK result |
| --- | ---: | --- |
| 1 | 200 | `true` |
| 2 | 200 | `true` |
| 3 | 200 | `true` |
| 4 | 200 | `true` |
| 5 | 200 | `true` |
| 6 | 200 | `true` |

Notes:

- A first post-rebase devnet start on `/private/tmp/dkg-v9-storageack-priority-lane-devnet7` completed startup, but the shell-managed background processes were cleaned up when the command exited. The recorded receipt above is from `/private/tmp/dkg-v9-storageack-priority-lane-devnet8`, which was kept alive through the publish and read-back probes.
- The generated `packages/evm-module/deployments/localhost_contracts.json` diff was left unstaged because it is a local devnet deployment side effect.

## Notes

- A plain `/api/query` without `view: "verifiable-memory"` only surfaced the smoke triple on node 1. The correct VM read path for this test is the explicit `verifiable-memory` view.
- The generated `packages/evm-module/deployments/localhost_contracts.json` diff was left unstaged because it is a local devnet deployment side effect.
- Temporary `node_modules` symlinks were also left unstaged; they were used only so this clean worktree could reuse the already-installed dependency tree from `/Users/otlegend/projects/dkg-v9`.

## Rebase Rerun - 2026-07-08

Purpose: repeat the six-node StorageACK priority-lane smoke after rebasing
`codex/storageack-priority-lane` onto `origin/main` at
`1f0d57118 fix: sever agents/_meta from the sync plane (Tier 1 -- mainnet sync-storm relief) (#1526)`.

Pre-receipt code under test:

- `6133ff73c test(devnet): record storage ack priority six-node smoke`
- `8aa058484 feat(agent): add sync backpressure controls`
- `06a5326d8 feat(publisher): prioritize storage ack handling`
- `64659febb feat(storage): add priority store scheduler`

Validation before rerun:

- `pnpm install --frozen-lockfile --store-dir /Users/otlegend/projects/dkg-v9/.pnpm-store`: passed
- `pnpm run build:runtime`: passed

Fresh devnet command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DEVNET_DIR=/private/tmp/dkg-v9-storageack-priority-lane-devnet6 \
HARDHAT_PORT=18695 \
API_PORT_BASE=20101 \
LIBP2P_PORT_BASE=21101 \
DEVNET_OXIGRAPH_BASE=30100 \
UI_PORT=58723 \
./scripts/devnet.sh start 6
```

Startup result:

- Hardhat RPC: `http://127.0.0.1:18695`
- `minimumRequiredSignatures` set to `3`
- Docker was unavailable, so the run used the no-Docker fallback matrix:
  - Nodes 1-2: managed `oxigraph-server`
  - Nodes 3-4: in-process `oxigraph`
  - Nodes 5-6: in-process `oxigraph-worker`
- Four core nodes were staked with 50k TRAC and had asks set.
- `devnet-test` registered on-chain as context graph `v10Id=1`.
- `devnet-isolation` registered on-chain as context graph `v10Id=2`.
- Both registered context graphs were visible from all six nodes before the smoke publish.

Node status after publish:

| Node | Role | API | Peer suffix | Connected peers | Chain |
| --- | --- | --- | --- | ---: | --- |
| 1 | core | `20101` | `HfwZYoiw` | 5 | `evm:31337` |
| 2 | core | `20102` | `b3AqWuwv` | 5 | `evm:31337` |
| 3 | core | `20103` | `GPFqG5wg` | 5 | `evm:31337` |
| 4 | core | `20104` | `sfbPaaAo` | 5 | `evm:31337` |
| 5 | edge | `20105` | `pFzH1rvk` | 5 | `evm:31337` |
| 6 | edge | `20106` | `MbCigZFC` | 5 | `evm:31337` |

Create, finalize, and share command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DKG_HOME=/private/tmp/dkg-v9-storageack-priority-lane-devnet6/node1 \
node packages/cli/dist/cli.js ka create storageack-priority-smoke-20260708-devnet6 \
  --context-graph-id devnet-test \
  --share \
  --subject urn:test:storageack-priority:20260708:devnet6 \
  --predicate urn:test:predicate \
  --object storageack-priority-devnet-smoke-rerun
```

Create/share result:

- Name: `storageack-priority-smoke-20260708-devnet6`
- Status: `swm-shared`
- Merkle root: `0x7b07e3e8442e613b84f741d0504440b6d171d494ecc1b8ab2c025f18ab54a144`
- Share operation: `mrc89bbz-xbzejl`

Publish command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DKG_HOME=/private/tmp/dkg-v9-storageack-priority-lane-devnet6/node1 \
node packages/cli/dist/cli.js ka publish storageack-priority-smoke-20260708-devnet6 \
  --context-graph-id devnet-test \
  --json
```

Publish result:

- Status: `confirmed`
- Block: `457`
- KA ID: `17780653607465831313448336904752238123646344621951817177127594600371117359104`
- UAL: `did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/17780653607465831313448336904752238123646344621951817177127594600371117359104`
- Transaction: `0x57d90d9c628a500cbd965171cf806c48d9aa29a09e3cef0b57c845f9ca22be08`

StorageACK evidence from node 1:

```text
2026-07-08 17:23:30 [ACKCollector] Collecting ACKs via direct P2P (merkleRoot=0x7b07e3e8442e613b...)
2026-07-08 17:23:30 [ACKCollector] Selected 5/5 ACK candidate peer(s) (required=3, protocol=/dkg/10.0.1/storage-ack, selected=b3AqWuwv:rest,GPFqG5wg:rest,sfbPaaAo:rest,pFzH1rvk:rest,MbCigZFC:rest, filtered=none)
2026-07-08 17:23:30 [ACKCollector] Requesting ACKs from 5 core peers (need 3)
2026-07-08 17:23:30 [ACKCollector] Valid ACK from GPFqG5wg (identity=3, signer=0x47aB143d... source=member)
2026-07-08 17:23:30 [ACKCollector] Valid ACK from b3AqWuwv (identity=2, signer=0xa3eec76B... source=member)
2026-07-08 17:23:30 [ACKCollector] Valid ACK from sfbPaaAo (identity=4, signer=0xAdfB5E8b... source=member)
2026-07-08 17:23:30 [ACKCollector] Collected 3 ACKs successfully
2026-07-08 17:23:30 [DKGPublisher] V10: Collected 3 core node ACKs [GPFqG5wg:member, b3AqWuwv:member, sfbPaaAo:member]
2026-07-08 17:23:30 [DKGPublisher] On-chain confirmed: UAL=did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/17780653607465831313448336904752238123646344621951817177127594600371117359104 batchId=17780653607465831313448336904752238123646344621951817177127594600371117359104 tx=0x57d90d9c628a500cbd965171cf806c48d9aa29a09e3cef0b57c845f9ca22be08
```

Handler registration evidence:

- Node 1 registered V10 StorageACK handler with identity `1`.
- Node 2 registered V10 StorageACK handler with identity `2`.
- Node 3 registered V10 StorageACK handler with identity `3`.
- Node 4 registered V10 StorageACK handler with identity `4`.
- Nodes 5 and 6 were edge nodes and skipped StorageACK handler registration as expected.

Read-back command shape:

```json
{
  "contextGraphId": "devnet-test",
  "view": "verifiable-memory",
  "sparql": "ASK WHERE { <urn:test:storageack-priority:20260708:devnet6> <urn:test:predicate> ?o . }"
}
```

Result from all six node APIs:

| Node | HTTP | ASK result |
| --- | ---: | --- |
| 1 | 200 | `true` |
| 2 | 200 | `true` |
| 3 | 200 | `true` |
| 4 | 200 | `true` |
| 5 | 200 | `true` |
| 6 | 200 | `true` |
