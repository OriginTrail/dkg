# Issue 3252 validation — 2026-10-21

## Executive Summary

The implementation prevents StorageACK-copy cleanup from invalidating unrelated context-graph and recipient-key caches. Deterministic tests pass on embedded Oxigraph and real Blazegraph, including uncertain writes and concurrent key introduction. In repeated control/candidate/candidate/control arms, eight warmed unrelated projections read after each of four cleanup calls incurred **192 / 0 / 0 / 192** projection queries on both backends. This proves avoided store work in the tested scenario, not an end-to-end publication latency or throughput improvement.

**Live testnet validation is pending:** both prepared funded wallet batches are claimed by other runs. The claim attempt acquired no batch. No credentials were copied and no testnet operations were submitted. The original issue's combined sustained-publication/catalog workload acceptance is not claimed complete.

## Environment

- Base: `testnet-canary` at `abb89dff7`; candidate branch `codex/3252-publish-store-tail`.
- Native macOS arm64, Node 22.23.3, pnpm 10.28.1; frozen install, runtime build/types, SQLite database construction passed.
- Backend characterization: embedded Oxigraph and owned Docker container `dkg-3252-blazegraph`, loopback port 19452.
- Blazegraph image: `islandora/blazegraph@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d`.
- Every test creates a unique namespace through `BlazegraphNamespaceManager`; each is disposed after the test.
- Raw evidence: `.tmp/3252/evidence/` (ignored). Planned isolated node home: `.tmp/3252/home/` (empty).
- Wallet pool: configured `DKG_TESTNET_POOL`; batch 1 belongs to `async-share-recovery-20261021`, batch 2 to `lifecycle-recovery-3017-20261021`. Neither was used by this task.

## Results

| Check | Result |
| --- | --- |
| Unchanged-base reproduction | Fails as expected: cleanup changes unrelated recipient revision 0 → 1 |
| New cleanup observation suite | 12/12 on Oxigraph and 12/12 on real Blazegraph |
| Existing publisher cleanup/retirement suite | 78/78 |
| Recipient-fence, wrapper and queued-finalization regression suites | 176/176 |
| Existing lifecycle and ledger-timestamp writer suites | 36/36 |
| CLI two-wallet wiring and recovery | 11/11 |
| Build/types, lint, file sizes, test inventory | Pass |
| Live private graph publication/receipt/readback | Pending funded batch ownership |

Cleanup tests compare exact retained RDF, not only counts. They preserve newer versions and original operations, test opaque generic UPDATEs, and verify that known or late-introduced key facts remain fenced during an ambiguous cleanup. The repeated-arm test uses the unchanged generic wrapper for control and the new composed writer for candidate; both execute the same deletion query. After the first actual deletion, subsequent calls are no-match cleanup. This intentionally isolates cache invalidation rather than representing a sustained publication workload.

## Reproduction

```sh
pnpm --filter @origintrail-official/dkg-agent exec vitest run --config vitest.unit.config.ts test/storage-ack-copy-cleanup-writer.test.ts
DKG_CLEANUP_BLAZEGRAPH_URL=http://127.0.0.1:19452/bigdata pnpm --filter @origintrail-official/dkg-agent exec vitest run --config vitest.unit.config.ts test/storage-ack-copy-cleanup-writer.test.ts
pnpm --filter @origintrail-official/dkg-publisher exec vitest run --config vitest.unit.config.ts test/storage-ack-copy-cleanup.test.ts test/published-snapshot-cleanup.test.ts
pnpm --filter @origintrail-official/dkg exec vitest run --config vitest.unit.config.ts test/publisher-runtime-cleanup.test.ts test/publisher-ka-recovery.test.ts
```

## Cleanup and limitations

The owned Blazegraph container is retained while review is active; test namespaces were disposed. The mistakenly started local Hardhat setup was stopped and its processes verified gone. No wallet claim requires release. #2962's inline finalization certificate defect is separate and remains outside this patch; required lifecycle writes are unchanged. Live performance, chain receipts, private catalog convergence and no-regression claims still require the planned funded run.
