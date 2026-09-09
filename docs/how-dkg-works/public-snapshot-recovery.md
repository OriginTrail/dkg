---
status: current
version: v10
audience: human+agent
doc_type: architecture
---

# Public snapshot recovery

Shared-memory recovery fetches immutable snapshot references in a pool of at most four operations per requester round. Each operation includes the local cache check, an optional network fetch, digest/count validation, and materialization. The file snapshot store serializes capacity admission and persistence across distinct digests, so each write observes the preceding write’s disk usage before checking the hard reserve. Downloads and cache reads remain parallel. Per-KA write locks and the existing responder admission policy still apply. Callers of the internal snapshot-walk API can lower `fetchConcurrency` to 1, 2 or 3; values outside 1–4 are rejected.

The requester checks the round deadline before starting each reference and again after an asynchronous cache miss, immediately before network dispatch. Already admitted work settles before the round returns, so finishing a snapshot can extend slightly past the admission deadline. Local deadline yields do not count as peer timeouts.

A short snapshot prefix remains missing and is retried from offset zero on a later round, while other references can advance. An incomplete stream or hard failure stops new dispatches and joins all admitted work. Reporting follows manifest order even when downloads finish out of order, including successes that finish after another reference fails. Missing-reference samples stay capped at ten entries. The first failure that stops dispatch remains the primary cause; any other admitted failures are retained alongside it. Downstream denial, transport, backoff, and permanent-rejection classifiers inspect every failure. A mixed failure is eligible for transport-prefix recovery only when every cause is a retryable transport interruption.

## Controlled latency experiment

Build the agent and its dependencies, then run:

```sh
pnpm --filter @origintrail-official/dkg-agent... build
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
