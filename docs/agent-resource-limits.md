# Sync and VM resource configuration

Numeric resource settings must be safe integers within the ranges below. Absent
or blank environment values are unset. Invalid environment values fall through
to valid config, then existing defaults; invalid numeric config leaves use their
existing defaults. Structural config errors and contradictory sync partition
allocations still fail validation. Values above a ceiling are rejected, not
rounded or saturated. Existing values inside each range retain their behavior.

These are defensive ceilings, not recommended sizing or a promise that every
machine can support the maximum. Operators should size below them for their
available memory, peers, RPC provider, and store. The defaults are unchanged.
The implementation owns these values in `packages/agent/src/resource-limits.ts`.

| Setting | Accepted range | Reason for ceiling |
| --- | --- | --- |
| Sync global/partition inflight and reserved slots | 0–1,024 | Bound concurrent work and retained admission state |
| Sync global/partition queue capacities | 0–65,536 | Bound retained callbacks; the sum of partition queues is also globally capped |
| Sync partition queue timeout, reconciler interval/staleness/backoff; VM interval/backoff/startup delay | Up to 2,147,483,647 ms | Node's maximum timer delay; larger delays can become 1 ms loops |
| VM CG and ordinal concurrency | 1–32 each | Their product is at most 1,024 concurrent ordinal workers |
| Catch-up peer concurrency | 1–1,024 | Bound peer traversal concurrency |
| VM batch size and foreground burst | 1–1,000 | Bound work per scheduling turn |
| VM pending queue | 1–65,536 | Bound retained context-graph jobs |
| VM cache and CG state entries | 1–100,000 | Bound retained negative results and cursors |
| VM SWM-generation fingerprint rows | 1–10,000,000 | Bound fingerprint materialization |
| VM, random sampling and core host recording shutdown deadlines | 1–300,000 ms | Bound process shutdown to at most five minutes per owner |
| VM confirmation depth | 1–1,000,000 blocks | Bound the operator-controlled observation window |
| Catch-up backpressure wait and SWM catch-up pass budget | 0–86,400,000 ms | Bound the configured waiting/continuation window to one day |
| SWM catch-up pass count | 1–1,000 | Bound repeated peer traversal |
| Sync responder global/per-snapshot rows | 1–10,000,000 | Bound retained snapshot cardinality |
| Sync responder global/per-snapshot estimated bytes | 1–4,294,967,296 | Bound the shared snapshot memory budget to 4 GiB |

Positive timers have minimum 1. The existing zero modes remain explicit:
sync-global inflight `0` disables that limiter, queue `0` disables queueing,
partition timeout `0` preserves the existing no-timeout setting, VM startup delay
`0` starts immediately, and catch-up wait/pass budget `0` disables retries/extra
passes. A disabled sync-global limiter is represented as `null` in the legacy
pressure snapshot and `0` in W1 capacity, as before.

The startup log emits at most one combined resource-configuration warning,
capped at 4,096 characters, containing setting names and safe fallback/clamp
information. It never includes the rejected values. Repeated admission or status
reads do not log configuration warnings. VM/catch-up static settings and their
rejection names share one immutable import-time snapshot; restart the process to
change them. SWM pass configuration continues to resolve at each job boundary.
The `Resolved sync policy` startup record includes the effective VM limits,
reconciler timing, snapshot budgets, and admission limits. Legacy sync status and
W1 use the executable resolved admission policy, including fallback values.

Existing independently bounded controls remain in their owners: RS-heal limits
clamp to 64 items and 10,000 CG cursors; exact-recovery peer/roster counts use fixed
protocol caps. Sync priority is a signed safe integer used only for ordering, and
jitter is a finite fraction in [0,1], so neither is an allocation count. Wire
ordinals and store row counts are protocol/data validation, not resource config.
