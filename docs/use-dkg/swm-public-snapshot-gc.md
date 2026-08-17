# SWM public snapshot garbage collection

The file-backed shared-memory (SWM) public snapshot store supports an opt-in,
pressure-based garbage collector. GC v1 is an incident guardrail: it bounds disk
growth using file age and free-space watermarks. It does not inspect RDF
references or replication proofs.

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

GC is disabled unless `gc.enabled` is `true`. When enabled, the store:

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
least as high as the trigger. Defaults are 5 GiB, 15 GiB, and 25 GiB
respectively, but operators must size them for the filesystem hosting the
configured snapshot directory.

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
