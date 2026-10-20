# Local verification — 20 October 2026

The consumer is a generic DKG Source Worker handler loaded through
`handlerModule`. Customer-specific logic is not required. All work is isolated
on `codex/kafka-source-poc`, based on fresh `testnet-canary`
`693be6317ba8d6db6aefc6b6ff3c77f52ef535cd`.

## Verified

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
Nothing was deployed to JPB, merged, published to npm or released. No full DKG
CI run, production-load benchmark, SASL/TLS integration test, Sources UI or
Graph Computer execution receipt is claimed. This PoC reuses DKG Sources; its
host-side Kafka reads are not pure Graph Computer Program execution.
