# OT-RFC-61 Testnet Harness — Phase 0 Status

Integration status as of 2026-07-14. Zero-dependency (node: builtins only), no build step.
Node >= 20 required; verified on v22.16.0.

## Test state

`node --test` (from this directory): **194 tests, 194 pass, 0 fail** across 10 suites
(config 34 + manifest-drift 4, edge 16, evidence + util 43, fleet + ssh 46, scenario 9,
scoring + watch 42). All suites are hermetic — no real SSH, no external network,
no fleet required. `node --check` clean on every `.mjs` under `lib/`, `bin/`, `test/`.

Note: never invoke the runner as `node --test test/` — on Node >= 22.16 a directory
positional is spawned as an entry module and fails. Use bare `node --test` (what
`npm test` and `harness.mjs selftest` do).

## Modules

- **lib/util.mjs** — percentile (nearest-rank, rfc59 parity), parseLastJsonBlock,
  normTerm (canonical devnet dialect: structured uri/bnode → `<iri>`/`_:b`),
  bindingSetDigest, sha256, fetchRetry (transient-network-only), waitFor,
  seededRandom/fnv1a, isoBasic, promiseWithTimeout, sleep.
- **lib/evidence.mjs** — EvidenceWriter (append-only JSONL, envelope injection, S6
  hygiene deep-scan throws on host/ip/sshUser/sshIdentity at any depth; raw material
  only via writeSidecar), makeRunId, buildManifest, FAILURE_CLASSES closed enum.
- **lib/config.mjs** — loadFleet/loadPolicy/loadScenario (collect-all-problems errors,
  sha256 file digests), tighten-only S3 enforcement for scenario trip overrides
  (POLICY_TRIPS direction table), verifyCredentialIsolation (S2: interactive pass-through;
  autonomous = no-agent, identity-only, per-core sudo-refused + no-verbatim-exec probes,
  fail-closed on transport errors).
- **lib/ssh.mjs** — sshExec (BatchMode, accept-new, `--` separator, retry on exit-255
  only, per-attempt SIGKILL timeout, never rejects), mapLimit, parseKvOutput (b64-aware),
  snapshotCommand (single read-only compound), unitFullName.
- **lib/fleet.mjs** — snapshotCore/snapshotFleet (SSH k=v + public /api/status; reachable
  = both transports; S6 scrubbing of error strings), attestBuildIdentity/sameArtifact
  (§3.1 commit+pid+start-ts binding), captureJournalCursors, journalSignatureDeltas
  (awk single pass after cursor; vacuumed cursor ⇒ cursorValid:false, totals null —
  never silent zeroes; raw matched lines to sidecar only), loadLedger/validateLedger.
- **lib/edge.mjs** — EdgeClient over the verified daemon routes (create KA, share-async
  + share-job poll, vm/publish-async + publisher-job poll, KA state, query, catchup,
  SSE events with gap tracking), makePayload (rfc59 byte-parity fixtures), verifyReadback
  (chunked VALUES, normalizes via util.normTerm), parseNquads, runCli (never rejects,
  16k tail-truncate), resolveEdgeToken.
- **lib/scoring.mjs** — classifyFailure (closed enum, throws on unknown), aggregate
  ('aborted' excluded from success-rate denominator), evaluateGate (coverage gates
  mandatory, fail-closed INCONCLUSIVE), computeVerdict, formatVerdict.
- **lib/watch.mjs** — evaluateTrips (all S3 trips, fail-closed 'signal-unavailable',
  PSI sustain window, sticky unreachability), quiesce (cancel inflight → stop edges →
  flat-counter confirm; never touches fleet hosts), recordSafetyAbort/safetyAbortGate
  (cooldown file, corrupt ⇒ blocked).
- **lib/scenario.mjs** — runPublishScenario (lane bursts at per-lane concurrency, §6
  recovery re-scoring via authoritative KA state, live snapshot/trip loop, soak,
  final full snapshot + journal deltas even on abort), mergePeak, buildGates,
  pollVmFinalized.
- **bin/harness.mjs** — modes selftest | monitor | baseline | certify; exit codes
  0 PASS, 1 FAIL, 2 INCONCLUSIVE, 3 SAFETY_ABORT (or blocked cooldown), 4 usage/config.
- **ledger.json** — version 1, 12 signature classes (6 gated, 6 recorded), awk/JS
  parity tested against fixtures/journal-sample.txt.

## Commands

```sh
cd testnet

# self-check: unit tests + validate policy/fleet/scenarios (examples as fallback)
node bin/harness.mjs selftest

# live fleet table every 10 s (Ctrl-C to stop); --once for a single pass;
# add --run-id <id> to also write fleet_snapshot evidence
node bin/harness.mjs monitor --interval 10
node bin/harness.mjs monitor --once

# one full snapshot + journal cursors + build attestation, written as evidence
node bin/harness.mjs baseline

# certify run (fleet.json + policy.json required; scenario default certify-100)
node bin/harness.mjs certify --scenario certify-100
node bin/harness.mjs certify --scenario certify-100 --autonomous --json

npm test   # = node --test
```

Evidence lands in `runs/<run_id>.jsonl` (+ `.sidecar.jsonl` for raw local-only
material); certify also writes `runs/<run_id>.verdict.json`. A SAFETY_ABORT writes
`runs/safety-abort.json` and blocks new certify runs until the cooldown passes or
the operator deletes the file.

## Known gaps / TODOs

- **Preflight wallet + CG checks are skipped** (Phase 0): `wallets_funded` and
  `context_graphs_visible` are recorded as `pass: 'skipped'` with TODO evidence and
  listed in `notRun` (S4 wallet/faucet and CG-visibility preflights unimplemented).
- **run_verdict gate entries carry an inline `evidence` object**, not the
  `evidencePointer` name in schema/EVIDENCE.md — scoring.evaluateGate's frozen return
  uses `evidence`; documented deviation, revisit when a pointer scheme exists.
- If `ledger.json` is removed, gated-signature gates score INCONCLUSIVE
  (`ledger_unavailable`, totals null) — honest, never silent zeroes.
- Phase 1 record types (`propagation_result`, `sse_gap`, `faucet_draw`,
  `goal_verdict`) are reserved and not emitted.
- Autonomous credential-isolation probes need a real reachable fleet; they are
  fail-closed on any SSH transport error.
- End-to-end certify against a live fleet has not been run yet — everything above is
  verified by hermetic tests only.

## Integration fixes applied (2026-07-14)

1. `package.json` test script: `node --test test/` → `node --test` (directory
   positional breaks on Node >= 22.16).
2. `bin/harness.mjs` cmdSelftest spawned the same broken form (`node --test <dir>`);
   now bare `--test` with cwd at the package root.
3. Duplicate-logic sweep: deleted `edge.mjs`'s inlined devnet `normTermFallback` +
   `normTermSafe` shim (dead once util.mjs landed); `verifyReadback` now defaults to
   `util.mjs normTerm`. The edge test vector suite was retargeted to util's normTerm
   (structured uri cell now canonicalizes to `<urn:x>` — dialect change is intentional
   and tolerated by verifyReadback's unwrapIri).
4. `scenario.mjs` ledger-unavailable signature deltas now emit `gatedTotal`/
   `recordedTotal` `null` (was `0`) + `ledgerVersion: null`, matching
   `fleet.journalSignatureDeltas`' never-silent-zeroes discipline.
