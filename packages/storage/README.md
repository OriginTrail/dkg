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

Confirmed named KA lifecycle repair keeps its fsynced journal until the metadata
store certifies persistence through `commitment.commit()` with a `restart-durable`
guarantee. Snapshot adapters with a persistence path complete `flush()` before the
journal entry is retired. A SPARQL endpoint that durably commits before returning
successful mutation responses may opt in with
`options.writesDurableOnAcknowledgement: true`; this promise is independent of
its `consistencyProfile` transaction/readback guarantees. Use that option only
when the endpoint guarantees persistence. The `blazegraph` adapter defaults it to
`true`, because Blazegraph forces each acknowledged commit to its standard
`DiskRW` journal; set it to `false` for a `MemStore`/`Transient` journal or
`forceOnCommit=No`. Without either a durability barrier
or that acknowledgement contract, confirmed repair remains pending with its
journal evidence retained. Transparent decorators and the agent store facade
compose this callable explicitly. Queued decorators drain their completed mutations
before the inner barrier; optional `flush`, acknowledgement flags on arbitrary objects,
and decorator topology do not certify persistence. The external-literal decorator
syncs newly created or verified blob files and their directory entries before
acknowledging the referencing mutation; sync failures propagate and retry verifies
the existing immutable bytes.

This contract applies to `OxigraphStore` when it is created with a persistence
path (`oxigraph-persistent`) and to `oxigraph-worker` when that worker is given
a persistence path. Plain `oxigraph`, and a worker without a persistence path,
are in-memory stores and provide no restart durability.

Standalone SDK agents without a data directory may use a `process-local`
commitment. Decorators compose the same `commitment.commit()` boundary and retain
its declared durability while draining queued mutations. A process-local commit
finishes metadata within the current process; it cannot retire a durable repair
journal. Durable hosts require a `restart-durable` commitment, while uncertified
remote endpoints expose no commitment. Standalone agents also use the stronger
guarantee when their backing store supplies it.

A replaceable worker also exposes `commitment.capture()`. Capture its barrier
before the attempt's reads and writes, then invoke that barrier after mutations
finish. Decorators capture before their own awaited drains. A worker replacement
invalidates every barrier captured from the old worker, so a successful flush
of its replacement cannot certify lost writes. Recovery captures a fresh barrier
and reapplies its metadata before retiring the journal. The worker's unscoped
`commit()` remains bound to its original worker and refuses certification after
replacement; ordinary `flush()` remains available but cannot prove that lost
mutations were reapplied.

### Mutation and flush semantics

- Mutations update the in-memory store immediately and schedule a full N-Quads
  snapshot after a 50 ms debounce. A successful mutation does not by itself
  mean the snapshot has reached disk.
- Callers that require an operation to survive an immediate restart must await
  `flush()`. It cancels a pending debounce, waits for an in-flight snapshot,
  and then writes the current state.
- A snapshot is written to a sibling temporary file, the file is synced, and
  then atomically renamed over the persistence file. The containing directory
  is synced when the platform supports it. If the snapshot path's directories
  had to be created, every parent of a new directory is synced too, up to and
  including the first one that already existed; after a failed sync the next
  flush retries that whole range. A crash before the rename retains
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
