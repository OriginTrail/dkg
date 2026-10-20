# Public Context Graph snapshot recovery

An explicit recovery job can obtain chain statements from operator-configured core peers instead of repeating asset RPC reads on every receiver. The default for this **new job API** is `core-cache`; existing background reconciliation keeps its existing policy.

The core reads a complete ordered inventory and each asset's root, assertion version and graph binding at one confirmation-depth block. It resolves storage contracts through the Hub at that same block, checks the actual RPC chain id and rechecks the block hash after collection. Where canonical Multicall3 bytecode is present, bounded aggregates amortize RPC calls; development chains without it use bounded concurrent calls at the same anchor. Cache hits do no chain work. Cold readers coalesce; the cache bounds concurrent builds, retained graphs, inventory size and response size.

## Trust and integrity

`core-cache` trusts chain statements from the explicitly configured libp2p peer identities. Authenticated channel identity binds the supplier; this is not a chain-state proof or an independent RPC audit. A self-advertised core role grants no trust. There is no implicit fallback to arbitrary peers or to RPC.

`rpc-only` constructs the same coherent snapshot using this receiver's configured RPC. Peers supply content, which is checked against that independently obtained inventory. Unsupported or unavailable snapshot providers fail explicitly.

Both modes use the existing exact-batch transport, content-root verification, graph/asset identity checks, atomic replacement, lifecycle fencing and stale-version protection. Private graph authorization is unchanged. The new snapshot server answers only for locally subscribed graphs proven public at its snapshot anchor; private, missing and unavailable cases share a refusal.

Wire snapshots are versioned, size-bounded and scoped to the chain, Hub deployment, graph name commitment and registered graph id. Integer strings are canonical; duplicate assets and digest mismatches fail. New evidence must be observed within 120 seconds; a recovery job pins its accepted snapshot while transferring. A final comparison requires a newly observed snapshot after transfer, not reuse of the initial cached answer. `completeAsOfSnapshot` and `current` are separate facts: a changed inventory does not become a full-current PASS.

Imported asset metadata records the mode, supplier, snapshot digest, observation time and chain anchor. A durable graph trust marker is written before core-trusted content. Query APIs require `chainEvidenceMode: "core-cache"` with an explicit context graph to read such a graph. Parent scopes are conservatively guarded when any descendant graph is marked, including child partitions selected through `subGraphName`. Normal authorization still applies. Queries recheck evidence policy before releasing results so concurrent imports cannot race the guard.

A local query without a context graph is answered over the dataset without the marked graphs: the store evaluates it over its default graph and every named graph outside the marked context graphs and their descendants, whatever the query's patterns (subqueries, `OPTIONAL`, `EXISTS` and `DESCRIBE` included). A marked graph no longer makes such a query fail, and the query never returns core-cache evidence; naming a marked graph returns nothing from it. Only more than 256 marked graphs, or a marker that names no context graph, still refuse unscoped queries. While any graph is marked, an unscoped query cannot set its own dataset: `FROM` and `FROM NAMED` are refused with `CORE_CACHE_QUERY_TRUST_REQUIRED`. To read a marked graph, scope the query to its context graph and accept core-cache evidence. Acceptance stays per graph: `chainEvidenceMode: "core-cache"` without a context graph is refused. The node's own metrics counts and the node UI's cross-partition views use such queries, so they count and show only content outside marked graphs. Unscoped queries run only on stores with all-writer consistency (embedded Oxigraph and its worker), which restrict the dataset natively; on Blazegraph and oxigraph-server stores they are refused as before, whether or not a graph is marked.

A marked graph stays marked across partial imports, process restarts and subsequent RPC replays. To retain an independent-only query policy, use a separate profile/store; automatic evidence promotion is not implemented. Querying the raw database as its operator is outside the query API policy boundary.

## Use

Deploy this capability on the selected cores and receiver. Capable nodes negotiate exact-batch streaming by default; an explicit `DKG_EXACT_BATCH_STREAM_ENABLED=0` disables it. The source core must subscribe to the graph. A fresh receiver installs an on-demand subscription only after accepting a valid public snapshot; this does not schedule the separate legacy catch-up endpoint. This change does not alter services remotely.

The administrator-only daemon endpoint starts one owned job per node:

```http
POST /api/context-graph/snapshot-sync
Content-Type: application/json

{"contextGraphId":"example-graph","onChainId":"42","trustedCorePeerIds":["CONFIGURED_CORE_PEER_ID"],"mode":"core-cache"}
```

Poll `GET /api/context-graph/snapshot-sync` for `running`, `complete` or `failed` and the final evidence. A duplicate running job returns 409. Change `mode` to `rpc-only` for independent evidence. There is no automatic mode downgrade or rerun after failure.

A job runs inside a one-hour limit. Each exact batch takes this node's ordinary sync admission, so on a node with a single sync slot and no queue a batch can meet a slot that another admitted sync holds. Such a refusal says nothing about the source core's data, and neither does a core answering that it is busy, so the job waits instead of failing:

- When local sync capacity refused the batch, the job holds back for a jittered delay (2.5 s, doubling after repeated refusals up to 30 s), then reads the admission every 2.5 s and retries the same batch once it would be taken. Trying another core would meet the same local refusal.
- When a core answered busy, or a stream it had already served for this graph broke (at most twice in a row), that core keeps its turn and is asked again after a 15 s hold-off, the setback policy the VM reconcile pass uses. Other configured cores may be asked meanwhile. A core still answering busy after 30 minutes counts as having answered.

Curator metadata refreshes have a reserved control-plane slot that no transfer can take. A refresh that finds the general slot free takes that slot first, and the job waits it out like any other admitted sync. A refresh that finds the general slot busy, for example held by the job, runs in the reserved slot: the job neither blocks it nor waits for it.

A job fails when every configured core has answered without the assets, after the bounded singleton attempt, or when it cannot wait any longer: a wait must end two minutes before the limit, which leaves time for the final coverage read. The error keeps the committed count, for example `Snapshot recovery incomplete: 10/11 committed` or `Snapshot recovery incomplete: 0/12 committed (local sync capacity stayed in use)`.

Before fetching a batch, and again after each wait, the job skips assets this node already holds: a confirmed copy at the pinned version and root whose stored content still verifies against that root, or a newer confirmed version whose own content verifies against the root it was confirmed at. That is the rule a catch-up uses to count content as held, and an older snapshot never replaces a newer stored version. A rerun after a failure or a restart therefore continues where the store stands, and `alreadyPresent` in the result counts the assets it did not transfer. Skipping never rewrites a stored copy; an `rpc-only` job still imports copies at the pinned version that carry core-cache labels, which relabels them with its own evidence. The job record itself is kept in memory, so after a restart `GET` reports `idle` until a new job is started.

In-process callers use `agent.syncPublicGraphSnapshot(options)` and may supply an AbortSignal. Queries accept the mode separately:

```ts
await agent.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 20', {
  contextGraphId: 'example-graph',
  chainEvidenceMode: 'core-cache',
});
```

## Validation and remaining performance work

Local validation uses real DKG nodes, libp2p streaming, an isolated deployed Hardhat chain and separate Oxigraph stores. It checks core-cache transfers with receiver asset-RPC methods forbidden, independent RPC-only recovery, public/private behavior, evidence labeling and query refusal without acceptance. Contract tests reject stale/mis-scoped/malformed evidence; existing durable-materialization and private-query regression tests protect the reused boundaries.

This implementation retains ten-asset streaming batches and sequential supplier fallback (up to four configured peers). A rerun resumes per asset from the local store, as described above. It does not yet implement 100 MB chunks, concurrent suppliers, resumable transfer sessions, background sampling audits or a large-graph five-minute performance guarantee. The storage benchmark is a separate lower-bound measurement. Cold snapshot generation still costs RPC work at the core; only a warm cache avoids that work for additional consumers.

The bounded SELECT and entity-discovery endpoints accept the same `chainEvidenceMode`
and echo it in successful responses. Omitting it retains the independent policy;
clients must not silently treat an unacknowledged trust selection as accepted.

Snapshot observations allow up to five seconds of clock skew. A final coverage check sends an explicit refresh request: the supplier orders a new read after that request using its own cache generation, rather than comparing clocks across peers. Jobs and source builders drain with node shutdown, and subscription or binding changes invalidate the entire job.

The normal stream profile is preferred. Missing assets outside that profile, including public assertions carrying private-root commitments, use bounded singleton recovery through the same verification, snapshot authentication and atomic materialization path. Private content is not requested.

Remote query and UAL lookup protocols currently have no explicit core-cache
acceptance field. They refuse reads from a marked graph (and conservatively
refuse unscoped UAL lookups when any graph is marked) before execution and before
releasing results. Local scoped queries may explicitly accept core-cache evidence.
Imported `publishedAt` values are locally assigned RDF `xsd:dateTime` values;
same-version replay preserves the original local receive time. The pinned snapshot block is the local materialization ordering stamp. Every finalization write also checks the stored assertion version under the same asset lock, so a delayed older receipt cannot replace a newer snapshot import, including imports carrying a legacy zero ordering stamp.
