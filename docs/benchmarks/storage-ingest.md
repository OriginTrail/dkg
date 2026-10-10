# Context Graph storage ingestion baseline

The storage-only measurement isolates the cost of writing an already available RDF projection. It does not measure chain reads, network transfer, content-root verification, indexing or application readiness.

For 564 partitions containing 3,751,526 distinct data quads (580,640,763 bytes of N-Quads), three fresh-store trials per mode gave:

| Mode | Write time, median | Ingest wall time, median | Wall-time range |
|---|---:|---:|---:|
| Existing `replaceGraphAndSubject`, one asset per transaction | 118.08 s | 136.78 s | 135.74–138.31 s |
| RDF POST, ten assets per request, fresh store only | 20.27 s | 42.84 s | 42.33–43.46 s |

Every trial checked each partition's statement count and the total, then stopped and restarted the database and verified the persisted total. The standalone JVM used a 3 GiB heap and four active processors. Input preparation took another 3.56 seconds, separately from ingestion. The JSON beside this document preserves exact timings and digest provenance.

This corpus reconstructs a saved projection, with normalized predicates and remapped graph names. It omits unselected triples and uses one synthetic confirmation triple per asset. It is not the exact network payload or complete production metadata. The native Java runtime also differs from previous container-based measurements. Background development continued during these local trials.

The result supports investigating per-asset transaction overhead. RDF POST is only a lower-bound experiment on an empty store: it does not implement safe replacement, cancellation, stale-write protection or atomic metadata publication. A production bulk importer must retain those guarantees. No production storage behavior changes in this benchmark.

## Reproduce

Build `packages/storage`, start an **owned fresh loopback** SPARQL namespace, and prepare UTF-8 N-Quads files with no blank-node identities. Each file must contain one named graph. Supply a JSON manifest:

```json
{"assets":[{"file":"asset-0.nq","graph":"urn:benchmark:asset:0","quads":1,"sha256":"SHA256_OF_FILE_BYTES"}]}
```

Run each mode against a separate empty namespace:

```sh
node packages/storage/scripts/ingest-floor-benchmark.mjs \
  --manifest /absolute/path/manifest.json \
  --endpoint http://127.0.0.1:19985/blazegraph/namespace/kb/sparql \
  --mode atomic --group 1 --storage-path /path/to/owned/journal-directory --out /absolute/path/atomic.json
```

Use `--mode rdf --group 10` for grouped ingestion. The runner refuses non-loopback endpoints, HTTP redirects and nonempty stores, verifies input digests and graph counts, records read/parse/write time separately, and stops below 5 GiB free disk. Start a fresh database for each repeat and separately restart it to check persistence. The runner does not start, stop or delete database services.

The required `--storage-path` must identify the filesystem holding the owned database journal. The 5 GiB guard checks that filesystem, independently of the report destination. Existing default-graph data is also refused.
