# SWM public snapshot garbage collection

The file-backed shared-memory (SWM) public snapshot store enables a
pressure-based garbage collector by default. GC v1 is an incident guardrail: it
bounds disk growth using file age and free-space watermarks. It does not inspect
RDF references or replication proofs. Set `gc.enabled` to `false` for an
explicit per-node opt-out.

An additional **opt-in finalized-publish collector** can remove unreferenced
graph-scoped KA snapshot files after publication, even when disk space is ample.
It is separate from v1's emergency age-based eviction; see below.

## Recommended 75 GiB node configuration

```json
{
  "sharedMemoryPublicSnapshotStorage": {
    "enabled": true,
    "directory": "/var/lib/dkg/swm-public-snapshots",
    "gc": {
      "enabled": true,
      "intervalMs": 300000,
      "triggerFreeBytes": 16106127360,
      "targetFreeBytes": 26843545600,
      "hardReserveBytes": 5368709120,
      "minAgeMs": 604800000,
      "staleTempAgeMs": 3600000
    }
  }
}
```

GC is enabled unless `gc.enabled` is `false`. When enabled, the store:

1. Checks the snapshot filesystem every `intervalMs` and before a write that
   could cross a watermark.
2. Removes abandoned atomic-write `.tmp` files older than `staleTempAgeMs`.
3. Starts snapshot eviction below `triggerFreeBytes` and deletes eligible
   `.nq` or legacy `.json` files oldest first.
4. Stops when `targetFreeBytes` is available or no eligible files remain.
5. Never age-evicts a file newer than `minAgeMs`, or a file in use by this
   process.
6. Rejects a new snapshot with error code `SNAPSHOT_STORAGE_CAPACITY` when the
   write would consume `hardReserveBytes` and GC cannot recover enough space.

The hard reserve protects the triple store and other node state from an
`ENOSPC` cascade. It should be lower than the trigger; the target should be at
least as high as the trigger. On filesystems of 75 GiB or more, the automatic
defaults are a 5 GiB reserve, 15 GiB trigger, and 25 GiB target. On smaller
filesystems, all three automatic watermarks scale together to 1/15, 1/5, and
1/3 of total filesystem capacity. Supplying any watermark opts into fixed byte
values, with omitted watermarks retaining their unscaled defaults.

## V1 safety boundary

V1 treats sufficiently old snapshots as recoverable cache. Metadata may still
refer to an evicted digest. Normal SWM synchronization detects a missing or
invalid local blob, fetches it from a peer, verifies its digest and count, and
writes it back. Some direct local resolution paths do not yet refetch on demand,
so nodes that may hold the only copy of locally produced data should use a
longer minimum age or leave v1 disabled until replication is established.

GC v2 will replace age as the deletion proof with recorded provenance,
replication/finality evidence, leases, and cache-miss rehydration. See
[`../active-now/swm-public-snapshot-gc-v2-spec.md`](../active-now/swm-public-snapshot-gc-v2-spec.md).

## Automatic cleanup after confirmed publication

Merge this into the existing node configuration to enable the new collector:

```json
{
  "sharedMemoryPublicSnapshotStorage": {
    "gc": {
      "enabled": true,
      "finalizedCleanupEnabled": true,
      "finalizedRetentionMs": 86400000
    }
  }
}
```

`finalizedCleanupEnabled` defaults to **false**. The retention interval defaults
to **24 hours**, measured from the latest retirement request for that digest,
not from the file's modification time. Configuration takes effect at startup.

The existing confirmed/durable graph-scoped KA cleanup path records the digest
in a small `.retired` sidecar before removing its SWM graph and current operation
metadata. The background collector, on its existing five-minute interval:

1. Waits for the retirement grace period.
2. Checks all RDF graphs for explicit snapshot references or implicit digest
   references without a graph-backed snapshot. Another operation/context graph
   referencing the same bytes prevents deletion.
3. Excludes active readers, serving pages, and file-plus-metadata writes. With
   finalized cleanup enabled, sync public and private recovery hold each
   touched file's lease through the final metadata commit. Reused refs acquire
   an existing-file lease without decoding the payload again; if collection
   already removed it, normal recovery fetches it again before committing
   metadata. Leases are shared by physical directory identity, including
   symlink/junction and case aliases. A busy digest does not prevent collection
   of unrelated digests. With cleanup disabled these operation-long leases are
   not taken, so pressure GC treats a file only as in use while an individual
   read or write is running, as before this feature.
4. Deletes the unreferenced `.nq`/legacy `.json` file, its cached validation/page
   index, and its persisted page-index row where the adapter supports deletion.
5. Removes the retirement record last. An interrupted deletion can finish on the
   next pass after restart. Reusing a digest with `putSnapshot` cancels retirement;
   another confirmed publication starts a new grace period.

A core that signed a StorageACK for the asset also holds that copy's operation
row (id prefix `storage-ack-`), which carries the same snapshot digest and would
otherwise keep the file referenced until the SWM TTL. The same cleanup boundary
removes those rows, only for the same asset at or below the version being
cleaned up. A later version's copy, another asset's copy and any other kind of
operation keep counting as references. A failed lookup or delete leaves the rows
(and so the file) in place.

Failures to record retirement are logged and do not turn a successful publish
into an error. A missing checker, unreadable record, failed reference query, or
failed unlink retains/retries the candidate. Pressure GC never age-evicts a
marked candidate. While free space is above the hard reserve, a candidate waits
out its grace period. When free space (less the size of a pending write) is
below `hardReserveBytes`, marked candidates become eligible before their grace
period ends, until the reclaim target is met. They still go through the same
reference check, so an unavailable checker, a malformed record or a failed query
retains the file, and a referenced file is kept.

Each pass examines at least 32 records and a pass keeps going past that while
candidates keep clearing, within a five-second scheduling budget (an in-flight
reference query may run to its two-second deadline). It stops at the first
retained candidate after the first 32, rotating past busy, retained and failed
candidates to avoid starving later files. Records are visited in digest order
(code-unit comparison, independent of the process locale), starting after the
last one examined. That position is saved in `finalized-collection-cursor.json`
in the snapshot directory, so a restart resumes instead of re-scanning from the
start of a large backlog; a missing or unreadable file restarts from the
beginning.

The retirement lookup and the reference check bound their wait on the client
side. They do not pass an abort signal to the triple store, whose own deadline
governs the query.

`[SWM-SNAPSHOT-GC]` logs distinguish `finalized`, `referenced`, and `failed` counts.
The collector visits only the expected two hexadecimal directory levels. It
does not enter unrelated directories such as a mounted volume's `lost+found`.

### Scope and rollout

This is a narrow lifecycle addition, **not the complete proposed GC v2**. It
does not inventory or independently prove finality for historical files, scan
external job queues, obtain replication commitments, or add cache-miss fetching.
Its retirement authority is the existing confirmed/durable SWM cleanup boundary;
remaining RDF operation references prevent collection. It does not change the
RDF cleanup policy or make arbitrary operations eligible for retirement.

Use one daemon per snapshot directory. Cross-process maintenance/CLI access is
not protected by the process-local lease mechanism. Do not enable it on a
directory concurrently used by another process. Do not retarget a directory
symlink/junction or replace its underlying directory while the process runs.
A custom snapshot store without the optional `lifecycle` capability keeps its
own retention behavior. That capability is complete (leasing, existing-file
leasing, enabled state and retirement), rather than independent optional methods.

`WorkspaceSnapshotScope` owns a complete operation's I/O and `retainExisting`
leases. Publication and recovery use `snapshotOperation`, whose implementation
receives a scope rather than a raw store; leases close after the final metadata
commit, on either success or failure. Missing reused bytes follow the existing
fetch path. The scope must account for every I/O method, including optional ones.

The file store accepts `isSnapshotReferenced` once in its constructor options.
The agent's optional `publicSnapshotStoreFactory` receives the constructed RDF
store. The daemon uses this factory to share one indexed snapshot store across
agent and publisher, without a late-bound checker. CLI construction uses named
options (`store`, `pageIndexStore`, `log`). Direct SDK users creating a file store
must pass `snapshotReferenceCheck(theTripleStore)` to enable collection. Without
a checker, marked candidates are retained.

`PublishedSnapshotRetirement` owns RDF discovery and canonical literal decoding
at the durable cleanup boundary. `FinalizedSnapshotCollector` owns marker
persistence, bounded scheduling and reference checks; the file store supplies
payload and derived-index removal. Marker changes are queued per digest across
all directory aliases: a later retirement or reuse cannot be overwritten by an
older pending rename. Physical-directory lookup/enqueue preserves request order,
including cold aliases; marker I/O for different digests remains concurrent.
All cleanup, including stale temporary files, uses the same shared lifecycle gate.

Existing unmarked files, legacy entity/root-scoped publishes, and candidates
whose retirement record could not be saved remain under the original pressure
policy. This feature does not immediately reclaim the pre-upgrade backlog.
Start with one node and new graph-scoped publishes; verify VM reads/durable sync,
reference retention, restart recovery and GC logs before enabling it elsewhere.
Disabling `finalizedCleanupEnabled` returns to the existing pressure policy;
`gc.enabled=false` disables both collectors.
