# Kafka source for DKG — PoC

This is a reusable **DKG Source Worker handler**. Any operator can configure a
Kafka broker/topic, an authorized DKG agent and a private Context Graph. There
are no customer names, business ontologies, SQL tables or manufacturing rules
in the implementation. It is an addition to DKG, not a JPB integration.

The existing `kafka-plugin` registers/discovers stream metadata. This package
performs the missing **consumption** step. They are separate responsibilities.

## Run through DKG Sources

Install this package alongside the DKG CLI (PoC source lives in this workspace).
Copy `config.example.json` to a private operator config, set the existing agent
token, graph, broker and topic, and point `handlerModule` to this package's
`src/handler.mjs`. In a source checkout use its absolute path. Set Kafka username
and password through the environment variable names in the config. The native
DKG config loader does not interpolate `${ENV_VAR}` strings in JSON.

```sh
chmod 600 kafka.private.json
dkg source-worker run --config ./kafka.private.json --once
# Omit --once for the native Source Worker polling schedule.
```

This uses the existing `createSourceWorkerDeps` extension point and
`runSourceWorkerOnce` state/retry machinery. There is no separate consumer
daemon, custom scheduler or replacement DKG write API. No DKG UI screens are
added by this PoC. The Source Worker currently formats a completed result as
"published" in its CLI log; here that means **sealed private Working Memory**,
not a shared or on-chain-published assertion.

## Enroll a registered stream

The generic `kafka-plugin` registry can supply stream connection metadata. An
operator first selects a readable registration UAL, then explicitly creates a
local source config. The registry does not start consumers or supply credentials,
consumer groups, the target graph, or the consuming DKG agent.

Create an operator options file, substituting an existing authorized agent and
private graph. `fromBeginning` is an explicit initial-position choice; an
existing group's committed positions still take precedence.

```json
{
  "id": "selected-application-events",
  "groupId": "approved-local-consumer-group",
  "agentAddress": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "contextGraphId": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/private-events",
  "fromBeginning": false,
  "usernameEnv": "KAFKA_USERNAME",
  "passwordEnv": "KAFKA_PASSWORD"
}
```

From this repository's root, with the registry API token already in
`DKG_REGISTRY_TOKEN`:

```sh
node packages/kafka-source/src/enroll-cli.mjs \
  --registry-url http://127.0.0.1:9200/api/kafka/streams \
  --registry-context-graph stream-catalog \
  --ual 'did:dkg:31337/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1' \
  --registry-token-env DKG_REGISTRY_TOKEN \
  --options kafka-local-options.json \
  --out kafka-source.private.json
```

The packaged binary is `dkg-kafka-enroll`. Optional `--expected-hash` and
`--expected-publisher` pin a previously inspected descriptor digest and native
publisher attribution. The resolver rejects redirects, mismatched graph/UAL,
invalid hashes, ambiguous descriptors and responses over 1 MiB. It makes one
authenticated registry read and no Kafka connections. Errors do not echo the
registry token or response body.

The output is **one source object**, to add to the existing private Source Worker
config's `sources` array. It is created with mode 0600 and refuses to overwrite
an existing file. It contains environment variable names, never their values.
Keep the existing `daemonUrl`, `daemonToken`, `stateFile` and `handlerModule`
in the parent worker config, then use the existing `dkg source-worker run`.

The resulting `registryRef` embeds the validated descriptor, selected UAL,
catalog graph, digest and available publisher attribution. The worker checks
this pin against broker/topic/transport settings **before opening its journal or
connecting to Kafka**. Polling uses the local snapshot, so it adds no registry
HTTP reads during the existing durable Retry-After cooldown.

Enrollment supports `SSL`, `SASL_SSL` with PLAIN/SCRAM-SHA-256/SCRAM-SHA-512,
and `PLAINTEXT` only with `"allowPlaintext": true` in the local options.
Bootstrap URLs must use `kafka://` or `kafkas://`, specify a port, and contain
no credentials, query, fragment or non-root path. Missing auth metadata defaults
to TLS. SASL requires local `usernameEnv`/`passwordEnv` references. Legacy
registrations without `clusterId` require an explicit local stable `clusterId`.
Schema references and data formats are descriptive; enrollment adds no schema
fetching, Avro/Protobuf decoding or domain mapping.

New records include the registration UAL, catalog graph, descriptor digest and
available publisher attribution. The pin participates in the KA identity for
enrolled sources. Unchanged snapshots replay the same KA across restarts;
manually configured sources keep their existing identities. A changed source
configuration is rejected by the existing journal scope check, not silently
reset. Select a new registration and deliberately provision a new source/state
when changing the stream; the helper never rewinds broker offsets.

## What gets stored

Each consumed record becomes one named KA. It contains the original Kafka key,
value and header **bytes encoded as base64**, broker timestamp, topic,
partition, exact decimal offset, stable cluster/source IDs and first fetch
time. Tombstones remain `valueBase64: null`. Non-JSON records work without a
mapping. An optional list of `{field,predicate}` projects top-level JSON values
to operator-selected RDF predicates as string literals. It does not infer
business meaning, units or environmental results.

Record identity derives from cluster/topic/partition/offset and projection
configuration. Re-reading the same position preserves its first fetch time and
reuses its KA. Identical payloads at different offsets are distinct Kafka
events. Recreating a topic requires a new stable `clusterId`/source namespace;
otherwise reused positions with changed bytes are rejected. Changing source
configuration requires a new state location and deliberate offset selection.

## Recovery and privacy

1. The DKG worker asks the handler for a bounded delivery fingerprint. Before
   its first poll the handler durably records each partition's starting offset,
   using an existing broker commit, the earliest retained offset, or the initial
   tail according to configuration. Empty polls do not choose a new tail.
   Each poll selects one assigned partition in persisted round-robin order;
   successful and empty deliveries advance that cursor, failed ones resume.
2. The handler stages up to ten records (configurable, at most 100) in a local
   SQLite journal, with a 24 KB envelope budget per delivery.
3. It verifies that the configured Context Graph is private, writes each KA
   through `/api/knowledge-assets`, and reads the intended entity triples back
   from the **immutable graph named by the sealed WM descriptor**. Native DKG
   graph annotations are separate from the source entity.
4. Only then does it explicitly commit Kafka `offset + 1`. Native DKG Source
   Worker status and receipts persist in its usual source state file. Per-
   partition checkpoints and uncertain write intents persist in SQLite. Native
   sealed readback compares canonical RDF values, so equivalent escape spelling
   does not fail verification. Original Kafka envelope bytes/digests stay raw.

`autoCommit` and `eachBatchAutoResolve` are disabled. A DKG failure never
acknowledges the affected offset. A failed offset commit replays the same KA.
A lost write response is recovered through named sealed readback. If a prior
write might still be running and no sealed KA is visible, the handler stops
with `DKG_WRITE_OUTCOME_UNKNOWN`; it does not blindly issue another create.
An existing partial draft needs operator recovery. The Source Worker retry
limit leads to manual review rather than dropping a poison message. Preparation
failures are deferred into the native worker's processing catch so their retry
state persists and unrelated sources continue. The adapter still uses the
existing fingerprint/processing hooks; no general worker API refactor is added.

The daemon ingress's specific `429 / Too many requests` rejection clears write
intent transactionally and persists `Retry-After`. Waiting polls do not consume
additional retry attempts or send HTTP requests, including preflight reads.
The saved deadline survives handler restarts; after it expires, private graph
validation and sealed readback run again before Kafka acknowledgement.
Other HTTP errors and transport failures retain
uncertain-write protection, with sanitized status codes stored in the journal;
there is no blanket retry of arbitrary 4xx/5xx responses.

The handler never shares to SWM, submits VM publication, creates Context Graphs,
grants permissions or changes broker ACLs. The operator must provision the
private graph and its existing authorized agent. Kafka SASL uses TLS with normal
certificate verification. Plaintext is available only by explicitly setting
`ssl: false`, as in the localhost integration test. Journals are mode 0600;
keep the containing state directory private. Locks are not automatically broken
after a crash: confirm the old worker is dead before removing its lock.

Kafka group IDs must be authorized by the broker owner. `fromBeginning: false`
means a **new** group starts at the latest offset; an existing group's committed
position supplies a new journal's initial position. Later polls resume the
journal's durable position even if no broker offset has ever been committed.
An explicit backward broker offset reset can replay existing KAs; use a
dedicated test group for replay experiments. A saved position outside broker
retention fails closed instead of silently accepting Kafka's reset policy.
`readTimeoutMs` is the idle-fetch budget **after** consumer startup/group join;
slow startup cannot be reported as a successful empty delivery.

### Fetch-time retention protection

KafkaJS 2.2.4 normally resets an expired offset internally and can commit that
reset even with `autoCommit: false`. A bounds check alone cannot prevent a
retention race. This workspace carries an explicit pnpm patch adding the
opt-in `autoOffsetReset: false` consumer policy. The handler requires that
policy and checks the capability before connecting that consumer; an unpatched
installation fails with `KAFKA_OFFSET_RESET_GUARD_REQUIRED`. Other consumers
retain KafkaJS's default behavior. Install using the workspace frozen lockfile
so the patch is applied; a bare upstream KafkaJS install is insufficient.

The guard throws a non-retriable `KAFKA_OFFSET_OUT_OF_RANGE` before reset I/O.
The native worker persists that source failure without acknowledging Kafka,
advancing checkpoints or marking the partition done. An operator must decide
how to handle records already lost to retention; ingestion does not guess.

The configured identity needs topic offset/metadata and group offset-read
permissions in addition to its consume/commit permissions.

## Validation

```sh
pnpm --filter @origintrail-official/dkg-source-kafka test
DKG_KAFKA_TEST_CONFIG=/absolute/path/to/integration.private.json \
  pnpm --filter @origintrail-official/dkg-source-kafka test:broker
# Broker-only polling regressions: no DKG requests/writes or unverified acks.
DKG_KAFKA_TEST_CONFIG=/absolute/path/to/integration.private.json \
  pnpm --filter @origintrail-official/dkg-source-kafka test:broker --polling-only
```

The unit/contract suite drives the **actual canary Source Worker**, with a
deliberately labelled HTTP lifecycle double for failure cases. The opt-in
integration uses a real local Kafka-compatible broker, native Source Worker,
and real DKG HTTP lifecycle endpoints. The operator-provided integration JSON
contains `brokers`, `daemonUrl`, `daemonToken`, `agentAddress`, `contextGraphId`.
It writes only synthetic examples into the specified pre-provisioned graph.
It creates its own broker topic/group and resets **that test group's** offsets
to prove replay. Both suites import the workspace's native
`packages/agent/src/source-worker.ts` directly, so CI can track the dependency.

Tested scenarios include lost responses, readback mismatch, offset-commit
failure, empty polls, tombstones, changed bytes at the same position, and
re-reading records without additional KAs. See `POC-VERIFICATION.md` for actual
run evidence and deployment boundaries.

The kafka-plugin live-daemon E2E also exercises registry enrollment, native
private-WM sealing and restart/replay. Its normal mode uses a labelled synthetic
Kafka delivery with real DKG HTTP lifecycle calls. To use an actual disposable
Kafka-compatible broker for that same test:

```sh
DKG_KAFKA_REGISTRY_BROKER=127.0.0.1:19096 \
  pnpm --filter @origintrail-official/kafka-plugin test:coverage
```

This suite provisions a local Hardhat network and temporary DKG nodes. In broker
mode it creates/deletes its own topic and uses its own consumer group, and
verifies the broker offset before replay. It does not need partner infrastructure.

This remains a bounded PoC. It does not provide a new Sources UI, broker-side
exactly-once transactions, Protobuf/Avro decoding, Schema Registry, automatic
topic discovery, cross-machine journal sharing, or domain-specific mapping.
One KA per Kafka event is intentionally simple; high-throughput packing needs
separate design and benchmarking. Node must satisfy the DKG engine range and
provide `node:sqlite` (tested on Node 24/25).

Kafka offset/session behavior follows the [KafkaJS consumer API](https://kafka.js.org/docs/consuming).
