# StorageACK Priority Lane Full Devnet Receipt

Date: 2026-07-09

Worktree: `/private/tmp/dkg-v9-storageack-priority-lane`
Branch: `codex/storageack-priority-lane`
Code under test: `1a31d0b9f91f0b337632cb63340175b9fa5fd540`
Node runtime: `/Users/otlegend/.nvm/versions/node/v24.11.1/bin/node`

## Build

Command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH pnpm run build:runtime
```

Result: passed.

Notes:

- Vite emitted the existing `MOCK_SUBGRAPHS` export warning.
- Vite emitted existing chunk-size warnings.

## Six-Node Devnet Startup

Command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
UI_PORT=58796 \
./scripts/devnet.sh start 6
```

Result:

- Hardhat RPC: `http://127.0.0.1:8545`
- Four core nodes were staked with 50k TRAC and had asks set.
- `minimumRequiredSignatures` was set to `3`.
- `devnet-test` was registered and visible on all six nodes.
- `devnet-isolation` was registered and visible on all six nodes.
- Docker was unavailable, so the run used the no-Docker fallback matrix:
  - Nodes 1-2: managed `oxigraph-server`
  - Nodes 3-4: in-process `oxigraph`
  - Nodes 5-6: `oxigraph-worker`

Initial API status before the comprehensive run:

| Node | HTTP | Connected peers | Store backend |
| --- | ---: | ---: | --- |
| 1 | 200 | 5 | `oxigraph-server` |
| 2 | 200 | 5 | `oxigraph-server` |
| 3 | 200 | 5 | `oxigraph` |
| 4 | 200 | 5 | `oxigraph` |
| 5 | 200 | 5 | `oxigraph-worker` |
| 6 | 200 | 5 | `oxigraph-worker` |

## Comprehensive Devnet Suite

Command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
UI_PORT=58796 \
SKIP_UI=1 \
RESULTS_DIR=/private/tmp/dkg-v9-storageack-priority-lane/.devnet/comprehensive-results/default-20260709 \
./scripts/devnet-comprehensive.sh
```

`SKIP_UI=1` was used because an unrelated local Vite process was already bound to the default node-ui port. A separate alternate-port UI smoke is recorded below.

Generated report:

- Markdown: `/private/tmp/dkg-v9-storageack-priority-lane/.devnet/comprehensive-results/default-20260709/REPORT.md`
- JSON: `/private/tmp/dkg-v9-storageack-priority-lane/.devnet/comprehensive-results/default-20260709/REPORT.json`

Overall result: failed.

| Count | Value |
| --- | ---: |
| PASS | 9 |
| FAIL | 5 |
| MISSING | 0 |
| Total registered | 14 |
| Wall time | 2177s |

Suite results:

| Suite | Result | Elapsed |
| --- | --- | ---: |
| `v10-rc-validation` | PASS | 55s |
| `devnet-full-sweep` | FAIL:2 | 354s |
| `rfc49-catalog` | FAIL:1 | 244s |
| `rc11-promote-crash` | PASS | 7s |
| `rc11-shutdown-mid` | PASS | 27s |
| `rfc38-all` | FAIL:4 | 317s |
| `probe-hub-rotation` | PASS | 11s |
| `probe-multi-rpc-failover` | PASS | 4s |
| `probe-libp2p-tunables` | PASS | 10s |
| `probe-cg-phonebook` | FAIL:1 | 1s |
| `probe-ack-rejection-reasons` | PASS | 0s |
| `libp2p-soak-short` | PASS | 568s |
| `swm-soak-short` | PASS | 579s |
| `devnet-soak-rs` | FAIL:1 | 0s |

Failure summary:

- `devnet-full-sweep`: 2 of 10 scripts failed.
  - `rfc38-unclean-restart`: failed with `batch [0..200) expected 200 triples, got '0'` after an empty/invalid JSON read.
  - `swm-ownership-restart`: failed because cross-owner promote unexpectedly returned HTTP 200 with `{"swmShared":true,"promotedCount":0,"sealed":true,"publishReady":false}`.
- `rfc49-catalog`: failed with a stripped-core custody leak:
  - `core1: ciphertext_rows=2 catalog_triples=4`
  - `core2: ciphertext_rows=0 catalog_triples=0`
  - `core3: ciphertext_rows=0 catalog_triples=4`
- `rfc38-all`: 4 of 11 scenarios failed.
  - `e2e`: `verify-batch` root mismatch.
  - `mm`: `verify-batch` root mismatch.
  - `scale`: `verify-batch` root mismatch.
  - `lj`: catchup endpoint attempted 0 peers and hit the documented LU-6 cores-only gap path.
- `probe-cg-phonebook`: failed because node 5 had no `/api/identity` or `/api/status` response.
- `devnet-soak-rs`: failed immediately because node 5 was not running.

The comprehensive suite left the devnet partially stopped. `./scripts/devnet.sh status` immediately after the run showed only node 3 still running.

## Restart Before StorageACK Smoke

Command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
UI_PORT=58796 \
./scripts/devnet.sh start 6
```

Result:

- All six nodes restarted successfully on default ports `9201` through `9206`.
- Four core nodes remained staked with 50k TRAC.
- `devnet-test` was registered as on-chain context graph `v10Id=23`.
- `devnet-isolation` was registered as on-chain context graph `v10Id=24`.

Status before the StorageACK smoke:

| Node | HTTP | Connected peers | Store backend |
| --- | ---: | ---: | --- |
| 1 | 200 | 5 | `oxigraph-server` |
| 2 | 200 | 5 | `oxigraph-server` |
| 3 | 200 | 5 | `oxigraph` |
| 4 | 200 | 5 | `oxigraph` |
| 5 | 200 | 5 | `oxigraph-worker` |
| 6 | 200 | 5 | `oxigraph-worker` |

## StorageACK Publish Smoke

First smoke command:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
CONFIRM_TIMEOUT=120 \
./scripts/devnet-test-publish.sh
```

Result:

- Local context graph: `0x86E040eB786df4b7b00039A22A9D6cAb6EB25109/v10-publish-smoke-1783595309`
- On-chain context graph id: `25`
- KA name: `publish-smoke-1783595310`
- Subject: `urn:test:v10-smoke:1783595310`
- Merkle root: `0x73a2157cf0d9ac5f94cf29e6b2ab551ad9cd29e842a2b1fc04a7084c1a400099`
- Status: `confirmed`
- KA ID: `61006143512704423753656654720880708447810501836255502251578367194067070091264`
- Transaction: `0xc2fdaffa5057fbe2aee3385997b83b65e5456c031b66142c9258d2dda8f5d621`
- KCS metadata verification: passed with `merkleRoots=1`, `minted=1`, `byteSize=83`.

Second smoke command, using the shared `devnet-test` graph so all six nodes can read the published VM data:

```bash
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH
TS=1783595375
SUBJECT="urn:test:storageack-priority-full:${TS}"
KA="storageack-priority-full-${TS}"
RDF=".devnet/${KA}.nt"
printf '<%s> <urn:test:predicate> "storageack-priority-devnet-full" .\n' "$SUBJECT" > "$RDF"
DKG_HOME=.devnet/node1 node packages/cli/dist/cli.js ka create "$KA" --context-graph-id devnet-test --input-file "$RDF" --share
DKG_HOME=.devnet/node1 node packages/cli/dist/cli.js ka publish "$KA" --context-graph-id devnet-test
```

Result:

- KA name: `storageack-priority-full-1783595375`
- Subject: `urn:test:storageack-priority-full:1783595375`
- Context graph: `devnet-test`
- Merkle root: `0x7a051e1a41ddd2c7abbf61f04ddff991ffb5eb148c19528ce7072bd71c95e15a`
- Status: `confirmed`
- KA ID: `61006143512704423753656654720880708447810501836255502251578367194067070091265`
- UAL: `did:dkg:evm:31337/0x70ee76691bdd9696552af8d4fd634b3cf79dd529/61006143512704423753656654720880708447810501836255502251578367194067070091265`
- Transaction: `0x18f5bf9029b6cf55ddd9c861ce88d8c1a118402f271e4a7eaa143c802d09fa3f`

StorageACK evidence from node 1:

```text
2026-07-09 13:09:37 [ACKCollector] Collecting ACKs via direct P2P (merkleRoot=0x7a051e1a41ddd2c7...)
2026-07-09 13:09:37 [ACKCollector] Selected 5/5 ACK candidate peer(s) (required=3, protocol=/dkg/10.0.1/storage-ack, selected=9XhFMapL:confirmedCore,L2uMNBAk:confirmedCore,g7qYoLF5:confirmedCore,o33uu4kZ:rest,i9dhn6F2:rest, filtered=none)
2026-07-09 13:09:37 [ACKCollector] Requesting ACKs from 5 core peers (need 3)
2026-07-09 13:09:37 [ACKCollector] Valid ACK from L2uMNBAk (identity=7, signer=0x4430E6FA... source=member)
2026-07-09 13:09:37 [ACKCollector] Valid ACK from 9XhFMapL (identity=6, signer=0xC521572E... source=member)
2026-07-09 13:09:37 [ACKCollector] Valid ACK from g7qYoLF5 (identity=8, signer=0x798d3264... source=member)
2026-07-09 13:09:37 [ACKCollector] Collected 3 ACKs successfully
2026-07-09 13:09:38 [ACKCollector] Quorum already settled - abandoning transport retry for o33uu4kZ: substrate queued (transport): Protocol selection failed - could not negotiate /dkg/10.0.1/storage-ack
2026-07-09 13:09:38 [ACKCollector] Quorum already settled - abandoning transport retry for i9dhn6F2: substrate queued (transport): Protocol selection failed - could not negotiate /dkg/10.0.1/storage-ack
```

The candidate pool kept the confirmed cores first and retained the unclassified connected fallback candidates in the selected pool.

## Six-Node Readback

Default query view after the shared-graph publish:

| Node | HTTP | ASK result |
| --- | ---: | --- |
| 1 | 200 | `true` |
| 2 | 200 | `false` |
| 3 | 200 | `false` |
| 4 | 200 | `false` |
| 5 | 200 | `false` |
| 6 | 200 | `false` |

This default view is node-local working/shared memory behavior.

Published VM readback command shape:

```json
{
  "contextGraphId": "devnet-test",
  "view": "verifiable-memory",
  "sparql": "ASK WHERE { <urn:test:storageack-priority-full:1783595375> <urn:test:predicate> \"storageack-priority-devnet-full\" . }"
}
```

Published VM readback result:

| Node | HTTP | ASK result |
| --- | ---: | --- |
| 1 | 200 | `true` |
| 2 | 200 | `true` |
| 3 | 200 | `true` |
| 4 | 200 | `true` |
| 5 | 200 | `true` |
| 6 | 200 | `true` |

## Node-UI Smoke

The comprehensive suite skipped node-ui because the default Vite port was occupied by an unrelated local process. The UI was tested separately on an alternate port.

Command:

```bash
cd packages/node-ui
PATH=/Users/otlegend/.nvm/versions/node/v24.11.1/bin:$PATH \
DEVNET_NODE=1 \
pnpm exec vite --host 127.0.0.1 --port 58796
```

Result:

- Vite reported `Using devnet node1 on port 9201`.
- `GET http://127.0.0.1:58796/ui/`: HTTP 200, HTML payload, 719 bytes.
- `GET http://127.0.0.1:58796/api/status`: HTTP 200.
- Proxied status returned node `devnet-node-1`, commit `1a31d0b9`, store backend `oxigraph-server`, and `connectedPeers=5`.

## Final Status Before Shutdown

```text
Hardhat:  RUNNING (PID 67955, port 8545)
Node 1:   RUNNING (PID 25864, API :9201, peer 12D3KooWPijRjP8T...)
Node 2:   RUNNING (PID 25936, API :9202, peer 12D3KooWBzUDRBCJ...)
Node 3:   RUNNING (PID 26012, API :9203, peer 12D3KooWHYrJf6v9...)
Node 4:   RUNNING (PID 26086, API :9204, peer 12D3KooWJmsWjZA1...)
Node 5:   RUNNING (PID 26150, API :9205, peer 12D3KooWFKkvBhQv...)
Node 6:   RUNNING (PID 26187, API :9206, peer 12D3KooWBZ6ZnWdS...)
node-ui:  STOPPED
```

## Conclusion

- Full comprehensive devnet suite: failed, 9 passed and 5 failed.
- StorageACK publish smoke after restart: passed.
- StorageACK candidate-pool behavior in live logs: confirmed cores were ranked first and connected fallback candidates were retained.
- Six-node published VM readback: passed on all six nodes.
- Node-ui alternate-port smoke: passed.
