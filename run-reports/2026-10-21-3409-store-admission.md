# Issue 3409: external-store admission and measured capacity

## Executive summary

The two-slot ordinary lane is a software admission boundary, not a measured Blazegraph optimum. At the existing four-slot default, one ACK and one health reservation leave two shared normal/background slots. The same CPU ceiling applies to external HTTP stores even though its rationale was local Oxigraph/Rayon oversubscription. On a four-CPU daemon, raising `DKG_STORE_MAX_CONCURRENT` above four alone is silently clamped back to four.

A controlled real-Blazegraph comparison supports testing a larger ordinary budget. In the final repeatable eight-arm run, two ordinary slots delivered 36.3–37.0 metadata confirmations/s with median 595.8–596.3 ms; four ordinary slots delivered 74.1–75.4/s with median 273.1–279.2 ms. Cohort-weighted throughput was 36.67 versus 74.71/s (2.04×). ACK/health p95 remained under 19 ms at both settings. All 3,072 confirmations and every bookkeeping/probe operation completed successfully. Wider settings improved this workload further, but increased protected-lane tails; they are not a universal tuning recommendation.

The independent implementation adds an **opt-in** `DKG_STORE_CONCURRENCY_POLICY=configured`. With `DKG_STORE_MAX_CONCURRENT=6`, four ordinary slots coexist with the existing ACK and health reservations, including on a four-CPU daemon. Existing defaults, queue/deadline policy, background fairness, uncertainty and lease fencing are retained. This enables qualified external-store tuning; it does not establish a new default or resolve the original incident.

## Relationship to 3397 and the full report

- [#3409](https://github.com/OriginTrail/dkg/issues/3409) reports 248 partition-bound observations. Its median aggregate CPU idle was 28.95%, while a hot core/thread and hypervisor steal remained. Disk and memory were not exhausted. The 312 missing workload diagnostics are unknown, not healthy; queue snapshots and preceding CPU deltas do not identify individual causal queries. The report does not prove that hardware is irrelevant.
- The scheduler at incident source `7563618d2` is byte-identical to current base `a8df45838` for this investigation. A gated reproduction admits two normal holders and queues a third while ACK and health can run. Turning off the health reservation admits a third ordinary holder but then queues a health request. Non-preemptible in-flight store work cannot promise immediate reclaim of a borrowed slot.
- [PR #3397](https://github.com/OriginTrail/dkg/pull/3397) removes unnecessary authority-projection invalidations, reducing work competing for the same lane. It neither changes capacity nor caches the direct `agent.contextGraph.confirmedMeta.*` queries. Its earlier live result still shows no publication latency improvement. This investigation supplies no basis to retroactively change that conclusion or close [#3252](https://github.com/OriginTrail/dkg/issues/3252).
- A separate metadata-query prototype reduces mixed complete private/public confirmation reads from 960 to 384 per 384 requests, a 60% reduction. At two ordinary slots it measured 83.0–91.1 confirmations/s versus 37.2–38.2 baseline; combined with four slots it measured 150.0–172.0/s. It is not included in this capacity PR. Strict-placeholder ordering, approved-member expiry, cancellation and mutation/security parity require their own qualification. Raw prototype and all runs are retained locally; these results are not live publication throughput.

## Method and scope

Base: `a8df45838` (`testnet-canary`, fetched 2026-10-21). macOS ARM64, Node 22.23.3, pnpm 10.28.1. Native host reports ten logical CPUs; Blazegraph is a separate Docker container limited to four CPUs and 4 GiB, with a verified 1–3 GiB JVM heap. Image digest `islandora/blazegraph@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d`. This is not the incident's four-CPU Linux service/cgroup environment or its hypervisor steal.

A fresh owned namespace holds 64 complete root metadata graphs (alternating private/public) and 10,000 catalog-shaped triples. Each arm warms all 64 outside timing, then 24 clients execute 384 canonical metadata confirmations. One normal-priority writer continuously replaces an exact bookkeeping payload, pausing 25 ms after each response. ACK and health ASK probes run independently with the same pause. Queue snapshots are sampled every 10 ms. Calls use real Blazegraph HTTP and the actual scheduler/adapters; no store operation is replaced by sleep. The writer/probes drain after the last confirmation; unused tail time is outside cohort throughput. Normal operation counts include the writer.

Total capacities 4/6/8/10/10/8/6/4 give ordinary limits 2/4/6/8/8/6/4/2. One ACK and one health slot remain reserved throughout. The normal/background pool and floors retain their existing semantics. The workload has no background-priority producer: a larger ordinary pool also permits a larger background ceiling, and foreground gains under substantial background load remain unqualified.

Latency is measured at each confirmation caller with `performance.now`; throughput uses the entire confirmation cohort, not averaged individual latencies. Percentiles use linear interpolation and include every successful caller. Failure/probe/write counters are reported separately; none occurred. These short repeated arms do not establish a production p95 SLA or eliminate JIT/GC/order variation. Three capacity campaigns passed 9,216 confirmations in total (resource capture, portable shakeout, exact restored-source repeat); final values below are from the last campaign. The separate metadata prototype passed another 3,072 confirmations.

## Final portable comparison

| Arm | Total slots | Ordinary slots | Confirmations/s | Median ms | P90 ms | ACK p95 ms | Health p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 4 | 2 | 37.0 | 596.3 | 793.6 | 18.1 | 18.3 |
| 2 | 6 | 4 | 74.1 | 279.2 | 403.9 | 16.7 | 16.8 |
| 3 | 8 | 6 | 110.1 | 187.1 | 276.6 | 19.2 | 18.1 |
| 4 | 10 | 8 | 133.6 | 158.4 | 227.7 | 21.6 | 20.1 |
| 5 | 10 | 8 | 132.7 | 158.8 | 228.7 | 20.5 | 20.5 |
| 6 | 8 | 6 | 104.3 | 236.5 | 289.0 | 22.1 | 23.4 |
| 7 | 6 | 4 | 75.4 | 273.1 | 397.4 | 16.6 | 16.7 |
| 8 | 4 | 2 | 36.3 | 595.8 | 837.0 | 18.4 | 18.1 |

In the resource-captured campaign, backend CPU used 0.39–0.79 cores at two ordinary slots, 0.62–0.94 at four, 1.00–1.06 at six, and 1.17–1.35 at eight, out of a four-CPU quota. Container memory stayed approximately 0.94–0.96 GiB; native client CPU averaged 0.13–0.28 cores. Backend CPU uses container cumulative counter deltas over each cohort plus drain, rather than a single idle snapshot. These observations show spare capacity for this small-data workload and do not characterize the incident's large queries, locks, heap/GC or CPU steal. Adapter execution times include transport/body handling; they are not pure database service time.

## Implementation and validation

- Only the explicit `configured` policy bypasses the CPU ceiling for a safe integer process budget. Setting the policy alone retains the default four slots. Missing/unknown policies preserve the existing CPU limit. Explicit constructor capacities remain authoritative. The feature changes no queue, deadline, dispatch order, cancellation or persistence logic.
- 64 focused scheduler tests passed, including existing fairness, timing and timeout-attribution cases. New four-CPU tests prove four held ordinary operations can coexist with immediately admitted ACK and health work, queued cancellation stays pre-dispatch, background cannot take the normal floor, and unknown/default policies preserve the old ceiling.
- A fresh process with the production shared adapter scheduler, `configured` policy and total budget six completed 64 correctness-checked real Blazegraph reads and reported four ordinary slots with both reservations. This validates configuration composition beyond constructor-only benchmarks.
- Storage build and agent build/type/package checks passed. Lint, file-size, whitespace and the 2,745-file test inventory checks passed. The reproducible benchmark creates/disposes its own namespace and accepts an explicitly supplied isolated Blazegraph `/bigdata` URL. After building storage/agent, run `DKG_STORE_BENCHMARK_BASE_URL=http://127.0.0.1:19454/bigdata node scripts/repro/store-admission-capacity.mjs > comparison.json`.
- No funded wallet, PCA, live blockchain publication or production service tuning occurred. This PR makes an explicit capacity experiment available; a full Gnosis/PCA publication/share campaign is still required before changing defaults or claiming end-to-end publication gains.

## Lease expiry and next PR boundaries

The fatal legacy promote lease is distinct from admission timeouts. The canonical heartbeat reads/writes the job under the same queue mutation mutex and normal store admission used by claim/recovery/bookkeeping operations. That exposes plausible renewal delays, but the report contains no timestamps proving which mechanism prevented renewal. CPU/event-loop stalls, queue mutex wait, store admission, backend transport/service and ownership loss must be measured separately.

Merged [#3396](https://github.com/OriginTrail/dkg/pull/3396) binds new async shares to recoverable immutable authority. It improves recovery after expiry; it explicitly does not cure the original worker stall or automatically repair already failed ambiguous legacy jobs. Preserve that distinction and all duplicate-work protection.

Recommended independent scopes:

1. This capacity PR: an explicit supported budget, protected reservations, reproducible workload and transparent evidence. Qualify total six/four ordinary on the real host first; compare completion throughput, admission failures, queue/service distributions, ACK/health tails, background progress, memory/GC, event-loop delay and CPU steal. Drain/reconcile jobs and retain uncertain requests before rollback/restart.
2. A separate metadata-read PR: compose canonical proof queries without stale authority caching, with strict/member and concurrent-mutation parity tests. Measure separately, then combine with the qualified capacity setting.
3. A lease/causal-attribution PR if traces warrant it: capture request exchange → queue enqueue/dequeue → slot holder → backend start/body completion and heartbeat scheduled/lock-entered/renewed/expiry timestamps plus event-loop delay/GC. Do not relax expiry or suppress duplicate-work guards as a substitute for explaining the stall.

Keep #3397 separate and unmerged pending demonstrated benefit in a reproduced workload. Neither issue is closed by this local study.

## Artifacts and cleanup

[Per-arm measurements](2026-10-21-3409-store-admission.csv) retain all four campaign types and their denominators. Portable harness: `scripts/repro/store-admission-capacity.mjs`. Local raw results, derived container resource summaries, partition reproduction, configuration integration and prototype patch are under `.tmp/3409/` in this task's worktree. No credentials are present. The portable harness disposed its namespaces; the task-owned container was stopped and removed after all comparisons. The pre-existing image and source checkout are retained. No wallet claim was taken.
