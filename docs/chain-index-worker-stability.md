# Chain-index reads and connection stability

Status: implementation notes for PR #2784. Deployment status must be verified from each node's running commit.

The fix addresses three independently reproduced mechanisms: a KA-to-graph lookup replaying all retained registrations on the main thread, overlapping libp2p health/monitor probes exceeding the one-stream ping limit, and a valid ping reply followed by delayed stream closure incorrectly aborting the connection. It does not establish the cause of the original overload or prove long-term production recovery.

## Implementation

KA point reads select the registration signature and indexed KA ID (`topic2`) before decoding. A SQLite index covers scope, emitter, event signature, KA ID and event order; the point query explicitly selects it so a database without planner statistics cannot silently scan the history. Existing databases receive the additive index during initialization, before serving requests.

The daemon owns one reader worker with a read-only SQLite connection and a reader API that exposes no commit or tombstone operations. The writable daemon store reuses the same query implementation. The worker captures cursor, coverage, matching rows and own-write evidence in one transaction, releases that transaction, then decodes. Inline and worker readers use the same explicit snapshot planner and evaluator in the chain package, including finality, coverage and own-write gates. The worker does not simulate a writable store or replace registry methods. The existing event-log connection remains the writer. Small responses are checked against the current revision, lineage, topic set, fork suspicion and head age before being accepted; adapter binding checks remain in place.

A single `ChainIndexCapability` pairs the required store with its optional reader factory through the agent and EVM adapter. Existing configuration and runtime-option interfaces remain extendable. Opt-in strict configuration types exclude contradictory ownership, and construction rejects it at runtime. The exported runtime factory still accepts its existing `{ store }` options, whose legacy interface retains a required store. Modern factories must provide scalar ordinal reads; a malformed JavaScript factory is rejected instead of receiving list replay. List-only adaptation is limited to explicit legacy binding attachments and sources. A WeakMap caches only the adapted reader; the original binding and its method receivers remain unchanged, and object identity remains the generation token. Injected factories remain attached across Hub binding rotations.

The daemon resource owns that capability and one parameterless, idempotent close operation. Its dependency-drain callback is fixed at construction: concurrent callers cannot replace or omit it. Cleanup retires the worker and awaits the dependency barrier before closing the database on startup failure, fatal prerequisites and normal shutdown. Failed retirement keeps the database open, while startup errors retain their original cause.

Snapshot and worker protocol types preserve the relationship between each operation, its required request fields and its result. A served response requires both its result and revision fence. One exhaustive operation table owns each read kind's query, coverage family and caught-up requirement, decoder, and typed result projection. Window planning is separate from own-write hash verification, which runs during evaluation. Shared snapshot implementation details are exposed to the CLI through the explicit `@origintrail-official/dkg-chain/internal/chain-index-worker` subpath instead of widening the public package root.

Limits are explicit:

- At most 64 callers and four physical reads, with equivalent reads shared between callers.
- A 1.5-second read deadline and separate 10-second worker startup deadline. A cold reader can finish starting after an individual caller falls back.
- SQLite reads at most 8,193 rows; a result exceeding 8,192 rows is refused, never treated as a complete history. This bounds native allocation before JavaScript decoding.
- Decoding yields every 128 rows. Ordinal callers receive one KA ID; the compatibility list port refuses lists larger than 1,024 entries.
- Cancelled physical work retains its slot and watchdog until the worker replies. Stuck workers are terminated; replacements wait for retirement and a one-second cooldown. Shutdown also awaits retired workers.

The worker process owner represents idle, starting, ready, retiring, cooling and closed states explicitly. Scheduling uses one physical-read record with queued, dispatched, detached and completed phases. Detaching the last caller removes the coalescing entry but retains the physical record until the reply or confirmed worker retirement.

Misses, incomplete coverage, oversized graphs, stale answers, overload and worker failure use the existing RPC fallback. They cannot revive a full-history main-thread replay. Large graphs therefore still incur RPC calls for ordinal reads. The SDK's non-worker path also benefits from the indexed point lookup.

The ping service now coordinates periodic liveness probes and explicit health calls per connection. It replaces the independent built-in monitor using the supported configuration option, retaining the standard inbound responder, 10-second interval, adaptive deadlines, echo validation and connection teardown on probe failure. A small transport primitive isolates the outbound ping implementation and its required remote-FIN extension. The coordinator honors caller stream options, shares compatible probes, serializes incompatible probes, and delivers stream progress to each observer. A probe holds its outbound slot until remote FIN or a stream reset completes. Connection close logs preserve the supplied initiator and bounded, escaped error details.

### Ping ownership and API compatibility

An explicit ping rejects with `UnsupportedProtocolError` when negotiation finds no ping protocol. The periodic monitor accepts that negotiation as evidence of responsiveness, even when sharing the same physical probe. No RTT is invented or written to the connection without a verified pong.

Each physical probe has its own cancellation controller. Cancelling the last explicit observer cancels the probe only if the monitor has not adopted it; another explicit observer or monitor owner keeps the work alive. An orphaned probe resets its stream without aborting the connection. New callers wait for that cancelled probe to release the protocol slot instead of adopting its cancelled work. A throwing progress observer follows the same ownership rule.

Probe and cleanup cancellation use explicitly disposed parent listeners, including the service-lifetime signal. Completed probes remove those listeners; cancellation does not train the adaptive timeout as a peer-latency failure. Regression coverage includes repeated scope disposal, unsupported negotiation, cancellation before pong and during cleanup, shared ownership, physical-queue saturation/recovery, and adaptive deadlines with distinct minimum/maximum bounds.

These fixes do not change the existing monitor interval or timeout bounds. Pre-pong timeouts can still reflect remote overload or network delay; they do not prove a process is dead. Production rollout and long-uptime results remain separate from local validation.

## Sequence diagrams

### Indexed read, snapshot validation and RPC fallback

```mermaid
sequenceDiagram
    autonumber
    participant U as DKG caller
    participant A as Chain adapter
    participant C as Reader client (main thread)
    participant W as Read worker
    participant D as Event-log SQLite
    participant R as Existing RPC path
    U->>A: Resolve KA binding or graph ordinal
    A->>C: Read KA binding or scalar ordinal
    C->>C: Bound admission and coalesce equivalent reads
    opt Worker is cold
        C->>W: Start with read-only database path
        W->>D: Open read-only handle
        W-->>C: ready
    end
    C->>W: Compact request with view, barrier and deadline
    W->>D: BEGIN read snapshot
    W->>D: Read cursor, coverage and bounded matching events
    Note over W,D: KA point query uses topic0 + topic2 and the KA index<br/>Read at most 8193 rows to detect overflow
    opt Own-write barrier supplied
        W->>D: Read held block hash
    end
    W->>D: ROLLBACK releases read snapshot
    alt Snapshot exceeds 8192 rows
        W-->>C: Unavailable (row-limit)
    else Snapshot is bounded
        W->>W: Run shared snapshot evaluator with batched decoding
        Note over W: Latest/finalized view, coverage, own-write hash,<br/>head age and fork suspicion remain authoritative
        W-->>C: Scalar answer plus revision fence, or unavailable
    end
    opt Candidate answer exists
        C->>D: Read current small cursor/coverage state
        C->>C: Recheck deadline, revision, lineage, topics and freshness
    end
    C-->>A: Accepted candidate or unavailable
    A->>A: Check adapter binding is still current
    alt Candidate and binding remain valid
        A-->>U: Return binding or scalar ordinal
    else Local read cannot answer
        A->>R: Existing governed contract read
        R-->>A: Chain result or existing error
        A-->>U: Result or existing error
    end
```

The writer remains the existing daemon store. No historical array is sent back for point/ordinal reads. Queue refusal, startup delay and worker failure can also produce the unavailable outcome before a worker request is dispatched. Caller cancellation rejects the caller instead of automatically starting a fallback RPC.

### Shared callers, cancellation and physical work retirement

```mermaid
sequenceDiagram
    autonumber
    participant A as Caller A
    participant B as Caller B
    participant C as Reader client
    participant W as Read worker
    A->>C: Read binding K with abort signal
    C->>W: Dispatch one physical read
    B->>C: Equivalent read K
    C->>C: Join existing job (same original deadline)
    A->>C: Abort
    C-->>A: Reject with abort reason
    Note over C,W: Caller B remains attached; physical read continues
    alt Worker replies before deadline
        W-->>C: Candidate result
        C->>C: Validate current state and deadline
        C-->>B: Accepted answer or unavailable
    else Physical read reaches deadline
        C-->>B: Unavailable (adapter may use RPC)
        C->>W: Terminate stalled reader
        Note over C: Other pending jobs become unavailable<br/>Late replies from retired worker are ignored
        W-->>C: Termination completes
        Note over C: Replacement is allowed only after retirement<br/>and the one-second cooldown
    end
```

If every caller aborts, the client sends cancellation but retains the physical slot and its watchdog until the worker replies or is terminated. Waiting for worker startup has a separate 10-second watchdog; a queued caller can hit its 1.5-second deadline without killing a worker that is still loading. Shutdown closes admission and awaits current and already-retiring workers before closing the dashboard database.

### One ping probe shared by health and liveness monitoring

```mermaid
sequenceDiagram
    autonumber
    participant H as Health caller
    participant M as Periodic monitor
    participant P as Coordinated ping service
    participant C as Local connection
    participant R as Remote peer
    H->>P: ping(peer)
    P->>C: Open one outbound ping stream
    C->>R: Send random challenge
    M->>P: Probe the same connection
    P->>P: Join compatible pending physical probe
    Note over P,C: Compatible callers and monitor ticks join<br/>Incompatible stream options wait for FIN or reset<br/>Outbound protocol stream limit stays at one
    alt Correct echo
        R-->>C: Echo challenge
        C-->>P: Received bytes
        P->>P: Validate echo; finish adaptive liveness measurement
        P->>C: Close local stream side
        alt Remote FIN within separate 5-second cleanup deadline
            R-->>C: Remote FIN closes the stream
            C-->>P: Close event releases protocol slot
        else Cleanup deadline or stream-close error
            P->>C: Reset only the ping stream
            C-->>P: Reset releases protocol slot
            P->>P: Log phase=cleanup, pongReceived=true
            Note over C,R: Connection remains open
        end
        P-->>H: RTT
        P-->>M: Liveness success
    else Peer does not support ping
        R-->>C: Protocol negotiation refusal
        C-->>P: UnsupportedProtocolError
        P-->>H: Reject UnsupportedProtocolError (no RTT)
        P-->>M: Peer responsiveness established
    else Bad echo, I/O failure or adaptive deadline before valid pong
        P->>C: Abort stream and abort connection if still open
        C-->>P: Close event with supplied cause
        P-->>H: Probe failure
        P-->>M: Probe failure observed
    end
```

Compatible callers share one probe; caller stream options that differ wait for the active probe to finish. Stream-opening progress is delivered to each observer, including callers that join later. Refusing a caller-excluded limited connection does not abort the connection. Health-caller cancellation detaches that observer; the probe continues only while another caller or the monitor owns it. Otherwise its stream is cancelled and reset without aborting the connection. Service shutdown cancels and drains probes, including post-pong cleanup, without using the ordinary failure path to abort connections. A connection closing during cleanup rejects the probe instead of returning stale success. The standard inbound ping responder remains installed. Only the independent built-in monitor is disabled; the replacement monitor still checks liveness every 10 seconds with the existing adaptive timeout behavior.

The adaptive 5–60-second deadline covers opening the stream and validating the echo. Its measurement ends immediately on a valid pong, so slow FIN handling cannot inflate the next liveness deadline. Cleanup has a separate fixed five-second budget and retains the coordinator's slot until FIN or stream reset. A cleanup-only failure preserves liveness; a silent peer or invalid echo still triggers connection teardown. Production diagnostics report connection/peer, phase (`open-stream`, `echo`, `cleanup`), action, deadline, elapsed time, whether a pong arrived, and bounded error details.

## Validation

The 25 September ping review follow-up passes all 39 focused ping cases and the full core suite (2,182 tests across 144 files) on Node 22.23.0. Core build/type checks, repository lint and the dial-protocol boundary audit pass. Before the fixes, the new regressions reproduced the unsupported-protocol false success and the orphaned ping timeout closing the connection. This validates the local ping changes; it is not a release rebase or a production soak.

Work began from freshly fetched `origin/testnet-canary` commit `24341ba73ab1f8a6f4330e34ae905bab725f0db6`; this remained the current base during validation. Tests use local fixtures and loopback peers.

The subsequent cleanup fix passed 34 focused core ping, coordinator, close-diagnostic and node-wiring tests on Node 22.23.1, plus the core build/type checks and repository lint. The freshly fetched canary remained at the same base. New real TCP/Noise/Yamux cases cover FIN arriving after the echo deadline, missing FIN with stream reset and subsequent queued probes, a throwing diagnostics sink, shutdown during cleanup and connection closure during cleanup. Existing silent-peer and bad-echo cases still require connection teardown. This validates the local failure mode, not its frequency on Luigi or production recovery.

The updated implementation has 431 passing focused tests on Node 22.23.1: chain 150, SQLite store 29, CLI worker/lifecycle/startup 217, core ping/diagnostics 29 and agent wiring 6. This review round reran all 402 affected chain/CLI/core/agent cases; the SQLite implementation is unchanged from its passing 29-test run. Package builds, type checks, package boundary checks and repository lint pass. Coverage includes indexed SQL selection and migration, finality, coverage, own-write hashes, replaced tails, tombstones, retired revisions and bindings, caller cancellation, queue limits, physical timeouts, worker startup/crash/recovery, startup cleanup and shutdown. Real TCP/Noise/Yamux tests reproduce and fix health/monitor and monitor/monitor collisions while also checking silent peers, delayed remote stream closure and reconnect behavior.

The first CI run exposed an additional diagnostics regression: metadata-only synthetic `connection:open` events have no per-connection `addEventListener`. The optional close diagnostics now check that capability before subscribing. The five affected agent suites pass locally with 218 tests and no unhandled connection errors.

Review coverage adds expected-result parity between inline and explicit snapshot evaluation, worker lifecycle races, and real-worker contention with 8,000 registrations. A test-only worker entry holds the first decode batch while point/cancellation messages are queued, then calls the same cooperative checkpoint as production. Production worker data and the request handler contain no test barrier or `Atomics.wait`. Both contention tests fail when the real checkpoint stops yielding; a separate actual-entry test fails if production wiring substitutes a no-op checkpoint. Restoring the yield and wiring makes all three tests pass. Handler tests use real SQLite and injected checkpoints to cover deterministic deadline/cancellation cases, while entry tests exercise the actual message-port wiring. These tests cover dispatch, deadlines, cancellation, bounded SQL and refusal behavior under Vitest coverage, which does not collect execution in the separately spawned worker. Coverage exclusions and required thresholds are unchanged.

Further regressions cover the legacy public runtime and agent APIs, list-only reader normalization with preserved method receivers, injected-factory preservation across Hub rotation, fixed dependency drain across concurrent closes, and explicit planning versus own-write evidence verification. Package builds compile negative type cases for contradictory ownership through strict configuration aliases, missing ordinal indices, mismatched results and incomplete served replies. A worker reply for the wrong operation is refused before cursor validation. The production node wiring test identifies the exact coordinated-ping factory; substituting stock ping makes that test fail.

Consumer interfaces extending the public agent, adapter and runtime options compile through the real constructors/factories; legacy runtime options retain a required store. Modern factories cannot omit the scalar port, and reader type checks reject commit/tombstone calls. Real read-only SQLite tests preserve a held snapshot across writer commits. Six inline interleaving cases cover binding/ordinal reads while revision, lineage or topic set changes; removing the final state load and generation check fails all six, and restoring it passes them.

The repeatable benchmark is:

```sh
node --expose-gc packages/cli/scripts/chain-index-read-worker-benchmark.mjs
```

Build the CLI and its workspace dependencies first. It generates temporary 35,963- and 359,630-row fixtures, measures cold/warm point reads and concurrent ordinal/point reads, polls a local HTTP endpoint and records event-loop delay. `CHAIN_INDEX_BENCH_CAPTURE` optionally supplies an existing SQLite-row JSONL capture; no capture is committed. `CHAIN_INDEX_BENCH_OUTPUT` writes JSON evidence.

An initial unbounded stress run aborted Node inside native SQLite row allocation despite the worker heap limit. The SQL row limit fixes that observed failure; the stress run is repeated after that change. Worker heap limits alone are not the containment mechanism.

Measured on Apple M3 with five fresh-worker samples and 100 warm/mixed point samples per fixture; filesystem caches were not flushed:

| Runtime | History | Warm point p99 | Mixed point success | Local HTTP maximum | Event-loop maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 22.23.1 | 35,963 captured rows | 3.19 ms | 100/100 | 3.18 ms | 11.31 ms |
| Node 22.23.1 | 359,630 generated rows | 2.39 ms | 100/100 | 1.79 ms | 11.20 ms |
| Node 25.2.1 | 35,963 captured rows | 2.42 ms | 100/100 | 3.41 ms | 11.32 ms |
| Node 25.2.1 | 359,630 generated rows | 2.51 ms | 100/100 | 0.86 ms | 10.95 ms |

Every point lookup selected one row. No historical arrays crossed the worker boundary; the largest response was 301 bytes. Cold reads completed within 370 ms in these runs. Concurrent oversized ordinal reads refused with `row-limit` and left point reads available; the benchmark records fallback without sending RPC. The Node 22 patch release tested here is 22.23.1, rather than the investigated production host's 22.23.0.

On the 359,630-row local database, direct index creation took 866 ms; reopening a compact database through the real initializer took 767 ms. The added index used 78.30 MiB and the row count was unchanged. A fragmented fixture took 7.19 seconds to reopen because the existing startup free-page policy also ran `VACUUM`. Account for database size, fragmentation and available disk space when planning startup; these timings are not production measurements.

## Deployment gate

Release matching CLI, core, chain, agent and node-ui package versions. Before production, run a staging publish/StorageACK/reconnect soak under comparable history and request pressure; inspect event-loop delay, RPC fallback rate, publish completion and close causes. Local latency tests do not replace this soak.

Confirm the available ACK quorum before restarting any core. With four Base cores and three required remote ACKs, taking one node down can prevent quorum even during a sequential rollout. Plan spare eligible capacity or an explicit maintenance window. Rollback is the previous package set; the additional SQLite index is compatible with the old reader.

The first EG Luigi pilot used commit `63645015`. A read-only check at 18:46 UTC on 24 September 2026 found 45 minutes of uptime, zero restarts, 20 peers and a reachable store, with StorageACK still registered. Timeout-triggered local connection closures and background store delays remained; the check did not establish fresh end-to-end publish/ACK success. The delayed-FIN defect was then reproduced locally with a correct echo, yielding the same generic local `TimeoutError`. The old diagnostics cannot establish that this was the phase responsible for Luigi's closures.

The cleanup fix requires another explicit deployment; the infrastructure pilot remains pinned to the earlier commit. For the next pilot:

1. Finish CI/review and staging publish, repair and reconnect validation with the packaged build. Exercise unsolved Random Sampling retries and observe at least two complete proof periods with active publishing.
2. Recheck live eligible ACK identities, peer reachability, disk headroom and node health. Arrange spare eligible capacity or a maintenance window if the restart would remove quorum. Capture the old package versions and a baseline on Luigi plus one unchanged comparison node.
3. Deploy one coherent package set to Luigi only and confirm index migration, reader startup, API responsiveness and peer recovery. Measure per-thread CPU, event-loop delay, RSS, disk/WAL growth, lookup durations, worker timeouts/restarts, RPC fallbacks and connection close causes.
4. Require completed publish transactions with the required distinct StorageACK identities and successful repair/challenge progression; also exercise reconnects. Observe at least two complete proof periods under representative activity, extending the soak if the original symptom has not been exercised.
5. Roll back the package set on incorrect bindings/ordinals, repeated worker failures, resource growth, increased local disconnects or publish/ACK regressions. Preserve raw history and the additive index. Expand only after the pilot meets the application-level checks.

The new reader diagnostics are throttled warning lines, not continuous latency or fallback-rate histograms. Collect the pilot's latency distributions and rates separately; lack of warning lines is insufficient evidence of health. The 1.5-second reader deadline is a local-read budget and does not promise a 1.5-second end-to-end RPC/API response.

A patched node can prevent its own ping collisions, while an unpatched peer can still close the other end. Interpret remote-initiated closures separately; one healthy pilot cannot establish fleet-wide stability or settle the original overload's cause.
