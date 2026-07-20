# WAL-000 legacy authority-path inventory

This inventory maps production-authoritative DKG semantics and the existing
legacy-sync path to fixtures selected by `scenario-matrix.json`. The baseline
does not invent a second semantic model. It freezes only DKG semantic,
crypto/authorization, VM lifecycle, and storage-safety assertions. Current sync
behavior is known not to be fully correct, so sync-specific fixtures are
non-normative characterization and are excluded from the semantic oracle.

## Mutation and lifecycle paths

| Surface | Production authority path | Frozen legacy fixtures | Oracle scenario |
| --- | --- | --- | --- |
| WM creation, finalize, share, publish, and restart repair | `packages/publisher/src/publisher.ts`, `publish-handler.ts`, `dkg-publisher.ts`, `metadata.ts`; `packages/agent/src/finalization-handler.ts` | `packages/agent/test/e2e-memory-layers.test.ts` | `memory-layer-lifecycle` |
| SWM first-writer-wins conflict and TTL expiry/no resurrection | `packages/publisher/src/workspace-handler.ts`, `metadata.ts` | `packages/agent/test/swm-first-writer-wins-extra.test.ts`, `swm-ttl-v2-cleanup.test.ts` | `swm-conflict-expiry` |
| Membership mutation and request authorization | `packages/agent/src/context-graph-membership-mutation.ts`, `sync/auth/request-authorize.ts`, `swm/member-recovery-auth.ts`; `packages/publisher/src/access-handler.ts` | `packages/agent/test/request-authorize.test.ts`, `member-attestation.test.ts`, `swm-agent-gate-access.test.ts` | `private-authorization-and-keys` |
| Sender Key membership epoch, stale-target rejection, and encrypted SWM transport | `packages/agent/src/dkg-agent-cg-registry.ts`, `dkg-agent-ccl.ts`, `dkg-agent-endorse.ts`; `packages/publisher/src/workspace-handler.ts`, `workspace-agent-recipients.ts` | `packages/agent/test/swm-sender-key-stale-target.test.ts`, `swm-agent-gate-access.test.ts` | `private-authorization-and-keys` |
| Equal-peer sync, reconnect delta, late join/full recovery, interruption, and retry | `packages/agent/src/p2p/sync-transport.ts`, `sync/on-connect/sync-on-connect.ts`, `sync/requester/shared-memory-sync.ts`, `swm-recovery.ts`, `page-fetch.ts`; `sync/responder/sync-handler.ts` | `packages/agent/test/swm-snapshot-sync.test.ts`, `swm-recovery.test.ts`, `sync-on-connect-churn.test.ts`, `sync-on-connect-retry.test.ts` | `sync-reconnect-and-recovery` — characterization only |
| Atomic graph materialization, stale replay, store failure, quarantine, and finalization recovery in the current sync path | `packages/agent/src/sync/requester/graph-scoped-materialization.ts`, `swm-recovery-apply.ts`, `durable-sync.ts`, `durable-progress.ts`, `durable-session.ts`; `finalization-handler.ts` | `packages/agent/test/durable-sync-graph-scoped-materialization.test.ts`, `swm-recovery-apply.test.ts`, `ka-graph-finalization-recovery.test.ts` | `durable-materialization-failures` — characterization only |
| VM activation, chain truth, finality, bounded reorg, and periodic reconciliation | `packages/agent/src/chain-reconciler.ts`, `vm-reconcile-service.ts`, `finalization-handler.ts`; `packages/chain/src/chain-adapter.ts` | `packages/agent/test/chain-reconciler.test.ts`, `chain-reconcile-e2e.test.ts`, `vm-reconcile-self-prime.test.ts`, `finalization-handler-chain-truth.test.ts` | `vm-chain-finality-and-reorg` |
| Publish/update, old-version deletion, Merkle root, author signature, receipt, and SWM boundary | `packages/publisher/src/publish-handler.ts`, `update-handler.ts`, `merkle.ts`, `metadata.ts`, `verification-metadata.ts` | `packages/publisher/test/publish-lifecycle.test.ts`, `ka-update.test.ts`, `shared-memory-publish-boundary.test.ts` | `publish-update-and-merkle` |
| Private content encryption, canonical RDF, access policy, and signature verification | `packages/publisher/src/async-lift-publisher-impl.ts`, `canonical-publish-payload.ts`, `access-handler.ts`, `validation.ts`; `packages/storage/src/private-store.ts` | `packages/publisher/test/ka-graph-private-access.test.ts`, `async-lift-canonicalization-and-encryption.test.ts`, `access-verification.test.ts` | `private-publisher-boundary` |
| Chain adapter/event parity, ACK digest, and invalid-policy rejection | `packages/chain/src/chain-adapter.ts`, `mock-adapter.ts`, `evm-adapter-publish.ts`; publisher verification/ACK paths | `packages/chain/test/mock-adapter-parity.test.ts`, `evm-event-decode.test.ts`, `v10-update-ack-digest-parity.unit.test.ts` | `chain-crypto-contract` |
| Durable changelog sequence/restart and Oxigraph worker crash behavior | `packages/storage/src/changelog-store.ts`, `adapters/oxigraph-worker.ts`, `adapters/oxigraph-worker-impl.ts` | `packages/storage/test/changelog.integration.test.ts`, `oxigraph-worker-respawn.test.ts` | `storage-restart-and-durability` |

## Non-normative legacy-sync performance characterization

These numbers describe replacement cost and help expose old-path pathologies.
They are not targets, release gates, or evidence that current sync is correct.

| Profile | Current path measured | Receipt counters |
| --- | --- | --- |
| Cached legacy full-snapshot paging | `packages/agent/scripts/sync-responder-page-benchmark.cjs`; current implementation is the script's `new` path | rows, page size, transfer bytes, request/page count, snapshot reads, triplestore operations, latency, heap delta, RSS, copied slots |
| Sync parse/filter worker throughput | `packages/agent/src/sync-verify-worker.ts` via `sync-worker-benchmark.cjs` | input lines/bytes, kept quads, worker requests, triplestore operations, main/worker latency, process CPU/RSS |
| Sync worker event-loop responsiveness | `packages/agent/src/sync-verify-worker.ts` via `sync-worker-responsiveness-benchmark.cjs` | input lines/bytes, worker requests, triplestore operations, duration, event-loop delay, process CPU/RSS |

The microbenchmarks start after snapshot materialization and do not contact a
triplestore; their `triplestoreOperations` value is therefore intentionally
zero, while `snapshotReadOperations` records the precomputed snapshot read.
This is not a substitute for the future task-owned live-devnet full/delta
benchmark; it is the hermetic old-path performance floor that can run on every
clean checkout.

## Frozen pre-existing skips

The complete execution contains 401 assertions. The normative DKG oracle has
296 assertions: 289 pass and seven are already skipped on the source commit.
The two sync-characterization groups contain another 105 passing assertions;
their statuses and source digests are recorded per run but are not frozen as
correctness expectations. Normative skips remain part of the oracle digest, so
any status change is visible.

- Two publisher update assertions are marked skipped by their existing RC11 / PR1
  comments: private-Merkle-root receiver application and private-triple
  replacement during update.
- Five live-Blazegraph changelog assertions require an external Blazegraph
  read path: typed markers, drop marker monotonicity, restart reseeding, era
  reseeding, and durable marker-plus-data insertion.

Those seven cases are recorded limitations, not WAL-000 passes. The hermetic
corpus still exercises restart and worker-crash behavior through the remaining
storage fixtures; live Blazegraph and full-network measurements remain separate
acceptance evidence rather than being simulated here. Passing legacy-sync
characterization fixtures likewise does not establish that current sync works.
