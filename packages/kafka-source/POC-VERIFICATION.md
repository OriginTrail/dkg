# Kafka Source verification

The consumer is a generic DKG Source Worker handler loaded through
`handlerModule`. Customer-specific logic is not required. The initial 20 October implementation used
`codex/kafka-source-poc` based on `testnet-canary`
`693be6317ba8d6db6aefc6b6ff3c77f52ef535cd`.

## Read cooldown and interrupted retries — 26 October 2026

Parent head: `fbca3a0e059f68e5dea1ba8fad63d89aafc7c488`, with current
`testnet-canary` `137283d31f7b619118e79db3cbb17eb7370fe4eb` already merged.

- Nine new regressions fail against the parent implementation while its
  existing 49 tests pass. After the fixes, **58/58 focused tests pass** on
  Node 22.23.2, with **96.73% line coverage** and all existing coverage floors.
- Graph-list and descriptor preflight, descriptor readback after creation,
  and query readback each persist `Retry-After: 60`. Ten five-second polls
  rebuild the handler and reopen the journal, send **zero HTTP requests**,
  consume **zero retry attempts**, and acknowledge no offsets. After expiry,
  each case completes with exactly one created KA and one acknowledgement.
- A read cooldown preserves an uncertain write intent even when the created
  asset is temporarily invisible. Expiry reports `DKG_WRITE_OUTCOME_UNKNOWN`
  without another create; later visibility recovers the same sealed KA.
  A separate case starts with two genuine failures and preserves that count
  through throttling at the final available attempt.
- Alternating poison-record replay and `KAFKA_READ_FAILED`, starting with
  either condition, reaches native manual review after three failed attempts.
  Ten restarted polls never acknowledge the poison record. A genuinely changed
  delivery still receives a fresh retry budget.
- These checks use the native Source Worker and the labelled HTTP/transport
  doubles. No live broker or DKG lifecycle integration was rerun for these fixes;
  earlier real-broker evidence below remains separately dated.

Sanitized source hashes and test evidence:
[`retry-cooldown-20261026.json`](test/evidence/retry-cooldown-20261026.json).
Hosted CI is tracked separately on the PR for the published head.

## Daemon-wide cooldown review fixes — 21 October 2026

Validation baseline: current `testnet-canary`
`a8df4583820c998c31676cc2796597cd22f25b35`, merged into this PR branch.

- Reproduced the review failure before changing the sink: a create rejected
  with `Retry-After: 60`, followed by daemon-wide throttling, produced `failed`
  instead of `retry-wait` on the next native worker poll.
- Moved the persisted rejection deadline ahead of HTTP requests. Five polls
  five seconds apart, each with a rebuilt handler and reopened journal, make
  **zero HTTP requests**, preserve attempt count 1, do not require manual
  review and acknowledge no offsets. After 60 seconds, processing resumes
  with exactly one sealed KA and one acknowledgement. This cooldown scenario
  uses the HTTP contract double, not a live rate-limited daemon.
- Reused DKG core's canonical Working Memory prefix and SPARQL helpers.
  Negative tests reject malformed IRIs, historical owner casing, another
  memory layer, wrong ownership/graph and unsealed/shared descriptors.
- **49 focused tests pass**, with **96.61% line coverage** (94% floor).
  **774 repository script tests pass** on Node 22.23.1. Runtime package build
  (Solidity excluded), frozen offline dependency installation, lint and test
  inventory (2,746 files / 24 Vitest packages) pass.
- Reran the real localhost broker's two polling regressions: expiration still
  fails without offset/checkpoint advancement; a 100ms startup with a 20ms
  read timeout delivers the queued record. This mode makes **no DKG requests
  or graph writes**. It is not a new full broker-to-DKG lifecycle proof.
- Sanitized aggregate evidence and current source/patch digests:
  [`cooldown-recovery-20261021.json`](test/evidence/cooldown-recovery-20261021.json).

## Earlier polling review fixes — 21 October 2026

Updated the validation baseline by merging current `testnet-canary`
`23ccf2fd37e8c16aca29be7af5ebf96ce898cb27`. The source remains a generic
private DKG Source Worker handler; no production deployment is performed.

- **45 focused tests pass** on Node 22.23.1 with **96.61% line coverage**
  against the existing 94% floor. The installed KafkaJS `ConsumerGroup` and
  `OffsetManager` are exercised with controlled coordinator I/O: explicit
  `autoOffsetReset: false` throws a non-retriable error without a reset commit;
  legacy consumers still use their default behavior. An unpatched consumer is
  rejected before connecting. Native-worker coverage checks persisted source
  failure, unchanged checkpoints and no completed partition after expiration.
- Controlled 40ms joins with a 10ms read budget deliver the queued record on
  three polls without acknowledging or marking it complete. A genuinely idle
  assigned partition still returns an empty delivery after its read budget.
- **Real localhost Redpanda/KafkaJS retention race passed:** a saved/broker
  offset of 0 passes the admin snapshot (low 0); the harness then truncates only
  that disposable topic to low 1 before fetching. The native worker persists
  `KAFKA_OFFSET_OUT_OF_RANGE`. Broker offset and journal checkpoint remain 0,
  no reset sentinel is committed, no partition is marked complete and no KA is
  created. This is actual broker truncation, not a simulated error response.
- **Real delayed startup passed:** consumer startup is delayed at least 80ms
  with a 20ms read budget; the queued record is delivered after startup.
  Broker offset remains absent because this polling-only check does not
  manufacture a DKG receipt or acknowledge an unverified record.
- **772 repository script tests pass** on Node 22.23.1. Runtime package build,
  lint, frozen offline dependency installation and test inventory (2,730 files,
  24 Vitest packages) pass. The runtime build excludes Solidity compilation.
- The latest real-broker run used `test:broker --polling-only`: **no DKG
  requests or graph writes**. The full Kafka-to-DKG lifecycle suite was not
  repeated on 21 October; its separately dated earlier evidence follows below.
- Sanitized evidence and both the five-source-file and KafkaJS patch digests:
  [`polling-recovery-20261021.json`](test/evidence/polling-recovery-20261021.json).
  Reproduce with the existing operator-provided integration config and
  `pnpm --filter @origintrail-official/dkg-source-kafka test:broker --polling-only`.

The patch is explicit and pinned in pnpm, not a prototype change in production.
It adds an opt-in policy and typed capability; all other KafkaJS consumers keep
upstream default reset behavior. The handler refuses to run without the guard.

## Review fixes — 20 October 2026

The follow-up corrects durable initial offset selection, bounded partition
fairness, preparation retry ownership, definite pre-write rejection recovery
and canonical RDF readback. It keeps private sealing and verification before
Kafka acknowledgement.

- **40 focused tests** pass on Node 22.23.1 and 24.11.1, with **96.93% line coverage**
  (94% floor), including 29 native Source Worker
  scenarios and 11 controlled Kafka transport scenarios. New regressions cover
  empty tail polls, first write/commit failure across journal reopen, a hot
  partition beside a waiting partition, 429 recovery and Retry-After waits,
  ambiguous HTTP failures, equivalent RDF escapes versus changed values,
  invalid descriptors, per-source preparation failure and a partial poison
  batch through manual review.
- Real localhost Redpanda and the native DKG **10.0.25** daemon (built from the
  canary above) verify 5 records/2 partitions, zero additional creates on replay,
  plus two new-tail recovery cases and bounded progress of the second partition.
  The daemon uses native Oxigraph and a **mock chain**, not a public deployment.
  Control characters in mapped values round-trip through real sealed readback.
- The new-tail cases each begin with an empty poll at offset 1 and no broker
  commit. A failed first write or first commit is followed by another record
  and a rebuilt handler. Both offsets 1 and 2 recover: exactly two sealed KAs,
  committed next offset 3, with one KA reused in the failed-commit case.
- In the fairness case partition 0 stays backlogged while partition 1 is
  waiting. In two polls both commit next offset 1; no later offset is committed.
- Sanitized follow-up evidence is in
  [`test/evidence/review-recovery-20261020.json`](test/evidence/review-recovery-20261020.json).
  The earlier evidence below is retained as a dated validation record.

## Initial verification (before review fixes)

- **19 passing tests**, including 13 through the actual canary
  `runSourceWorkerOnce` and six Kafka transport-contract tests. The suite covers
  readback errors, private-graph enforcement, binary data, tombstones, replay,
  exact large offsets, changed bytes and uncertain-write recovery. The failure
  tests explicitly use an HTTP contract double, not a claimed live node.
- The suite uses the standard Vitest supporting CI lane, JUnit receipts and
  full production-source coverage ratchet. On Node 22.23.1, measured line
  coverage is **95.62%**; the checked-in line floor is 94%.
- CI integration checks: **764 repository script tests** pass; all 26 Node
  package builds pass with EVM compilation explicitly skipped; lint and frozen
  offline dependency installation pass. Test inventory verifies 2,689 files
  across 24 Vitest packages and assigns both Kafka suites to the required
  `kosava-supporting` lane. The standard CI JUnit runner also executes all
  19 tests and produces its coverage receipt locally.
- **Real local broker:** Redpanda `v24.3.18`, Kafka protocol, bound to localhost.
  Disposable test runtime; it is not a production broker deployment.
- **Real local DKG HTTP lifecycle:** a separate DKG `10.0.6` daemon, private
  synthetic-data Context Graph, authenticated test agent, native Oxigraph store,
  **mock chain adapter**. No public-chain proof is claimed.
- Latest completed integration: **5 messages, 2 partitions, 5 distinct sealed
  WM KAs**. All five broker records replayed with **zero additional creates**.
  Both a lost create response and a failed Kafka offset commit recovered.
- Kafka committed offsets were independently read back as `3` and `2`.
- The native **DKG 10.0.6 CLI** loaded this package with
  `dkg source-worker run --config … --once`; the final empty poll reported
  `no-matching-rows`. Source Worker logic itself was separately exercised at
  the canary revision above. This does not claim a freshly built full canary
  daemon was tested.
- Package dry-run contains source, README, config and query examples; no local
  journals, environment files or credentials.

The aggregate proof and exact synthetic KA names/assertions are in
[`test/evidence/local-poc-20261020.json`](test/evidence/local-poc-20261020.json).
Five is the count for that integration run. Earlier synthetic debugging runs
also wrote to the isolated test graph; it is not claimed to contain only five
KAs in total.

## Not claimed

No IDENER broker connection or current test-credential validity was verified.
Nothing was deployed to JPB, merged, published to npm or released. No production-load benchmark, SASL/TLS integration test, Sources UI or
Graph Computer execution receipt is claimed. This PoC reuses DKG Sources; its
host-side Kafka reads are not pure Graph Computer Program execution.
