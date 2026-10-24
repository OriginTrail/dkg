---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Size and diagnose the RPC request budget

`chain.rpcRequestBudget` limits physical outbound JSON-RPC requests for the
whole daemon. The agent, publisher wallets and direct daemon routes share one
governor. Adding a wallet does not add another request budget. Each HTTP attempt,
including a failover hop or provider retry, takes a permit; governed providers
send one JSON-RPC entry per attempt.

The defaults are `maxRequestsPerSecond: 10`, `burstRequests: 20`,
`foregroundReservePercent: 80`, `maxQueueSize: 256` and `startupJitterMs: 30000`.
Background work has a 2 rps sub-budget under these defaults, while foreground
work can use the full 10 rps. Startup jitter delays ordinary background work.
Authority-priority reads retain their own class's rate limit.

Set overrides in the node's configuration under `chain.rpcRequestBudget`.
Operator configuration takes precedence over network defaults, field by field.
**Restart the node to apply a change**: the governor is constructed once when
the daemon starts. Use the same restart procedure as other chain configuration
changes in [Daemon Lifecycle](run-node.md).

## Measure before sizing

Take two authenticated diagnostic snapshots around a representative workload:
`GET /api/diagnostics/rpc-usage` attributes requests by consumer and method, and
`GET /api/status` exposes `chain.rpcRequestTiming` and `chain.rpcRequestGovernor`.
Measure quiet traffic as well as the burst. Count physical attempts, including
approvals, planning reads, receipt polling, retries and failover. An RPC count
per publish changes with the chain, quorum, payment path and receipt latency.

Let `B` be quiet traffic in requests/second, `C` the extra requests per finalized
publish, `W` the number of publisher wallets, and `N` the number of concurrent
publish jobs. At most `M = min(W, N)` execute concurrently because each wallet
serializes its transactions. For a desired average execution time of `D`
seconds per publish, the request-rate requirement is approximately:

```text
R >= B + M * C / D
request-limited publish throughput <= (R - B) / C
request-only drain time for a burst of N jobs >= N * C / (R - B)
```

Add headroom for workload variation and keep the rate within the provider's
quota, including other processes using that account. These are demand estimates,
not guarantees: ACK collection, store admission, nonce lanes and chain finality
can dominate even when RPC admission is fast. More wallets improve throughput
only while these resources have capacity.

For a worked example, the six-wallet, 57-job report in
[#2949](https://github.com/OriginTrail/dkg/issues/2949) observed roughly 5,300
extra requests, or about **93 per publish**, over about 2 rps of quiet traffic.
That cost includes re-driven passes; it is an aggregate from that run, not a
universal per-publish constant. With `W=6`, `N=57`, `M=6`, `C=93` and `B=2`, the
10 rps default leaves 8 rps for publishing: roughly 5.2 publishes/minute and a
request-only burst drain time of at least 663 seconds. A target of `D=30` seconds
per executing publish requires about `2 + 6*93/30 = 20.6` rps before headroom.
Re-measure `C` on the current build before choosing an override. This calculation
does not validate a higher rate on a particular provider or reproduce that
incident's job outcomes.

A larger queue does not raise throughput. Increase it only if instantaneous
queue saturation rejects useful work; it can otherwise add wait and cancellation.
The foreground reserve protects capacity from background work and does not
raise the total rate.

## Read the diagnostics

`chain.rpcRequestTiming` contains bounded process-cumulative histograms for
`foreground` and `background`, with buckets `<=10`, `<=100`, `<=1000`, `<=5000`,
`<=20000` and `>20000` milliseconds. Each distribution has `count`, `totalMs` and
`buckets`. Compare snapshots within one process; a restart resets them.

| Field | What it measures |
| --- | --- |
| `admissionWait` | Waits that received a local permit. |
| `admissionDeadlineWait` | Waits cancelled by a transport-owned attempt deadline, including an enclosing deadline. |
| `admissionCancelledWait` | Waits cancelled by their caller or lifecycle owner; even a caller-supplied timeout reason is counted here. |
| `admissionRejectedWait` | Admission refusals, including a full queue or an immediate diagnostic refusal. |
| `endpointLatency` | From dispatch to complete HTTP body or transport failure; excludes local admission wait. |
| `endpointFailures` | Physical attempts that failed or returned a non-2xx HTTP response. A 2xx JSON-RPC application error is not an HTTP failure. |

`chain.rpcRequestGovernor` is a non-draining snapshot of the shared governor's
current logging window. The daemon's minutely log emission resets its interval
counters, so repeated API reads preserve counters but reads across a log tick
cannot be subtracted as process-cumulative data. Queue depth and available tokens
are instantaneous samples. The field is `null` when no daemon RPC runtime exists.
Reading status sends no health probe and consumes no permit.

The `rpc_request_governor` journal line uses these names:

| Log field | API field | Meaning |
| --- | --- | --- |
| `max_rps` | `maxRequestsPerSecond` | Total configured request rate. |
| `background_max_rps` | `backgroundMaxRequestsPerSecond` | Background rate within the total budget. |
| `available` | `availableTokens` | Tokens currently available in the total bucket. |
| `background_available` | `backgroundAvailableTokens` | Tokens available in the background bucket. |
| `foreground_queued`, `background_queued` | `foregroundQueued`, `backgroundQueued` | Current waiter counts, not peak depths. |
| `foreground_admitted`, `background_admitted` | `foregroundAdmitted`, `backgroundAdmitted` | Permits granted during this window. |
| `foreground_deferred`, `background_deferred` | `foregroundDeferred`, `backgroundDeferred` | Requests that had to wait; does not measure wait duration. |
| `rejected` | `rejected` | Requests refused admission without joining the queue. |
| `cancelled` | `cancelled` | Queued requests cancelled before admission; inspect timing to separate deadlines and callers. |
| `startup_delay_ms` | `startupDelayRemainingMs` | Ordinary background startup delay still remaining. |
| `window_s` | — | Duration of the emitted log interval. |

If admission waits rise while endpoint latency stays low, local contention is
the constraint. If endpoint latency rises with little admission wait, investigate
the providers. Both can occur together. Queue depth alone cannot establish how
long a request waited.

An attempt deadline that expires while a request is queued and **no endpoint
request remains in flight** returns `RPC_REQUEST_GOVERNOR_QUEUE_FULL`, even if
earlier requests in that operation succeeded. It does not trigger endpoint
failover or de-preference. A genuinely outstanding endpoint request can still
time out. Enclosing operation deadlines and caller cancellation remain binding.
The local-capacity code does not prove an enclosing publish never sent an earlier
transaction: the publisher's persisted hash/write-ahead gates still determine
whether retry is safe. See [Held jobs](async-publisher-wallets.md#held-jobs).
