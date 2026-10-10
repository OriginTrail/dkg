# Public Context Graph snapshot recovery

An explicit recovery job can obtain chain statements from operator-configured core peers instead of repeating asset RPC reads on every receiver. The default for this **new job API** is `core-cache`; existing background reconciliation keeps its existing policy.

The core reads a complete ordered inventory and each asset's root, assertion version and graph binding at one confirmation-depth block. It resolves storage contracts through the Hub at that same block, checks the actual RPC chain id and rechecks the block hash after collection. Where canonical Multicall3 bytecode is present, bounded aggregates amortize RPC calls; development chains without it use bounded concurrent calls at the same anchor. Cache hits do no chain work. Cold readers coalesce; the cache bounds concurrent builds, retained graphs, inventory size and response size.

## Trust and integrity

`core-cache` trusts chain statements from the explicitly configured libp2p peer identities. Authenticated channel identity binds the supplier; this is not a chain-state proof or an independent RPC audit. A self-advertised core role grants no trust. There is no implicit fallback to arbitrary peers or to RPC.

`rpc-only` constructs the same coherent snapshot using this receiver's configured RPC. Peers supply content, which is checked against that independently obtained inventory. Unsupported or unavailable snapshot providers fail explicitly.

Both modes use the existing exact-batch transport, content-root verification, graph/asset identity checks, atomic replacement, lifecycle fencing and stale-version protection. Private graph authorization is unchanged. The new snapshot server answers only for locally subscribed graphs proven public at its snapshot anchor; private, missing and unavailable cases share a refusal.

Wire snapshots are versioned, size-bounded and scoped to the chain, Hub deployment, graph name commitment and registered graph id. Integer strings are canonical; duplicate assets and digest mismatches fail. New evidence must be observed within 120 seconds; a recovery job pins its accepted snapshot while transferring. A final comparison requires a newly observed snapshot after transfer, not reuse of the initial cached answer. `completeAsOfSnapshot` and `current` are separate facts: a changed inventory does not become a full-current PASS.

Imported asset metadata records the mode, supplier, snapshot digest, observation time and chain anchor. A durable graph trust marker is written before core-trusted content. Query APIs require `chainEvidenceMode: "core-cache"` with an explicit context graph to read such a graph. Normal authorization still applies. Queries recheck evidence policy before releasing results so concurrent imports cannot race the guard. Unscoped queries fail conservatively if the dataset contains any marked graph.

A marked graph stays marked across partial imports, process restarts and subsequent RPC replays. To retain an independent-only query policy, use a separate profile/store; automatic evidence promotion is not implemented. Querying the raw database as its operator is outside the query API policy boundary.

## Use

Deploy this capability on the selected cores and receiver. Core streaming must already be enabled (`DKG_EXACT_BATCH_STREAM_ENABLED=1`) and the source core must subscribe to the graph. A fresh receiver installs an on-demand subscription only after accepting a valid public snapshot; this does not schedule the separate legacy catch-up endpoint. This change does not enable flags or alter services remotely.

The administrator-only daemon endpoint starts one owned job per node:

```http
POST /api/context-graph/snapshot-sync
Content-Type: application/json

{"contextGraphId":"example-graph","onChainId":"42","trustedCorePeerIds":["CONFIGURED_CORE_PEER_ID"],"mode":"core-cache"}
```

Poll `GET /api/context-graph/snapshot-sync` for `running`, `complete` or `failed` and the final evidence. A duplicate running job returns 409. Change `mode` to `rpc-only` for independent evidence. There is no automatic mode downgrade or rerun after failure.

In-process callers use `agent.syncPublicGraphSnapshot(options)` and may supply an AbortSignal. Queries accept the mode separately:

```ts
await agent.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 20', {
  contextGraphId: 'example-graph',
  chainEvidenceMode: 'core-cache',
});
```

## Validation and remaining performance work

Local validation uses real DKG nodes, libp2p streaming, an isolated deployed Hardhat chain and separate Oxigraph stores. It checks core-cache transfers with receiver asset-RPC methods forbidden, independent RPC-only recovery, public/private behavior, evidence labeling and query refusal without acceptance. Contract tests reject stale/mis-scoped/malformed evidence; existing durable-materialization and private-query regression tests protect the reused boundaries.

This implementation retains ten-asset streaming batches and sequential supplier fallback (up to four configured peers). It does not yet implement 100 MB chunks, concurrent suppliers, resumable graph sessions, background sampling audits or a large-graph five-minute performance guarantee. The storage benchmark is a separate lower-bound measurement. Cold snapshot generation still costs RPC work at the core; only a warm cache avoids that work for additional consumers.

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
same-version replay preserves the original local receive time.
