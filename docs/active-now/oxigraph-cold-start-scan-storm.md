# Oxigraph cold-start scan storm: durable fix and canary plan

Status: implementation and focused regressions complete; the required 30-minute,
10.3-million-quad canary soak still has to be run on an 8 GiB-equivalent host.
Do not treat the focused test results below as that acceptance run.

## Root cause and event timeline

The incident was store-cgroup exhaustion, not a host OOM. The host recorded no
kernel OOM, disk, filesystem, thermal, or hardware failure. Oxigraph alone
reached its 6 GiB cgroup limit (about 6.3 GiB anonymous memory), and its watchdog
restart fed cold callers back into the same retry cycle.

| UTC | Event | Concurrency consequence |
| --- | --- | --- |
| ~15:36 | rollout detected | four nodes approached the same lifecycle boundary |
| ~16:01 | releases swapped and nodes restarted close together | process-local finalization/reconcile negative state disappeared; every node immediately primed reconciliation |
| 16:01 onward | finalization, per-CG reconcile, inbound/outbound sync, responder, promotion, and probes resumed | the startup sweep detached work for every subscribed CG; equivalent finalization/reconcile scans had no shared promise |
| during slow reads | client timeouts and retries fired | no scan-key coalescing prevented a new logical caller from starting the same read; the global sync limiter did not cover the other producers |
| during response handling | `agent.finalization.sharedMemorySlice` used unbounded `CONSTRUCT`, and the HTTP adapter used `Response.text()` | one response could become a large Oxigraph result plus a single large JS string and parsed quad array |
| 16:45:41 | Oxigraph cgroup OOM on beacon-04 | watchdog restarted Oxigraph; callers retained cold state and retried again |

The dominant query source was `agent.finalization.sharedMemorySlice`. The
existing handler memo was process-local, and the outer VM-reconcile cache
deliberately refused to cache misses once incomplete operations existed. That
made the exact common `published elsewhere`/never-match case repeat its full
operation scan after a restart and again on each sweep. The emergency switches
worked because they reduced aggregate admission and removed three retry
producers; they did not remove the underlying overlap or materialization shape.

## Implemented boundaries

1. Equivalent finalization and chain-reconcile scans are keyed single-flights.
   The keys cover context graph, namespace, root set or merkle root, KA graph
   bound, catalog-floor policy, and observed write generation where applicable.
   A join cannot start a second store attempt while the first promise is alive.
2. Finalization/reconcile SWM slices now use stable ordered `SELECT` pages. The
   default hard budget is 1,000 rows/page, 250,000 retained rows, and a
   conservative 128 MiB heap estimate. Crossing a budget raises the retryable
   `SHARED_MEMORY_RESULT_BUDGET` error; it is never interpreted as an empty or
   complete snapshot.
3. The process-global HTTP-store scheduler is the aggregate budget for all
   callers and is shared by both the dedicated `BlazegraphStore` adapter and
   the generic `SparqlHttpStore` used by Oxigraph server. Its safe default is
   four admitted operations, with separate ACK and health reserves and a
   protected normal-query slot plus a background floor. Finalization and
   reconciliation use the background lane; `/api/status` uses the health lane.
   Inbound/outbound sync and promotion enter through the same adapter-neutral
   admission policy.
4. Cold reconciliation starts after a deterministic peer-derived delay in
   `[0, 30s]`. Startup/interval sweeps join one process-wide promise, and the
   periodic reliability pass runs context graphs sequentially instead of
   detaching all CG scans at once.
5. Negative reconcile records are stored in `node-ui.db` schema 29. On a
   changelog-enabled node, `(era, seq)` is the O(1), restart-durable write
   generation. Without changelog, bounded content fingerprints plus the live
   graph-write counter fail open to a rescan. Topology, namespace, content,
   generation, root, and TTL/backoff changes invalidate the record.
6. Expensive miss retries use capped exponential backoff with deterministic
   per-peer jitter. Existing active-fetch attempt/cooldown budgets remain in
   force; network-unavailable outcomes are not persisted as store negatives.
7. HTTP timeout/caller cancellation holds the scheduler slot until the actual
   fetch or response-body promise settles. This contract is enforced for both
   `BlazegraphStore` and `SparqlHttpStore`: a retry cannot be started by the
   same awaited path before the client transport reports cancellation
   completion, and an equivalent retry joins the running single-flight. A
   shared adapter-conformance test models delayed server cleanup and requires
   peak concurrent attempts to remain one. The canary must still verify that
   the deployed server version cancels execution on connection abort; SPARQL
   has no separate query-cancel RPC that the client can prove locally.
8. Outbound sync-page single-flight identity excludes the caller's absolute
   deadline. Two triggers for the same peer, CG, graph, phase, snapshot, and
   cursor mode now share the page sequence even when their time budgets were
   computed milliseconds apart. The leader's bounded deadline remains in
   force; a join cannot supersede the responder session or start a duplicate
   scan.
9. Sync requests use a frame-safe 64-row page derived from the protocol's
   10 MiB read cap and the maximum supported 65,535-byte RDF literal. The
   responder keeps accepting the legacy 500-row limit for rolling compatibility.
   Sync ingest then writes through adapter-neutral, conservatively estimated
   8 MiB batches, bounding both SPARQL UPDATE and Blazegraph ASCII-safe N-Quads
   materialization while releasing shared store admission between chunks.

New telemetry:

- `dkg.store.scan_singleflight_joins_total`
- `dkg.store.scan_singleflight_active`
- `dkg.store.scheduler_active`
- `dkg.store.scheduler_queue_wait_ms`
- `dkg.store.scheduler_rejections_total`
- `dkg.store.query_result_rows`
- `dkg.store.query_result_bytes_estimate`
- `dkg.store.cancellation_completed_total`
- `dkg.store.retry_attempts_total`

## Focused regression evidence

The implementation was built across core, storage, publisher, agent, node-ui,
and CLI. Focused tests cover:

- one scan for two concurrent equivalent reconcile requests;
- no retry return until the aborted HTTP attempt has finished cleanup, under
  both Oxigraph-compatible SPARQL HTTP and dedicated Blazegraph adapters;
- restart rehydration with zero repeated scan/fetch, plus invalidation on data,
  same-count replacement, private-root, namespace, and topology changes;
- aggregate finalization/reconcile/inbound-sync/outbound-sync/promotion admission;
- ACK and health progress while background is saturated;
- row-budget rejection after paged materialization;
- deterministic separation of four cold peers.

These are regression proofs, not production capacity measurements.

## Focused 200 MiB sync simulation

An isolated two-core-node devnet used the production-default managed Oxigraph
0.5.8 server backend, dedicated API/libp2p/store/Hardhat ports, durable sync,
sync-on-connect, and the normal 120-second per-graph deadline. Node 2 was stopped
while node 1 accepted 6,400 shared-memory triples with 32,768-byte literals:
exactly 209,715,200 lexical bytes. Node 2 was then restarted and peer-pinned
catch-up was invoked until the checkpointed phase converged.

The simulation found and fixed two size boundaries before the passing rerun:

| Run | Result | Finding / correction |
| --- | --- | --- |
| 1 | 0 / 6,400 | legacy 500-row responses exceeded the 10 MiB protocol read limit; requester page size reduced to the frame-safe derived value of 64 |
| 2 | 1,600 / 6,400 before stop | pages transferred, proving the frame fix; the fixed phase deadline intentionally checkpointed partial progress rather than being lengthened |
| 3 | 0 / 6,400 before stop | concurrent triggers shared the 4,288-row fetch after deadline was removed from the coalescing key, but each tried one ~141.1 MB store insert; sync ingest was changed to 8 MiB adapter-neutral batches |
| 4 | 6,400 / 6,400 | converged in two checkpointed rounds with no read-limit, stream-reset, oversized-insert, page-retry, heap/OOM, or invalid-string event |

Passing-run evidence (`20260714T193735Z`):

- source and target run-specific counts: `6,400 / 6,400`;
- sync duration from target restart through read-back: 207 seconds;
- progress: 4,160 after round 1, 6,400 after round 2;
- peak Oxigraph RSS: 224.3 MiB source, 242.0 MiB target;
- on-disk Oxigraph directories at completion: 584 MiB source, 497 MiB target;
- result bundle: `/tmp/dkg-devnet-sync-200m-20260714T193735Z`;
- teardown verified all dedicated ports free and restored the tracked
  `localhost_contracts.json` byte-for-byte.

Docker was unavailable, so this live simulation covered managed Oxigraph only.
The byte estimator explicitly accounts for Blazegraph's ASCII-safe expansion,
and the focused tests cover the dedicated Blazegraph adapter, but this is not a
Blazegraph live-volume result. It also does not replace the four-node,
10.3-million-quad, 30-minute acceptance run below; daemon RSS/heap and host PSI
were not captured by this two-node harness.

## Five-node 1 GiB update-and-restart simulation

An isolated five-core-node devnet then exercised one source plus four
simultaneous cold targets. Node 1 accepted 32,768 shared-memory triples with
32,768-byte literals: exactly 1,073,741,824 lexical bytes. Before catch-up, the
agent and CLI artifacts were rebuilt to simulate a same-version deployment,
node 1 was restarted on its populated store, and nodes 2-5 were restarted
concurrently. All five restart commands exited zero, and every node retained
its libp2p peer ID.

The larger run found two responder boundaries that the 200 MiB run could not:

1. A full SPARQL-over-HTTP snapshot could exceed V8's single-string limit
   before the existing retained-row budget saw the response. The responder now
   constructs retained session snapshots from stable ordered store pages, so no
   unbounded HTTP response is materialized; crossing the row or heap budget
   switches that session to the same bounded page loader.
2. The old fresh-SWM fallback put every candidate graph behind a global
   `FILTER EXISTS` join. Oxigraph timed that query out at 30 seconds on the
   1 GiB graph. The replacement builds a session-cached graph/root/count plan
   with backend-neutral SPARQL 1.1, then pages one concrete graph with
   `VALUES ?root`. Its mapping and count probes took about 5.1 and 4.6 seconds;
   steady 64-row pages were generally 0.13-0.35 seconds.

The four targets converged with checkpointed progress rather than longer phase
deadlines:

| Node | Backend at final read-back | Observed run-specific count progression |
| --- | --- | --- |
| 2 | managed Oxigraph server | 14,868 -> 19,136 -> 32,768 |
| 3 | in-process Oxigraph | 22,848 -> 31,232 -> 32,768 |
| 4 | in-process Oxigraph | 23,040 -> 32,768 |
| 5 | managed Oxigraph server after fallback correction | 13,120 -> 32,768 |

Node 5 deliberately exposed a devnet-matrix defect. With external Docker
unavailable, nodes 5-6 had omitted their store block and silently selected the
embedded `store.nq` backend. At this volume its whole-file persistence path
repeatedly failed with V8's `Cannot create a string longer than 0x1fffffe8`
limit. That volatile state was not counted as success. The devnet generator now
uses a distinct daemon-managed Oxigraph server for nodes 5-6 whenever the
external Oxigraph container is unavailable. Node 5 was reset onto that managed
backend, re-synchronized to 32,768, restarted again, and returned 32,768 after
boot with the same peer ID. This final restart is the persistence proof for the
corrected fallback.

Passing-run evidence (`20260714T200912Z`):

- final run-specific counts: `32,768 / 32,768` on all five nodes;
- source population time: 657 seconds;
- end-to-end sync window: 4,093 seconds, including diagnosis, live rebuilds,
  backend correction, and the final persistence restart; it is not a clean
  throughput benchmark;
- peak aggregate process RSS by node: 1,934.1, 1,581.5, 1,362.2, 1,372.7, and
  1,217.2 MiB respectively. These are mixed diagnostic-run peaks, not the
  production cgroup acceptance measurement;
- original harness result:
  `/tmp/dkg-devnet-sync-1g-5node-20260714T200912Z/result.json`;
- post-fix backend/restart receipt:
  `/tmp/dkg-devnet-sync-1g-5node-20260714T200912Z/post-fix-verification.json`;
- runner exit code `0`; teardown left every dedicated API, libp2p, Hardhat, and
  Oxigraph port free and restored `localhost_contracts.json` byte-for-byte.

The original harness captured node 5's backend label before its live correction,
so `result.json` still says `oxigraph (default)` for that node; the final status
receipt reports `oxigraph-server`. Its `criticalErrorMatches: 0` field also did
not search the exact `Cannot create a string longer` phrase. The embedded
pre-correction errors remain in `node5/daemon.log`; zero is not presented as a
clean-run claim. Docker was unavailable, so live 1 GiB coverage remains
Oxigraph-only. The database-independent adapter suite passed 111 tests across
Blazegraph, generic SPARQL HTTP, cancellation, graph bounds, and scheduling;
the focused agent sync suite passed 63 tests.

## 30-minute 10.3M-quad reproduction

Run on the same 8 GiB-equivalent cgroup/host shape as testnet-canary. Use four
nodes and Oxigraph server, not the in-process adapter. Preserve the populated
homes between baseline and candidate runs.

1. Build the runtime and start four nodes with durable sync, sync-on-connect,
   and reconciliation enabled. Leave `DKG_STORE_MAX_CONCURRENT` unset to test
   the new default. Set `DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS=30000`.
2. Seed and replicate until every node reports approximately 10.3 million
   quads. The existing volume driver is:

   ```bash
   pnpm --filter @origintrail-official/dkg benchmark:swm-triple-volume -- \
     --nodes 4 \
     --triples-per-write 1000 \
     --write-concurrency 4 \
     --target-gib-per-node 1 \
     --output bench/results/oxigraph-cold-start-seed.json
   ```

   Adjust the target after the first count; the acceptance input is the actual
   store count, not the serialized-byte estimate. Save a direct per-node
   `COUNT(*)` before restart.
3. Queue pending finalizations, keep one publish loop active, and establish
   sync-capable peers. Stop all four daemons without deleting their homes, then
   start all four in one orchestration action.
4. For at least 30 minutes capture every 10 seconds:

   - the telemetry above, ACK latency, publish outcomes, and source/query hash;
   - daemon heap/RSS and Oxigraph cgroup `memory.current`, `memory.events`, and
     `memory.pressure`;
   - Oxigraph active-query/request count and client cancellation timestamps;
   - status health latency and scheduler queue depths.

5. Fail the run if a retry with the same scan key starts before the prior query
   hash leaves Oxigraph's active set. Also fail on any acceptance-criteria OOM,
   publish starvation, oversized string, or queue timeout.

### Metrics record

| Metric | Incident/baseline | Candidate 30-minute run |
| --- | ---: | ---: |
| Oxigraph cgroup OOM kills | 8 / six hours | not run yet |
| JS heap or oversized-string errors | 31 | not run yet |
| slow SPARQL queries | 884 | not run yet |
| publish failures | 96 | not run yet |
| timeout entries | 1,252 | not run yet |
| peak Oxigraph RSS | ~6.3 GiB anonymous | not run yet; must be <3 GiB |
| PSI `full avg10` steady state | increasing pressure | not run yet; must be 0 |

Attach the benchmark JSON, telemetry export, cgroup samples, and query-overlap
audit to this table before declaring the rollout accepted.

## Operator rollout and removal of emergency overrides

1. Deploy one node only. Keep the current sync-disable overrides for its first
   boot and verify schema migration 29, status health, and scheduler telemetry.
2. Remove `DKG_DURABLE_SYNC_ENABLED=0`, then `DKG_SYNC_ON_CONNECT_ENABLED=0`,
   then `DKG_SYNC_RECONCILER_ENABLED=0`, one producer at a time. Hold at least
   one full reconcile interval between changes. Keep
   `DKG_SYNC_GLOBAL_MAX_INFLIGHT=1` for the canary soak.
3. Run the 30-minute 10.3M-quad procedure. Do not proceed unless every
   acceptance criterion passes and the active-query audit proves no
   timeout/retry overlap.
4. Roll one additional node at a time, at least 15 minutes apart. Never restart
   all four as an operational rollout technique; the code is designed to
   tolerate it, but staggering remains the lower-risk deployment policy.
5. After all four nodes complete a six-hour observation window with zero OOM,
   store-starvation publish failure, and cancellation overlap, remove the
   emergency store-admission variables. The code default is now the safe
   four-slot budget with ACK/health reserves. Raise it only from measured
   headroom. Remove `DKG_SYNC_GLOBAL_MAX_INFLIGHT=1` last and increase one step
   per soak; do not jump directly to the former concurrency.
