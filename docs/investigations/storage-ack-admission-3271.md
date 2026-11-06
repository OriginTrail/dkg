# Storage ACK admission delay (#3271)

The node retains its existing FIFO collector limit (one by default). This change
adds phase measurements and cancels queued admission when the node lifetime
closes. Settled publish/update rounds also cancel their obsolete outbound sends
and retry sleeps, and ignore late responses before starting more identity reads. It does not change quorum, candidate selection, signatures, retry budgets,
deadlines, wallet/nonce behavior, or the default concurrency setting.

## Operator diagnosis

Each agent publish/update ACK-provider call emits one `[StorageACKAdmission]`
JSON summary. Durations use a monotonic clock. The summary has fixed fields and
contains no peer IDs, graph IDs, payloads, credentials, or peer-supplied text.

- `preflightMs`: validation and chain preflight before gate admission, or time to
  a preflight failure. It is not counted as FIFO wait.
- `gateQueuedAfterMs`, `gateAcquiredAfterMs`, `gateReleasedAfterMs`: phase times
  relative to operation entry. An unentered phase is `null`.
- `gateWaitMs`, `collectorMs`, `totalMs`: FIFO wait, collector-promise lifetime,
  and total provider-call time. Collector time includes candidate discovery.
- `maxQueued`, `maxActive`: observed node-local collector queue/active counts.
- `completedPeerAttempts`, `peerAttemptMs`, `perRoundPeakPeerRequests`: completed
  transport attempts, summed attempt durations and peak in-flight requests in
  this round. Summed durations can exceed elapsed time when peers run in parallel.
- `backoffs`, `backoffMs`, `transportBackoffs`, `transientDeclineBackoffs`:
  completed retry sleeps, their summed durations and the two retry causes.
- `candidates`: bounded terminal counts (ACK, decline, invalid, unsupported,
  transport failure, pending) when the collector resolves or rejects. A discovered
  pool below quorum retains its actual total; unattempted candidates are pending.
  Counts come from typed peer states, independently of operator reason strings.
- `outcome`: succeeded, failed, cancelled or preflight_failed.

A high gate wait behind another round's long collector/backoff time identifies
local waiting amplification. A transport/transient-decline backoff describes a
peer-facing failure; it does not establish the responder's internal cause.
Existing peer-detail logs remain the separate diagnostic surface.

A collector can settle at quorum while extra peer attempts are still retiring.
The gate owns collector promises, not all physical network activity. The
per-round counters stop at settlement; pending attempts are not presented as
completed, and `maxActive` is not a global network-pressure ceiling.

## Comparable owned-network measurement

`packages/agent/test/storage-ack-admission-live.test.ts` starts four local libp2p
nodes with mDNS disabled. The real Messenger frames ACK requests, three controlled
signers return actual ECDSA signatures, and the real ACKCollector verifies three
unique identities for each round. Six simultaneous rounds share the gate. One
signer on the first round delays 100 ms, declines once with
`CORE_TEMPORARILY_UNAVAILABLE`, and then succeeds. Healthy replies delay 20 ms.
The collector uses its unchanged real 1-second first backoff; sleep is not mocked.

Two runs on Node 22.23.2/macOS gave the following ranges:

| Configured collector limit | ACK rounds/s | Gate wait p50 | Gate wait p95/max | Peak sender attempts / receiver handlers | Failures |
| --- | --- | --- | --- | --- | --- |
| 1 (production default) | 4.47–4.53 | 1173–1188 ms | 1277–1294 ms | 3 / 3 | 0 of 6 |
| 2 (comparison only) | 5.19 | 37 ms | 137–139 ms | 6 / 6 | 0 of 6 |

Each cohort had exactly one retry backoff and every successful round retained
three valid ACKs. The comparison reduces follower wait but doubles simultaneous
peer work. It does not model saturated public core stores, submit transactions,
or measure whole-publication throughput. It is not sufficient evidence to raise
the production default. The historical WSL remote-core cause remains unknown;
the six-wallet Blazegraph acceptance of #3252/#3253 is a separate investigation.

Run the owned-network comparison with:

```sh
pnpm --filter @origintrail-official/dkg-agent exec vitest run \
  --config vitest.unit.config.ts test/storage-ack-admission-live.test.ts --maxWorkers=1
```

## Cancellation and shutdown

The previous queue retained waiters after the node work lifetime closed and could
start another collector after the active one finished. The regression fails on
the unchanged baseline and passes with cancellation-aware FIFO admission.

The provider captures its lifetime before preflight, so a late preflight cannot
join a reopened node's queue. Queued cancellation removes only that waiter and
preserves FIFO among survivors. An active collector keeps its slot until its
promise settles, and its result cannot escape a closed lifetime. Shutdown tracks
that retirement before store teardown. A non-cooperative preflight/collector can
therefore delay retirement or trigger the existing shutdown quarantine; this is
not a promise of immediate physical cancellation. Tests cover this ownership,
reopen fencing, throwing observers and synchronous observer reentrancy.


## Settled-round retirement

Previously, reaching quorum returned three valid ACKs immediately but left other
sends running until their own timeout or response. A late response could still
launch identity verification after the caller had its final result. The round's
120-second timer also remained armed after success. In retained2026-10-30 live
canary runs,54–62 of66 rounds ended with candidates still pending (including six
warmups). Pending includes transport and validation; it does not count remote
store operations.

Each round now owns a cancellation signal and clears its deadline at settlement.
It forwards cancellation through the existing request-owned Messenger transport
and self-ACK path. Success, impossible quorum, timeout and caller cancellation
stop obsolete sends/backoffs. Late replies and already-started verification
results cannot add ACKs, trigger further verification or change the settled
round. Three valid unique identities are still required; concurrency, candidate
selection, deadlines and retry budgets retain their existing values.

The same signal reaches identity verification through its existing chain-read
options. Native cancellable reads stop; custom verifiers that ignore it retain
their own physical lifetime. Cancellation does not prove that an older remote
handler stopped its store work. The receiver and local self-ACK
transport keep their existing physical-completion/drain ownership. A custom
transport that ignores the optional signal may continue running, but its late
reply is fenced. The real-P2P regression deliberately keeps one remote handler
blocked after quorum while checking that all caller-side sends retire and no
durable outbox retry is created.

This removes avoidable publisher work. It does not by itself explain a remote
handler deadline or eliminate FIFO waiting during an active slow round. Matched
live baseline/PR measurements are required before claiming publication latency
or throughput improvements. Query/store QoS and responder-phase attribution
remain separate evidence requirements.
