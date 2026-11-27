# Experimental 100 MB public snapshot batches

This opt-in path compares a continuous, byte-bounded stream and grouped store
publication with the v7 exact-asset transport. It uses one configured core.
Multi-core scheduling is outside this implementation.

Enable `DKG_PUBLIC_SNAPSHOT_BULK=1` on the experimental core and receiver. The
core also requires the existing `DKG_EXACT_BATCH_STREAM_ENABLED=1` gate and a
bounded export-capable store. An authorized public snapshot job can select
`transport: "bulk"` explicitly; `transport: "exact"` selects the v7 control.
Without either opt-in, the existing transport remains the default. A selected
core must advertise `/dkg/experimental/bulk-graph/1.0.0`; an unsupported core
fails the explicit bulk job rather than silently changing the comparison.

## Bounds and acknowledgements

| Resource | Bound |
| --- | --- |
| Encoded assertion data per logical chunk | 100,000,000 bytes |
| Requested assets per chunk | 1,024 |
| Data frame | 64 KiB |
| Unconsumed disk staging | 16 MiB and 32 assets |
| Commit group | 8 assets, 64 MiB estimated parsed heap, 8 MiB expanded target |
| Flush interval while a group is waiting | 1 second |
| Existing individual asset profile | 4 MiB encoded, 16 MiB expanded, 100,000 rows, 32 MiB estimated parsed heap |

The receiver can hold one incoming verified asset in addition to the current
group while deciding whether to flush. An individual asset larger than the
8 MiB group target is committed alone, within the existing per-asset bounds.
An asset outside that existing profile fails closed; arbitrary oversized
assets are not supported by this experiment.

The directory binds the ordered requested identities and snapshot digest to
metadata, encoded offsets, encoded and expanded lengths, and encoded hashes.
Small frames are written into a receiver-owned staging directory. `CREDIT`
returns staging capacity only after the normal verifier has consumed an asset.
It is not a durable receipt. `COMMIT` is emitted only after the store callback
has completed atomic publication. Received, verified and committed counts are
recorded separately. The final directory digest must also match before the
chunk is complete.

This is a new protocol. The v7 wire format, ten-asset limit, two-asset window
and commit-before-ACK meaning are unchanged. The new stream has a 120-second
read-idle deadline and a total lifetime bounded by the existing one-hour
snapshot job. A 100 MB chunk may span more than v7's 120-second *total* stream
lifetime. Query and product-read deadlines are unchanged.

## Integrity and publication

The responder shares normal public authorization, admission, prepared-content
cache and fresh per-asset source fences. It does not serve private graphs or
accept a caller's snapshot digest as authorization. The receiver uses the same
decompression, scope filtering, canonical integrity verifier and independently
authenticated snapshot evidence as the exact transport. A fresh snapshot
comparison remains mandatory before reporting current graph coverage.

Group materialization acquires all normal per-asset locks in a fixed order,
checks local versions under those locks, merges same-version metadata, and
overlays locally trusted controls. The entire group fails before mutation if
any member has a newer local assertion. The actual dispatched transaction
retains those locks until it settles, even after cancellation. A revoked graph
binding quarantines every member of the committed group before releasing the
locks. Post-publication shared-memory twin reconciliation remains best effort,
using the same code as individual materialization.

`replaceAssetGroup` is an optional store capability. Native Blazegraph uploads
N-Quads to hidden staging graphs, then performs one guarded transaction that
publishes all assertions and their metadata subjects and creates a commit
receipt. The guard checks every staged count inside that transaction. An
indeterminate upload/publication never falls back to another write path.
Oxigraph uses one embedded update transaction; SPARQL HTTP requires its
explicit atomic-update consistency profile. Store decorators forward the
capability and maintain graph indexes and changelogs. Unsupported stores fail
the experimental job. Existing individual sync remains available explicitly.

## Recovery and evidence limits

Successful chunks remove only their own consumed staging files. Failed chunks
retain bounded staging for diagnosis. Staging is temporary and has no durable
resume token: restarting a failed job requires a fresh snapshot and normal
independent verification. Already committed assertions remain protected by
the normal version/idempotency rules. Automatic range resume, multi-core
downloads and arbitrary large-asset profiles are separate work.

The preserved-journal comparison is a local mechanism benchmark. Captured
chain/public-policy fixtures, loopback transport and a quiet source cannot
establish live mainnet latency or certification. Report exact identity/root
coverage, smoke outcomes, cache work and cleanup independently of elapsed time.

## Local comparison against v7 (2026-10-12)

A preserved 565-asset journal was replayed through real Noise sockets, the
production verifier, and fresh native Blazegraph receiver journals. The
control used commit `836508bda320e6a64d1e592cf845eeec1384cf46`.

| Source cache state | v7 transfer | Bulk transfer | Reduction |
| --- | ---: | ---: | ---: |
| Cold | 351.818 s | 325.716 s | 7.4% |
| Warm | 285.040 s | 258.977 s | 9.1% |
| Restarted, persisted cache | 288.231 s | 256.852 s | 10.9% |

All six transfers independently matched the 565 stored identities, roots and
versions. Each bulk transfer used one stream and 258 commit groups, compared
with 57 streams and 565 individual commits. Its 79,706,381 encoded data bytes
fit in one logical chunk; a separate boundary test exercises the 100 MB cap.
Warm and restarted transfers reused all 565 payloads without new DATA exports.

These are single local runs with captured chain/public-policy fixtures. Cold
and warm phases share the benchmark's Noise identities and verifier process;
each receiver journal/store process is fresh, and the restarted phase also
recreates the source and verifier processes. The local store operation timeout
was 30 seconds for both variants. This does not reproduce live-core contention,
fresh-client startup, on-chain snapshot acquisition, or first-detection time.
