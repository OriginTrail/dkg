---
status: current
version: v10
audience: human+agent
doc_type: architecture
---

# Public snapshot recovery

Shared-memory recovery fetches immutable snapshot references in a pool of at most four operations per requester round. Each operation includes the local cache check, an optional network fetch, digest/count validation, and asynchronous materialization. The file snapshot store serializes capacity admission: a fresh filesystem reading accounts for outstanding byte reservations before a new write is admitted. Distinct writes then persist in parallel. Reservations end after publication or temporary-file cleanup; active snapshot leases continue through index persistence so GC cannot remove files still in use. Same-digest writes coalesce. Per-KA write locks and the existing responder admission policy still apply. Callers of the internal snapshot-walk API can lower `fetchConcurrency` to 1, 2 or 3; values outside 1–4 are rejected.

The requester checks the round deadline before starting each reference and again after an asynchronous cache miss, immediately before network dispatch. Already admitted work settles before the round returns, including materialization callbacks, so a round can extend past its admission deadline. Local deadline yields do not count as peer timeouts.

A short snapshot prefix remains missing and is retried from offset zero on a later round, while other references can advance. An incomplete stream or hard failure stops new dispatches and joins all admitted work. Reporting follows manifest order even when downloads finish out of order, including successes that finish after another reference fails. Missing-reference samples stay capped at ten entries. The requester accounts for all settled bytes, resumptions, completions, timeouts and deadline yields before rethrowing a fatal result. A timed-out sibling therefore retains its backoff signal even when another operation fails locally. The first fatal failure remains the primary cause; any other admitted fatal failures are retained alongside it. Downstream classifiers share one view of nested causes, including tags added to a group after construction. A mixed failure is eligible for transport-prefix recovery only when every cause is a retryable transport interruption and no group carries conflicting response evidence.

## Controlled latency experiment

Build the agent and its dependencies, then run:

```sh
pnpm run build:runtime:packages
node packages/agent/scripts/benchmark-public-snapshot-fetch.mjs
```

The default experiment uses 250 one-quad snapshots, a one-second delay at the production requester's `fetchSyncPages` boundary, and a 120-second round budget. It takes about five minutes. `--rows`, `--rtt-ms`, `--round-ms`, and `--limits` override those inputs. Each output includes the compiled module hash, completed/missing counts, peak offered concurrency and peer timeouts.

Measured on 2026-09-09:

| Concurrency | Snapshots recovered | Elapsed | Peak offered requests | Peer timeouts |
| --- | --- | --- | --- | --- |
| 1 | 120 / 250 | 120.205 s | 1 | 0 |
| 2 | 240 / 250 | 120.218 s | 2 | 0 |
| 4 | 250 / 250 | 63.101 s | 4 | 0 |

Four was the smallest tested cap that completed this latency-bound workload inside the round budget. This is a controlled requester scheduling measurement: it does not measure real network bandwidth, responder CPU saturation, packet loss or aggregate load from multiple requesters. The cap bounds offered concurrency per round; the existing shared admission limits continue to govern aggregate responder load.
