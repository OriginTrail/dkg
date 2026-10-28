# @origintrail-official/dkg-storage

Triple store abstraction layer for DKG V10. Provides a unified API over multiple RDF storage backends with named graph management and private content storage.

## Features

- **Backend adapters** — pluggable triple store implementations:
  - `OxigraphStore` — embedded WASM/native store, no external dependencies
  - `OxigraphWorkerStore` — worker-thread variant; keeps the daemon event loop free, with a per-read-operation timeout (see below)
  - `BlazegraphStore` — connects to a running Blazegraph SPARQL endpoint
  - `SparqlHttpStore` — generic adapter for any SPARQL 1.1 compliant endpoint
- **Graph manager** — named graph lifecycle (create, drop, list) with contextGraph-scoped data and metadata graphs
- **Private content store** — encrypted triple storage for private KA triples, separate from the public graph
- **Custom adapters** — `registerTripleStoreAdapter()` to plug in any storage backend

## Usage

```typescript
import { createTripleStore, GraphManager } from '@origintrail-official/dkg-storage';

// In-memory store
const memStore = await createTripleStore({ backend: 'oxigraph' });

// Persistent store (requires a path)
const store = await createTripleStore({
  backend: 'oxigraph-persistent',
  options: { path: './data' },
});

const graphs = new GraphManager(store);

await store.insert(quads);
const result = await store.query('SELECT * WHERE { ?s ?p ?o } LIMIT 10');
```

## Oxigraph persistence contract

This contract applies to `OxigraphStore` when it is created with a persistence
path (`oxigraph-persistent`) and to `oxigraph-worker` when that worker is given
a persistence path. Plain `oxigraph`, and a worker without a persistence path,
are in-memory stores and provide no restart durability.

### Mutation and flush semantics

- Mutations update the in-memory store immediately and schedule a full N-Quads
  snapshot after a 50 ms debounce. A successful mutation does not by itself
  mean the snapshot has reached disk.
- Callers that require an operation to survive an immediate restart must await
  `flush()`. It cancels a pending debounce, waits for an in-flight snapshot,
  and then writes the current state.
- A snapshot is written to a sibling temporary file, the file is synced, and
  then atomically renamed over the persistence file. The containing directory
  is synced when the platform supports it. A crash before the rename retains
  the previous complete snapshot; a temporary file may remain for cleanup.
- Background flush failures are logged. Explicit `flush()` and `close()` calls
  reject on write, sync, or rename failures so their callers can report that
  recent in-memory changes may not be durable.
- Serialization writes N-Quads in chunks, and hydration feeds file chunks into
  one parser. A snapshot can exceed V8's approximately 512 MiB single-string
  limit. Existing `store.nq` files keep the same format, including blank-node
  links across chunks. Individual RDF terms must still fit in memory.
- This remains an in-memory backend with full snapshots. Capturing a consistent
  snapshot allocates a native quad array proportional to the number of quads;
  streaming its text does not bound total memory or eliminate full-store disk
  writes. For large continuously growing graphs, use `oxigraph-server` or
  Blazegraph and provision memory and disk for the workload.

### Hydration and corruption

- Construction synchronously loads an existing non-empty persistence file.
  Read failures abort construction.
- Invalid N-Quads are never swallowed. The file is renamed to
  `<persist-path>.corrupt-<timestamp>` for forensics, the failure is logged,
  and construction throws. A later start can continue with an empty store
  while the quarantined file remains available for investigation.

### Graceful shutdown

- `close()` cancels the debounce, waits for any in-flight snapshot, and runs a
  final flush. For `oxigraph-worker`, the close request delegates to that same
  final flush and is not subject to the read-operation timeout; the worker is
  terminated only after the request settles.
- `DKGAgent.stop()` awaits `store.close()`. If the final flush fails, shutdown
  continues but emits a loud operator-facing error stating that the on-disk
  store may be missing recent inserts.
- Forced termination can still lose changes made after the last successful
  flush. The atomic snapshot protocol protects the previously persisted file
  from a torn overwrite; it cannot make unflushed memory durable.

The executable regression contract is in
[`test/oxigraph-persistence.test.ts`](test/oxigraph-persistence.test.ts) and
[`test/oxigraph-large-persistence.test.ts`](test/oxigraph-large-persistence.test.ts).
After building the storage dependency closure, run
`node scripts/repro/oxigraph-large-snapshot.mjs` from the repository root for
the larger native-worker check. It writes about 558 MB, verifies every value,
kills the child process after `flush()`, and checks a fresh worker can reopen
the data. Allow space for the snapshot and its temporary replacement, and run
it separately from other memory-intensive devnet workloads. It uses long
literals to cross the string ceiling; it is not a high-cardinality benchmark.
The
[archived WM persistence incident report](../../docs/archive/internal/bugs/wm-persistence-regression.md)
retains the original diagnosis, reproduction evidence, and fix history.

## Embedded worker store (`oxigraph-worker`) tuning

The embedded worker runs **all** store operations on a single worker thread, so
a long-running or stuck op (a huge import, an expensive query) blocks every
other store-backed request behind it. Under real load this surfaces as the
daemon's `/api/status` staying green while `/api/query`,
`/api/context-graph/list`, and `/api/assertion/create` hang. A `store.options`
knob bounds that blast radius:

| Option | Default | Purpose |
|---|---|---|
| `operationTimeoutMs` | `120000` | Reject a **read-only** op (`query`, `hasGraph`, `listGraphs`, `countQuads`) that exceeds this instead of hanging forever — that's where the user-visible hang shows up. `0` disables (restores unbounded behaviour). `close` is exempt — its final flush always runs to completion so shutdown can't drop pending writes. |

Mutations (`insert`, `delete`, …) are intentionally **not** bounded by this
timeout. The bound only drops the *caller's* promise — the single worker thread
keeps running the op — so a "timed-out" write could still commit afterwards,
and the rest of the codebase treats a rejected `insert`/`delete` as a clean
failure. Bounding only reads surfaces a wedged worker on the paths that hang
without inventing an indeterminate write outcome. `insert()` therefore stays
strictly atomic (all quads commit or the call fails), which callers rely on.

```jsonc
// ~/.dkg/config.json
"store": {
  "backend": "oxigraph-worker",
  "options": { "operationTimeoutMs": 120000 }
}
```

For heavy / production workloads, prefer an out-of-process SPARQL server
(`sparql-http` or `blazegraph`), which handles reads and writes concurrently
and keeps the daemon responsive under load.

## External-store admission and deadlines

All external adapters share a process-wide priority scheduler. Waiting work is
bounded independently for `ack`, `normal`, and `background` traffic, and an
operation rejected before dispatch receives `StoreSchedulerBusyError` with
`code: STORE_SCHEDULER_BUSY`, `retryable: true`, and a reason of either
`queue_full` or `queue_wait_timeout`. Because this error is only created before
the operation closure starts, retrying it cannot duplicate a write that might
already have reached the store.

Each external adapter supplies the canonical store operation as queue-entry
metadata, and the scheduler binds it when creating either admission rejection.
Decorators validate that tagged operation-outcome contract rather than the
error class alone: a rejected nested read does not imply that an enclosing
replace failed before mutation.

OTel is opt-in, so the scheduler also keeps its rejection and wait figures
in-process. The `dkg.store.scheduler_rejections_total` counter carries
`priority`, `reason` and `operation_family` (the first two dot-separated
segments of the caller's `source`, such as `publisher.asyncLift`; at most 64
families per scheduler, then `other`). `takeStoreSchedulerStatsReports()` returns,
for each registered scheduler, the queue waits of each lane since the previous
call (`queueWaits`) and the cumulative rejections by lane, family and reason. A
lane's figures are its longest wait and the count of its waits in fixed buckets.
Every started operation counts, including one that starts at once, as a wait of
about 0 ms; so do those that time out in the queue or are cancelled there. A
rejection on a full queue never queued, so it adds no wait. The buckets
(`queueWaitBuckets`) have the inclusive upper bounds in
`STORE_QUEUE_WAIT_BUCKET_UPPER_MS`: 83 bounds from 1 ms to 10000 ms (the default
queue-wait timeout) that grow by about 10 % per step (`round(1.1 ** k)`, with
duplicates dropped, then 10000), plus an overflow bucket for anything longer.
The list is fixed, because figures from different builds are compared;
`queueWaitCount` is the sum of the counts.
`estimateQueueWaitPercentileMs(buckets, 0.95, maxQueueWaitMs)` turns counts into
a P95: the upper bound of the bucket that holds the rank, so it overstates the
true value by at most one step (15 % from 7 ms up), it is 0 for an empty
interval, and in the overflow bucket it is the interval maximum. Counts of
several intervals add up, so the same function gives the P95 of a longer window;
P95s of single intervals do not. Each call ends the interval, so only the
periodic admission log line should call it.

| Environment variable | Default | Purpose |
|---|---:|---|
| `DKG_STORE_MAX_CONCURRENT` | `4` | Maximum external-store operations in flight, capped to available CPUs while preserving the default ACK reserve on single-CPU hosts. |
| `DKG_STORE_ACK_RESERVED_SLOTS` | `1` | In-flight capacity reserved for ACK work. |
| `DKG_STORE_NORMAL_RESERVED_SLOTS` | `1` | Non-ACK capacity kept available for normal work while background operations are in flight. |
| `DKG_STORE_BACKGROUND_RESERVED_SLOTS` | `1` | Non-ACK capacity reserved for background progress. |
| `DKG_STORE_QUEUE_LIMIT` | `64` | Maximum waiting operations in each priority queue. |
| `DKG_STORE_ACK_QUEUE_LIMIT` | common limit | Optional ACK queue override. |
| `DKG_STORE_NORMAL_QUEUE_LIMIT` | common limit | Optional normal queue override. |
| `DKG_STORE_BACKGROUND_QUEUE_LIMIT` | common limit | Optional background queue override. |
| `DKG_STORE_QUEUE_WAIT_TIMEOUT_MS` | `10000` | Maximum pre-dispatch wait before a retryable busy rejection. |
| `DKG_BLAZEGRAPH_OPERATION_TIMEOUT_MS` | `30000` | Blazegraph end-to-end operation deadline, including scheduler wait, HTTP, response decoding, and mapping. |

Normal and background reserves are normalized against the available non-ACK
capacity. At least one background slot remains available, and the background
progress floor is capped to its admission ceiling so conflicting custom values
cannot leave usable capacity idle.

When only one ordinary slot remains after ACK and health reservations, a
positive background reservation instead guarantees dispatch opportunities:
at most eight normal operations start while background work waits before one
background operation gets its turn. A fresh backlog starts with normal work;
ACK and health retain priority. This does not bound elapsed waiting time,
because admitted operations are not preempted. Setting
`DKG_STORE_BACKGROUND_RESERVED_SLOTS=0` retains strict normal-before-background
ordering. Schedulers with multiple ordinary slots retain their capacity reserves.

### Queue control path

The async share and publisher queues can run their own store calls on two small
schedulers of their own, beside the shared one (OT-RFC-73 S1), so queue
bookkeeping never waits behind client reads or data-plane work. The shared
scheduler's lanes, limits and `StorePressureSnapshot` are unchanged; the
control schedulers add slots on top of them: one for the share queue and two for
the publisher queue, which are also the caps. Each is built only for a queue
whose configured slots are above 0, once per process, with every capacity
option explicit (no ACK, health, normal or background reserve; the shared
scheduler's queue limit and wait as values; the same timeout diagnostics).

A call reaches its queue's scheduler by naming the queue and nothing else:

```ts
import { controlStoreOptions } from '@origintrail-official/dkg-storage';

await store.query(sparql, { ...controlStoreOptions('share', 'publisher.asyncPromote.writeJob'), signal });
```

`controlStoreOptions(queue, source)` returns `{ source, controlQueue: queue }`
and sets no priority. When the queue's path is on, the `blazegraph` and
`sparql-http` adapters run the call on that queue's scheduler in one fixed lane
that is reported as `control` (in the `503` body's `priority`, metric
attributes, the backpressure registry under `store-control-share` /
`store-control-publisher`, and the queue-wait stats), whatever `priority` or
ambient `withDefaultStoreWorkPriority` lane the caller has. When it is off, the
call resolves exactly like the same call without the tag. Embedded Oxigraph
backends run no store scheduler and so never use the path, whatever its
setting.

| Setting | Default | Purpose |
|---|---:|---|
| `DKG_STORE_CONTROL_RESERVED_SLOTS` | unset | `0` turns the path off. `share:1,publisher:2` sets the slots per queue (caps: share 1, publisher 2; a queue left out gets 0; a higher number is clamped with a warning). A malformed value, or a variable that is set but blank, is refused with a warning and leaves the path off. An explicit value is honoured on any host and with any backend. Wins over the config value when set. Read once at start. |
| node config `store.controlReservedSlots` | absent | The same values (also the number `0`), used when the variable is unset. A malformed value (`null`, `true`, any number but `0` included) is refused with a warning that names the key and leaves the path off. Read by the daemon only. |

With neither setting, the default (OT-RFC-73 P14) is share 1 + publisher 2 for
a node whose configured backend is `blazegraph` (`STORE_CONTROL_DEFAULT_BACKENDS`)
on a host with more than 2 CPUs (`availableParallelism()`), and off for every
other node: 2 or fewer CPUs, managed `oxigraph-server`, `sparql-http` and any
other backend. A malformed value never falls through to the other setting or
to the default.

The daemon calls `configureStoreControlPath({ backend, configured })` with the
node's `store.backend` (the configured name, so managed Oxigraph is
`oxigraph-server`, not its runtime `sparql-http` view) and
`store.controlReservedSlots`, before any store call can build the path, and
then logs the effective geometry and the setting that decided it once
(`logStoreControlPathGeometry`), for example `Store control path: on (added
slots share=1 publisher=2; default for blazegraph, 8 CPUs; effective until
daemon restart)`. The path is built once; a configuration after that is
refused with a warning (a repeat of the same settings is accepted). A process
that never configures the path (a standalone tool, a benchmark, a test) has no
backend and no config value, so only the variable can turn its path on.
`resolveStoreControlConfig(env, { cpus, backend, configured })` is the pure
resolver behind it. Tests replace the process-wide path with
`setStoreControlPathForTesting(buildStoreControlPath(...))`, and
`setStoreControlPathForTesting(undefined)` returns the process to the
unconfigured state.

Blazegraph's deadline can also be set per store, which takes precedence over
the environment default:

```jsonc
"store": {
  "backend": "blazegraph",
  "options": {
    "url": "http://127.0.0.1:9999/blazegraph/namespace/dkg/sparql",
    "timeout": 30000
  }
}
```

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration types, logging, constants

## Atomic subject replacement with additive rows

`replaceSubjectAndInsert(graphUri, subject, replacementQuads, insertQuads, options)`
replaces exactly one subject and adds companion rows for other subjects in the
same named graph in one backend transaction. Both groups must be blank-node free;
validation runs before mutation or external literal storage. Companion subjects
are never deleted, so missing immutable request rows can be reasserted while
preserving existing extra rows. The existing `replaceSubject` remains strictly
single-subject.

The optional `tryReplaceSubjectAndInsertAtomically` returns `false` only when the
capability is absent or gives its matching typed preflight refusal. Generic
SPARQL endpoints need a certified `atomic-update` consistency profile. Execution,
timeout and postcommit decorator failures propagate: callers must not replay
through a compatibility fallback after these errors. One HTTP request alone is
not evidence that an arbitrary endpoint is transactional.
