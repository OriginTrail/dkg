# Evidence stream contract (schema_version 1)

Append-only `runs/<run_id>.jsonl`. Every record carries:

```json
{ "type": "<record type>", "schema_version": 1, "ts": "<ISO 8601>", "run_id": "<id>" }
```

Run IDs: `<phase>-<sha8>[-qualifier][-rN]-<ISO basic timestamp>`, e.g.
`certify-06419722-r1-20260714T190000Z`. Never reuse a run_id; verdicts are never
overwritten.

Hygiene (RFC-61 §4.4/S6): cores appear ONLY by `fleet.json` alias. No hostnames,
IPs, usernames, key paths, or wallet addresses in any record. Raw matched log
text goes to a local sidecar (`runs/<run_id>.sidecar.jsonl`, gitignored with the
rest of runs/), never the main stream. The manifest records the fleet.json
sha256 digest, not its content.

## Record types (Phase 0 set)

| type | emitted | payload (beyond envelope) |
| --- | --- | --- |
| `run_start` | once | mode, scenario name+sha256, fleet digest, policy digest, harness version, argv (sanitized) |
| `preflight` | once | outcome (`ok`\|`inconclusive`), checks: [{id, pass, evidence}], edges attested {commit, apiPort-alias}, cores attested {alias, commit, buildTime, workerPid, workerStartTs} |
| `fleet_baseline` | once | per-core full snapshot + journalCursor |
| `fleet_snapshot` | loop | kind (`light`\|`full`), per-core: alias, reachable, systemd {activeState, execMainStartTs, nRestarts, mainPid}, workerPid, build {commit, buildTime}, rss, cgroup {memoryCurrent, memoryPeak, memoryHigh, memoryMax, oomKills, psiSomeAvg10}, listen {recvQ, backlog, connectProbeOk}, diskFree {bytes, fraction}, api {admissionRejected, rpcFailovers, rpcExhaustions} |
| `host_telemetry` | loop | loadavg, cpuFraction, memFreeBytes, note (driver laptop, §3.2) |
| `op_result` | per op | op, lane, cg (logical name), index, wave, bytes, outcome (`success`\|failure class), reason, durations_ms {create, share, publish, vm_finalization}, anchor_meta {poll_interval_ms}, ual, tx, control_fixture, recovered_after_client_error |
| `readback_result` | per wave | lane, expected, matched, mismatches: [{index, kind}], byteExact |
| `journal_signature_deltas` | baseline→final | per-core: alias, cursorValid, counts by class id, gatedTotal, recordedTotal, ledgerVersion |
| `soak_start` / `soak_end` | certify | soakSeconds |
| `safety_abort` | on trip | trip id, observed, threshold, quiesce {cancelled, edgeShutdown, flatConfirmed} |
| `run_verdict` | once | outcome (`PASS`\|`FAIL`\|`INCONCLUSIVE`\|`SAFETY_ABORT`), gates: [{id, outcome, observed, threshold, evidencePointer}], notRun: [] |
| `run_manifest` | once | attested identities, scenario verbatim, gate outcomes, notRun list, spend {trac, eth}, permanentBytesWritten |

Phase 1 adds: `propagation_result`, `sse_gap`, `faucet_draw`, `goal_verdict`
(reserved — do not repurpose).

## Failure classes (closed enum, §6)

`too_low_allowance`, `publisher_wedge`, `transport_error`, `quorum_or_backoff`,
`admission_shed`, `rpc_exhaustion`, `timeout`, `readback_mismatch`,
`query_result_mismatch`, `propagation_timeout`, `arrived_during_gap`,
`finalized_unverified`, `caught_up_unverified`, `aborted`, `error:<class>`.

Unclassified failures MUST throw, not fold into a bucket.
