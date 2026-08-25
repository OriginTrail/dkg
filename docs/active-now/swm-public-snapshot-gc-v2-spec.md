# SWM public snapshot GC v2: proof-driven retention

Status: proposed follow-up to GC v1
Tracking: GitHub issue #2269

## Summary

GC v2 must keep the free-space watermarks and admission control introduced by
v1, while replacing age-only eligibility with explicit proof that deleting a
local blob cannot remove the network's only durable copy. It must distinguish
locally originated durable state from verified peer cache, protect active
operations across asynchronous reads and writes, and rehydrate evicted cache on
demand.

Free space determines **when and how much** to collect. Provenance, lifecycle
state, leases, and replication evidence determine **what may be deleted**.

## Facts validated while implementing v1

These findings come from the `testnet-canary` implementation at commit
`644b697` and constrain the v2 design:

1. The file store is content addressed. A digest maps to
   `<root>/<aa>/<bb>/<digest>.nq`; legacy `.json` files remain readable. Atomic
   writes create a sibling `.tmp` file before rename.
2. Local publication and verified network synchronization both call the same
   `putSnapshot({ digest, quads })` API. The store therefore cannot currently
   tell an origin copy from a refetchable peer copy.
3. New metadata normally does not contain `dkg:publicSnapshotRef`. A snapshot is
   file-store-backed when `dkg:publicQuadsDigest` exists and
   `dkg:publicSnapshotGraph` does not; the digest is the implicit reference.
   Legacy explicit references still take precedence.
4. An RDF reference is not itself a retention proof. The snapshot sync walk
   treats a missing/invalid local blob as a cache miss, fetches pages from the
   peer, verifies digest and count, and stores the verified result. However,
   direct workspace resolution and graph-scoped recovery paths can currently
   return/throw "snapshot missing" without initiating that fetch.
5. Page indexes live in SQLite's `snapshot_page_indexes` table. Its adapter only
   exposes `get` and `upsert`; deleting a blob currently leaves a small derived
   row behind.
6. Paged reads hold an open file descriptor, but the store previously had no
   logical lease visible to maintenance work. V1 adds process-local active-file
   protection, which does not protect a second process sharing the directory.
7. Directory scanning is acceptable as an emergency mechanism but does not
   scale as the durable source of last-access, provenance, pin, or proof data.
   The incident directories contained tens of thousands of blobs.
8. Repeated writes of an existing content-addressed digest previously created a
   second full temporary payload. V1 short-circuits an existing immutable file;
   v2 must preserve that invariant and verify it during inventory repair.

## Goals

- Never evict an unreplicated locally originated snapshot.
- Prefer eviction of verified peer cache and definite orphans.
- Maintain configurable trigger, target, and hard-reserve watermarks.
- Support safe collection during concurrent reads, writes, sync, publication,
  finalization, and process restart.
- Rehydrate evicted referenced cache before a caller needs the quads.
- Bound the blob catalog and page-index metadata as well as file bytes.
- Provide explainable dry-run plans, metrics, and audit logs.
- Upgrade an existing v1 directory without requiring downtime.

## Non-goals

- GC does not delete RDF operation metadata, workspace heads, finalized KA
  graphs, or graph-backed `dkg:publicSnapshotGraph` content.
- GC does not weaken digest/count verification or ACK/finality rules.
- GC does not use free space alone as evidence that a file is disposable.

## Persistent blob catalog

Add a transactional `snapshot_blobs` catalog, preferably beside the existing
SQLite page-index table. One row represents one canonical digest:

| Field | Purpose |
| --- | --- |
| `snapshot_digest` | Canonical `sha256:<hex>` primary key |
| `format_version` | On-disk serialization version |
| `byte_length` | Reclaim planning without filesystem-wide `stat` |
| `created_at_ms` | First successful local materialization |
| `last_access_at_ms` | Coalesced LRU signal; updates must be rate limited |
| `source` | `local_publish`, `network_sync`, or `legacy_unknown` |
| `lifecycle` | `writing`, `ready`, `tombstoned`, or `missing` |
| `verified_at_ms` | Last successful digest/count verification |
| `context_graph_id` | Recovery and audit scope when known |
| `share_operation_id` | Originating operation when known |
| `source_peer_id` | Last verified network source when known |
| `finalized_at_ms` | Local operation reached terminal finality |
| `replica_proof_count` | Distinct valid storage proofs currently recorded |
| `replica_proof_expires_at_ms` | Earliest expiry of proofs used for eviction |
| `pin_reason` | Nullable operator/system pin |
| `generation` | Monotonic value for lease/tombstone race detection |

The catalog update and file transition must be crash consistent. A successful
`putSnapshot` changes `writing` to `ready` only after rename and verification.
Startup reconciliation repairs `writing`, `tombstoned`, missing, and unknown
filesystem/catalog combinations.

Change `putSnapshot` to accept optional provenance:

```ts
type SnapshotProvenance =
  | {
      source: 'local_publish';
      contextGraphId: string;
      shareOperationId: string;
    }
  | {
      source: 'network_sync';
      contextGraphId: string;
      sourcePeerId: string;
    };
```

Every production call site must supply provenance. The field can remain
optional temporarily for third-party stores, but omitted provenance is
`legacy_unknown` and fail-closed for deletion.

## Deletion proofs

A blob is eligible only when it has no active lease or pin and at least one of
these proofs is true:

1. **Definite orphan:** no explicit `publicSnapshotRef`, no implicit
   `publicQuadsDigest` reference without a `publicSnapshotGraph`, no pending
   job/finalization reference, and it is older than the orphan grace period.
2. **Verified peer cache:** `source=network_sync`, digest/count verification
   succeeded, the cache grace period elapsed, and a current durable source or
   deterministic reconstruction path is proven available.
3. **Replicated local origin:** local publication is terminal/finalized and the
   configured minimum number of distinct valid retention-proof holders confirms
   recoverability. Proofs must belong to the relevant network/chain epoch, must
   not count duplicate operational identities, and must remain valid beyond the
   configured recovery window.

`legacy_unknown`, locally pending, failed publication, insufficiently
replicated, corrupt, or proof-expired rows are not eligible. Operators may
explicitly pin any digest.

The exact replica threshold is network policy, not a hard-coded store constant.
The catalog records evidence; a proof provider in the publisher/agent layer
evaluates current policy.

A historical storage ACK is not automatically a permanent retention proof: a
receiver may later evict its own cache. It qualifies only if the protocol binds
that ACK to a still-valid retention commitment, a current inventory challenge,
or a deterministic durable source from which the exact digest can be rebuilt.
Without one of those witnesses, the local-origin blob remains pinned.

## Complete mark sources

The mark phase must combine:

- Legacy explicit `dkg:publicSnapshotRef` rows.
- Implicit refs: `dkg:publicQuadsDigest` rows with no
  `dkg:publicSnapshotGraph`.
- Current workspace heads and graph-scoped heads.
- Queued/running publish, promotion, retry, recovery, and finalization jobs.
- In-progress snapshot sync and materialization.
- Active in-process leases and cross-process lease/lock records.
- Operator/system pins.
- Local-origin rows lacking sufficient terminal replication proof.

References identify consumers and recovery descriptors. They do not override a
valid peer-cache or replicated-origin eviction proof; otherwise referenced cache
could never be bounded.

## Leases and concurrency

Reads, paged reads, writes, verification, and network serving acquire a digest
lease before accessing the blob. GC atomically transitions an eligible catalog
row from `ready` to `tombstoned` only when no unexpired lease exists and the row
generation still matches its plan.

For the normal single-daemon deployment, in-memory reference counts are the
fast path. A small SQLite lease/owner record or an exclusive node-directory
lock must prevent a maintenance CLI or second process from sweeping files used
by the daemon. Expired leases require an owner/process-generation check before
reclamation.

Deletion is idempotent:

1. Transactionally mark the row `tombstoned` with a new generation.
2. Unlink the immutable blob.
3. Delete its `snapshot_page_indexes` row.
4. Commit the catalog row as `missing` or remove it after the audit-retention
   window.

Startup completes interrupted tombstones. A concurrent put either cancels the
tombstone with a newer generation or writes and publishes a new `ready`
generation after deletion; it must never be mistaken for the old plan.

## Cache-miss rehydration

The file store cannot fetch peers by itself. Add an agent-layer snapshot
resolver that composes local storage with the existing snapshot page transport:

1. Local `getSnapshot` reports a typed miss.
2. The resolver single-flights concurrent misses for the same digest.
3. It selects an authoritative recovery descriptor and eligible peer.
4. It fetches the complete snapshot, never persisting an unverified prefix.
5. It verifies digest and triple count.
6. It writes the blob with `source=network_sync` provenance and resumes callers.

Wire this resolver into direct workspace resolution, graph-scoped recovery,
sync, ACK preparation, and snapshot-serving paths. An ACK must not be emitted
until rehydration and integrity verification succeed. If no peer can serve the
blob, return a typed retryable-unavailable result rather than corrupting
metadata or pretending the snapshot is complete.

## Collection algorithm

The periodic and pre-write entry points share one single-flight planner:

```text
clean abandoned temp/writing records
read filesystem available bytes
if above trigger and no pending write threatens reserve: stop

desired = max(targetFreeBytes, hardReserveBytes + pendingWriteBytes)
mark leases, pins, pending local work, and unproven local origins
load proven candidates from the catalog
order: definite orphan, verified peer cache LRU, replicated local origin LRU
tombstone and delete until desired is reached or candidates are exhausted

if pending write still violates hard reserve:
  reject it with SNAPSHOT_STORAGE_CAPACITY
```

Do not hold a database transaction during filesystem or network I/O. Plan in a
short read transaction and use generation-checked state transitions per blob.
Cap deletions or wall-clock time per periodic pass so GC cannot starve ACK and
sync work; pre-write emergency collection may continue until the write is safe
or proven impossible.

## Configuration

V2 retains the v1 fields and adds policy controls:

```json
{
  "gc": {
    "enabled": true,
    "mode": "proof-driven",
    "intervalMs": 300000,
    "triggerFreeBytes": 16106127360,
    "targetFreeBytes": 26843545600,
    "hardReserveBytes": 5368709120,
    "orphanGraceMs": 86400000,
    "peerCacheGraceMs": 86400000,
    "localOriginGraceMs": 604800000,
    "minimumReplicaProofs": 3,
    "leaseTimeoutMs": 900000,
    "maxPassMs": 30000,
    "unknownLegacyPolicy": "pin"
  }
}
```

Defaults must be derived from network policy and filesystem size or remain
explicitly opt-in. `hardReserveBytes` is the final admission boundary, not the
normal collection trigger.

## Observability and tooling

Expose at least:

- Available bytes, store bytes, catalog rows by source/lifecycle.
- GC runs by reason and outcome.
- Planned/deleted/skipped/failed files and bytes by proof class.
- Active leases and pins.
- Capacity rejections.
- Cache misses, refetch attempts, refetch latency, and failures.
- Inventory/catalog drift and stale page-index rows.

Add commands equivalent to:

```text
dkg snapshots inventory
dkg snapshots gc --dry-run
dkg snapshots gc
dkg snapshots pin <digest>
dkg snapshots unpin <digest>
```

Dry-run output must state the proof class and skip reason per sampled digest and
aggregate the complete byte/count plan.

## Migration and rollout

1. Ship catalog creation and provenance recording with collection in report-only
   mode.
2. Inventory existing files. Classify from durable metadata and job/ACK state;
   leave ambiguous rows `legacy_unknown` and pinned.
3. Compare filesystem, implicit/explicit references, page indexes, and catalog
   in canary telemetry.
4. Enable deletion for definite orphans and verified peer cache on one testnet
   canary.
5. Exercise cache-miss rehydration and restart-during-tombstone tests.
6. Enable replicated local-origin eviction only after ACK proof evaluation has
   passed shadow-mode audits.
7. Roll out by chain, retaining v1 hard-reserve admission as the fail-safe.

## Acceptance criteria

- A sole-copy local snapshot is never selected or deleted.
- A finalized local snapshot with sufficient current proofs is reclaimable.
- A verified peer-cache miss rehydrates and produces byte-equivalent quads.
- Implicit digest references and legacy explicit references are both found.
- Active read/write/sync/serve leases defeat a concurrent GC plan.
- Restart at every tombstone transition converges without a corrupt ready row.
- Deletion also removes the derived page-index row.
- A malformed/corrupt blob is never treated as verified cache.
- Failed unlink, SQLite busy, statfs failure, unavailable peers, and `ENOSPC`
  produce bounded retries and explicit health/metrics.
- Under sustained load the configured hard reserve is maintained, or new
  snapshot writes are rejected before the triple store loses its own capacity.
- V1 directories migrate without deleting `legacy_unknown` blobs by default.
