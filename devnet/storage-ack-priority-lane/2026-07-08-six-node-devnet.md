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

## Notes

- A plain `/api/query` without `view: "verifiable-memory"` only surfaced the smoke triple on node 1. The correct VM read path for this test is the explicit `verifiable-memory` view.
- The generated `packages/evm-module/deployments/localhost_contracts.json` diff was left unstaged because it is a local devnet deployment side effect.
- Temporary `node_modules` symlinks were also left unstaged; they were used only so this clean worktree could reuse the already-installed dependency tree from `/Users/otlegend/projects/dkg-v9`.
