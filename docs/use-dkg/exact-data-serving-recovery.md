# Bounded exact DATA serving

The serving recovery patch improves negotiated `byte-budget-v1` exact-asset
DATA requests on content-holding nodes. It does not change the installer,
chain authority checks, full-assertion Merkle verification, or partial-KA
resumability.

Exact DATA responses contain at most 512 rows and 4 MiB of serialized N-Quads.
They are assembled from store windows of at most 64 rows (plus a final-graph
sentinel), with an 8 MiB HTTP store-response ceiling. Oversized store responses
halve the window before retrying. Embedded stores retain the existing bounded
row window; their adapters do not enforce the HTTP byte ceiling. Broad payload row
snapshots remain disabled on the store-paging path. Negotiated singleton gzip
requests may instead use a complete public-KA export on a store advertising
pre-materialization HTTP response limits. That export verifies the full count
and Merkle root within 16,384 rows, an 8 MiB store response, 4 MiB of canonical
N-Quads and 32 MiB of retained row heap. Its cache and response leases share
the responder budget; receivers still verify chain authority.

A session retains a plan of graph names and committed row counts, independently
of payload snapshot caching. Its identity includes the authenticated remote
peer, Context Graph, exact asset selection and opaque session token, stored as
a fixed-size digest. Active reads refresh the ten-minute inactivity TTL.
Continuation requires the existing plan; expiry, eviction or a superseding
token requires a restart. Each plan memoizes one reader selection: store pages
retain their cursors, while export pages retain the selected asset identity.
Concurrent first reads share that selection, and an unavailable export
continuation cannot switch row ordering. The response owns its export lease
through serialization, physical compression and the final source fence.
Aborted plan loads physically drain before responder
admission is released, and their late results are not cached.

Plan scalars are limited to an estimated 1 MiB. Each retained plan reserves
256 KiB for its cursor map in the shared responder budget; cursor count and
estimated bytes are both bounded. Large or unsupported cursor terms use the
existing ordered OFFSET path. Selected payload and Context Graph metadata
revisions are checked before and after page reads; disjoint payload writes
do not invalidate the plan. Revision tracking uses graph prefixes, so a write
to another graph sharing a selected prefix can conservatively expire a session.
External writes outside a store's revision coverage remain
covered by row-count/sentinel checks and requester Merkle verification.

After an indeterminate HTTP write, the store remains marked unstable. Fresh
singleton sessions can recover through complete bounded, count/root-verified
exports; every page re-exports, and unstable bodies are neither reused nor
retained in row or encoded caches. Generation and stability changes expire
retained plans and leases. Unsupported, private or over-profile unstable
requests fail closed instead of falling back to store paging. Verified
immutable assertion bytes establish content integrity; they do not establish
remote quiescence or certify that current physical DATA is unchanged.

Byte-truncated pages remember the boundary actually returned. Requesters
advance by parsed rows and accept an empty response as EOF, so short byte-bound
pages do not skip rows or falsely complete a KA. Legacy requests keep their
existing signed 500-row limit and pagination behavior. Responder concurrency,
queue limits and authorization on each request remain in force.

Deploy this change to the Core or publisher nodes that hold the graph payload.
Existing byte-budget-capable DKG receivers can benefit without an
installer change. A 512-row response can reduce small-row network requests by
up to eight times; this is a page-count bound, not an end-to-end sync-time
measurement. Core blockchain-metadata caching and receiver partial-KA resume
are separate changes.
