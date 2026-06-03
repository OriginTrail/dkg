# Node-communication benchmark

Measures **how long it takes one DKG node to sync a newly-shared item from
another node**, and how much **memory** and **disk** that costs — then compares
each run against a baseline and **flags regressions** (e.g. memory up >15%).

Unlike the ESBench suite in `bench/publish-async-get.bench.ts` (a deterministic,
in-process microbenchmark of the publish/get memory layers), this benchmark
boots **real `DKGAgent` nodes over loopback libp2p** and exercises the actual
peer-to-peer path: SWM gossip and the sync-on-connect protocol. It is chain-free
(no Hardhat, no daemon) so it is cheap enough to run every day.

### No mocks — real nodes, real storage, real protocols

There are **no** Vitest/Jest mocks, stubs, or fake network layers in this suite.
Each run starts full `DKGAgent` instances (same stack as `dkg start`: libp2p,
Oxigraph triple store on disk via `dataDir`, Universal Messenger / sync protocol).
Data is real RDF quads written through `share()` and read back with `query()` on
the `_shared_memory` graph — not canned responses.

| Piece | What the benchmark uses |
| --- | --- |
| Node runtime | Real `DKGAgent` + `DKGNode` (in-process, not a test double) |
| Network | Real libp2p TCP on loopback (`connectTo`, GossipSub, sync-on-connect) |
| Storage | Persistent Oxigraph under each agent's temp `dataDir` |
| Chain | `NoChainAdapter` (production adapter when no RPC is configured — **not** `MockChainAdapter`). SWM scenarios do not call on-chain APIs. |
| Catch-up seeding | Normal `share()` while the joiner is offline; joiner pulls via sync-on-connect (no `localOnly` shortcut) |

## Scenarios

| Scenario | What it measures |
| --- | --- |
| `swm_gossip_propagation_single` | Latency for **one** newly-shared SWM entity to reach a connected, subscribed peer. The headline "time to sync a new thing". |
| `swm_bulk_propagation` | Time for a **burst of N** newly-shared entities to fully reach the peer (throughput under load), plus the disk/stored-quad footprint on the receiver. |
| `swm_catchup_on_connect` | **Cold catch-up**: a late-joining node subscribes, then connects — sync-on-connect must pull N pre-existing SWM entities. Measures how long a node that joined late takes to catch up. |

## Metrics recorded (every metric is "higher is worse")

- **Time** — per-scenario `durationMs` (`min`/`max`/`mean`/`median`/`p95`/`stddev`) and `perItemMsMean` for the multi-item scenarios.
- **Memory** — `peakRssBytes` and `peakHeapUsedBytes` (high-water marks, sampled every 100ms), plus post-GC `finalHeapUsedBytes`. (Final RSS is recorded for info but excluded from regression comparison because it doesn't shrink predictably.)
- **Disk / space** — each node's on-disk data-dir size (`dataDirBytes`), and the receiver's synced SWM triple count (`storeQuads`) per scenario.

## Run it

```bash
# default run (writes results, compares, flags regressions)
pnpm bench:node-comms

# quick smoke run
pnpm bench:node-comms -- --iterations 2 --bulk 10 --catchup-iterations 1

# (re)establish the pinned baseline from this run
pnpm bench:node-comms:baseline

# re-check the last result against the baseline/history without re-running
pnpm bench:node-comms:check
```

Always rebuild first so the benchmark reflects current code
(`pnpm --filter "@origintrail-official/dkg-agent..." build`). The daily runner
and `node --import tsx` wrapper handle this for you; `--expose-gc` (already set in
the npm script) makes the heap numbers stable.

### Options

| Flag | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `--iterations N` | `BENCH_NODE_COMMS_ITERATIONS` | 5 | Measured iterations for the latency scenarios. |
| `--catchup-iterations N` | `BENCH_NODE_COMMS_CATCHUP_ITER` | min(iterations, 3) | Catch-up iterations (each spins up a fresh node pair). |
| `--bulk N` | `BENCH_NODE_COMMS_BULK` | 50 | Entities for the bulk / catch-up scenarios. |
| `--warmups N` | `BENCH_NODE_COMMS_WARMUPS` | 2 | Discarded warmup iterations (graft the gossip mesh). |
| `--threshold N` | `BENCH_REGRESSION_THRESHOLD_PCT` | 15 | Percent delta that flags a regression. |
| `--out DIR` | — | `bench/results/node-comms` | Results directory. |
| `--baseline` | — | — | After running, also save the result as `baseline.json`. |
| `--no-check` | — | — | Skip the regression check (still writes results/history). |
| `--keep-data` | — | — | Keep the agents' temp data dirs (debug). |
| `--verbose` | `DKG_BENCH_VERBOSE=1` | off | Show the agents' raw DKG/libp2p logs (quiet by default). |

## Output files (in `bench/results/node-comms/`, git-ignored)

- `latest.json` — the full result of the most recent run.
- `history.ndjson` — one line of curated metrics per run, for day-over-day trends.
- `regression-report.json` — the comparison from the most recent check.
- `baseline.json` — the pinned baseline (only if you ran `:baseline`).
- `logs/` — daily-runner logs.

## How regression flagging stays robust

Microbenchmarks jitter run-to-run, so a naive "compare to previous run, flag at
15%" would false-alarm constantly on sub-10ms latencies. Three guards prevent
that:

1. **Rolling-median baseline** — with no pinned `baseline.json`, the reference is
   the per-metric **median of the last N runs** (`--window`, default 10), not a
   single noisy previous run.
2. **Absolute-delta floors** — a metric must move by *both* the percent threshold
   *and* a minimum absolute amount to flag: `15ms` for latencies, `32MB` for
   memory, `4KB` for disk, `1` for quad counts (all configurable via
   `BENCH_MIN_DELTA_*`). A 6ms→8ms (+33%) blip never trips; a 480MB→560MB jump
   does.
3. **Baseline warmup** — with a rolling reference and fewer than
   `BENCH_REGRESSION_MIN_SAMPLES` (default 3) historical runs, deltas are reported
   but the run is **not failed**, so the baseline "learns" before enforcing.

A pinned `baseline.json` always enforces immediately (no warmup).

**Exit codes:** `0` = clean / warming up / baseline run · `1` = enforced
regression flagged · `2` = the benchmark failed to run.

## Daily scheduling

`scripts/bench-node-comms-daily.sh` rebuilds the agent, runs the benchmark, and
exits with the benchmark's status (1 on a flagged regression) so a scheduler can
alert.

- **macOS (launchd):** edit `scripts/com.dkg.bench-node-comms.plist` (replace the
  two placeholders), copy to `~/Library/LaunchAgents/`, then
  `launchctl load ~/Library/LaunchAgents/com.dkg.bench-node-comms.plist`.
- **Linux (cron):** add a line such as
  ```cron
  30 3 * * *  cd /path/to/dkg && BENCH_REGRESSION_THRESHOLD_PCT=15 scripts/bench-node-comms-daily.sh >> /path/to/dkg/bench/results/node-comms/logs/cron.log 2>&1
  ```
