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
3. Excludes active readers, serving pages, and file-plus-metadata writes. Sync
   recovery holds each touched file's lease through its final metadata commit.
   Leases are shared between store instances using the same directory in the
   process. A busy digest does not prevent collection of unrelated digests.
4. Deletes the unreferenced `.nq`/legacy `.json` file, its cached validation/page
   index, and its persisted page-index row where the adapter supports deletion.
5. Removes the retirement record last. An interrupted deletion can finish on the
   next pass after restart. Reusing a digest with `putSnapshot` cancels retirement;
   another confirmed publication starts a new grace period.

Failures to record retirement are logged and do not turn a successful publish
into an error. A missing checker, unreadable record, failed reference query, or
failed unlink retains/retries the candidate. Pressure GC does not bypass the
grace or reference check for a marked candidate while this feature is enabled.
After the directory scan, collection considers at most 32 records and a
five-second scheduling budget per pass (an in-flight reference query may run to
its two-second deadline). It
rotates past busy, retained and failed candidates to avoid starving later files.

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
directory concurrently used by another process. A custom snapshot store without
the optional lifecycle methods keeps its own retention behavior.

Existing unmarked files, legacy entity/root-scoped publishes, and candidates
whose retirement record could not be saved remain under the original pressure
policy. This feature does not immediately reclaim the pre-upgrade backlog.
Start with one node and new graph-scoped publishes; verify VM reads/durable sync,
reference retention, restart recovery and GC logs before enabling it elsewhere.
Disabling `finalizedCleanupEnabled` returns to the existing pressure policy;
`gc.enabled=false` disables both collectors.
