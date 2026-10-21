# Issue 3252 validation — 2026-10-21

## Executive summary

The patch avoids authority-cache invalidation from unrelated publication lifecycle removals. When finalized snapshot retirement is enabled, it also confines StorageACK-copy cleanup observation to its actual metadata graph. Required writes and conservative authority fencing remain intact.

Controlled cache experiments show fewer store reads on both embedded Oxigraph and real Blazegraph. Live Base Sepolia validation completed **12/12 private-context-graph publications with zero retries**, using all six publisher wallets: six with finalized cleanup enabled, then six after a restart with the default disabled setting. All receipts succeeded, all required lifecycle stamps were present, and exact RDF readback matched every payload.

These results validate the optimization mechanism and the bounded regression scenarios. They do **not** establish end-to-end throughput improvement or satisfy the original issue's sustained combined publication/catalog workload. The incident's finalized-cleanup setting is unknown; the optional path is not asserted to be its cause.

## Environment and provenance

- Base `testnet-canary`: `abb89dff7`; runtime code: `63a3342fcb99323a31262ee61429d7a2acbf94b7`, reported by the rebuilt CLI. Subsequent test/comment/report edits do not change runtime behavior.
- Native macOS arm64, Node 22.23.3, pnpm 10.28.1. Frozen install, native SQLite construction and runtime package build/types passed.
- Live backend: managed oxigraph-server at loopback 19453; API 19325; isolated home `.tmp/3252/home/`; auto-update disabled; four connected peers.
- Base Sepolia chain ID 84532; Hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6`; Hub-resolved TRAC `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8`.
- Claimed prepared batch 1 as `issue3252-20261021`, preserving all three operational and six publisher wallets. No funding transfer or PCA creation. All used signers had gas/TRAC and equal pending/latest nonces before use. Owner: `0x247B02C301B34E52e9021728F34C3457F81f2dFc`.
- Private graph: `0x247B02C301B34E52e9021728F34C3457F81f2dFc/issue3252-20261021`, on-chain ID **923**, access policy 1, publish policy 1. One-epoch no-attribution publications.
- Backend characterization: owned container `dkg-3252-blazegraph`, loopback 19452, image `islandora/blazegraph@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d`. Unique namespaces disposed by each test.
- Raw logs, API responses, scripts and receipt checks are retained locally in ignored `.tmp/3252/evidence/`; credentials are excluded from this report and Git.

## Controlled improvement and regression evidence

| Check | Observed result |
| --- | --- |
| Unchanged-base cleanup reproduction | Fails as expected: unrelated recipient revision advances 0 → 1 |
| Unchanged-base lifecycle reproduction | Fails as expected: exact lifecycle removals advance authority revision |
| New cleanup suite | 12/12 on embedded Oxigraph; 12/12 on real Blazegraph |
| New lifecycle projection suite | 15/15 on embedded Oxigraph; 15/15 on real Blazegraph |
| Focused agent regressions | 257/257 across lifecycle, projection, scheduling, recipient fencing and queued finalization; includes the 15 new lifecycle cases |
| Publisher cleanup/retirement | 78/78 |
| Existing ledger timestamp writer | 16/16 |
| CLI wallet wiring/recovery | 11/11 |
| Runtime package builds/types, lint, sizes, inventory | Passed |

Repeated control/candidate/candidate/control arms each warm eight unrelated projections and read them after four cleanup calls. Projection query counts are **192 / 0 / 0 / 192** on both backends. Control uses the original generic wrapper; candidate uses the composed writer with the same deletion query. Only the first call removes fixture rows; later calls are no-match. These are cache-invalidation measurements, not sustained-publication throughput.

The lifecycle test writes actual VM stamps and removes a seeded share marker, retains the warm authority record, and observes zero projection reload queries. Real roster/delegation removals and arbitrary-predicate removal on the exact CG subject still invalidate the appropriate proofs. Tests cover ambiguous/unsafe terms, pre/post-commit errors, concurrent key introduction, decorated stores, version retention, generic UPDATE and actual two-wallet publisher wiring. Retained RDF is compared exactly.

## Live results

Each asset contained 20 graphless RDF triples. Native API-token loading gave 401 without a token and 200 with it. Both cohorts waited for publisher availability and current, accepted chain authority before enqueueing. The first create attempt immediately after the second restart hit connection-refused before API bind; no request was accepted, and it was retried after readiness.

All twelve jobs reached `finalized`, each with `retryCount=0`, successful canonical receipt/block-hash verification and the expected publisher signer. Before VM pull, each asset reported `published`, `VM`, `vm-confirmed`, its expected UAL and the original sealed root. VM pull followed by WM query matched the complete canonical subject/predicate/object set; a same-count altered-payload negative comparison was rejected for every asset. A later post-restart assertion incorrectly expected `publishedUal` after VM pull. Inspection showed the unchanged `assertionCreateWithAllocationLock` draft-reopen path intentionally preserves VM roots/reserved identity but not that presentation field; the check was not counted as a persistence pass. Required VM stamps were verified before pull for every asset.

An observational preload wrapped the existing projection invalidation/rebuild and retirement methods, logging calls without changing their results or skipping writes. It recorded **48 VM-stamp removal descriptors** (four per asset) with **zero authority-revision changes**, plus **six completed cleanup-writer invocations** in the enabled cohort and none in the disabled cohort. No cleanup invocation reported an error. Live edge cleanup may be a no-match; actual copy deletion/retention is proven by the real-store fixtures. Instrumentation overhead and the absence of a live control cohort preclude a latency-speedup claim.

| Cohort / asset | Successful transaction | Block | Accepted → finalized (s) |
| --- | --- | --- | --- |
| Enabled / tail-0 | [0xdfec34a414…](https://sepolia.basescan.org/tx/0xdfec34a4143d4c782dbecc90ff30325ae32d5bd0a255bf06315af7a85872ed8e) | 48406248 | 26.003 |
| Enabled / tail-1 | [0x33d5007604…](https://sepolia.basescan.org/tx/0x33d5007604b518fca1b6426f260535abaedbfea9cde8b8f84cd1db8e65bec571) | 48406247 | 25.597 |
| Enabled / tail-2 | [0x530a9ceb3c…](https://sepolia.basescan.org/tx/0x530a9ceb3c63cdb4cb52a810880b418e0e4297a06c66fa3f2a73fcdd93ae8f58) | 48406243 | 17.020 |
| Enabled / tail-3 | [0xca52c7e7a5…](https://sepolia.basescan.org/tx/0xca52c7e7a571d25b57ae88ceb4d786443ed11a9ef3380f5e5d02cbed96e87ec4) | 48406246 | 22.394 |
| Enabled / tail-4 | [0xe270d5fa28…](https://sepolia.basescan.org/tx/0xe270d5fa28b0562595609dc5bccf38cad01d24ebe03a6e60b2878b6281477c89) | 48406249 | 26.176 |
| Enabled / tail-5 | [0xbd0a914cfd…](https://sepolia.basescan.org/tx/0xbd0a914cfdda242b203551ed2898315db0f04cf93f3f216b4ccdd9359d5d7990) | 48406250 | 28.108 |
| Default / default-tail-0 | [0xa9c5d7a33d…](https://sepolia.basescan.org/tx/0xa9c5d7a33d7c8ae16925c01df0b83d28bc25b8270d3d5a28bbc30d5dcc1c42cf) | 48406357 | 30.435 |
| Default / default-tail-1 | [0x9aa32406d8…](https://sepolia.basescan.org/tx/0x9aa32406d8af450949917396dc3285384305dcdf1e77aabbb490ccf1fa1f8dfe) | 48406355 | 27.861 |
| Default / default-tail-2 | [0x54cc503949…](https://sepolia.basescan.org/tx/0x54cc503949f945e7d43ce77198c128e8965d7896b8e5d8a2baeb75d702f0d511) | 48406350 | 20.143 |
| Default / default-tail-3 | [0x490a2a04d6…](https://sepolia.basescan.org/tx/0x490a2a04d633bfb50ad7ac3956ca22be74b1fa439686e827f0a4f1116eb04ce4) | 48406354 | 25.179 |
| Default / default-tail-4 | [0x21e94279f6…](https://sepolia.basescan.org/tx/0x21e94279f6e3ae14b81fc750218b669d07ed5b829d878e25645d9c11070498ac) | 48406354 | 26.414 |
| Default / default-tail-5 | [0x15cf05ac0f…](https://sepolia.basescan.org/tx/0x15cf05ac0f13a9fa64cee1df4ba6059536cabe48e335b72f13b83d7bd97509e4) | 48406353 | 24.410 |

After each cohort, finalization recovery had no entries or payload bytes, and store/sync schedulers reported healthy. Catalog status reported `complete`, authority `accepted/current`, zero missing rows and equal expected/applied inventory digests. Its expected/applied head digests and row counts differed (the first cohort snapshot showed 6 expected versus 11 applied), so this is **not** a proof of full catalog convergence or a claim to have fixed that separate diagnostic behavior.

The node repeatedly reported a background historical chain-index read failure at block 38133666 because all configured public RPC providers had pruned that history. Explicitly registering the fresh graph allowed finalized authority resolution and all publications to succeed. The error was preserved as an environment limitation, not hidden by disabling correctness checks.

## Reproduction

```sh
pnpm --filter @origintrail-official/dkg-agent exec vitest run --config vitest.unit.config.ts test/storage-ack-copy-cleanup-writer.test.ts test/context-graph-lifecycle-cache.test.ts
DKG_CLEANUP_BLAZEGRAPH_URL=http://127.0.0.1:19452/bigdata pnpm --filter @origintrail-official/dkg-agent exec vitest run --config vitest.unit.config.ts test/storage-ack-copy-cleanup-writer.test.ts test/context-graph-lifecycle-cache.test.ts
pnpm --filter @origintrail-official/dkg-publisher exec vitest run --config vitest.unit.config.ts test/storage-ack-copy-cleanup.test.ts test/published-snapshot-cleanup.test.ts
pnpm --filter @origintrail-official/dkg exec vitest run --config vitest.unit.config.ts test/publisher-runtime-cleanup.test.ts test/publisher-ka-recovery.test.ts
```

Live sequence: claim the prepared batch, build, create/register a private graph, create/finalize/share six named payloads, enqueue each through `/api/knowledge-assets/:name/vm/publish-async`, inspect every publisher job, independently verify receipts, inspect lifecycle, pull from VM and compare exact RDF. Restart with `gc.finalizedCleanupEnabled=false` and repeat with six distinct names. Use the native API token; never save it in evidence.

## Cleanup and remaining scope

The owned daemon/supervisor and managed-store listeners were stopped and verified gone. All 22 transactions (12 publications, nine approvals and one graph registration) succeeded and account for every consumed nonce; all operational/publisher pending and latest nonces match. The matching batch claim was released and copied wallet credentials removed. The isolated store and raw evidence are retained locally. The owned Blazegraph container remains only for the bounded review period; its test namespaces are disposed. The separate #2962 inline finalization certificate defect remains out of scope. The original sustained workload, live Blazegraph throughput, broad catalog convergence and all possible regressions remain unproven; no issue-closing claim is made.
