# DKG Testnet Harness

Implementation of **OT-RFC-61** (dkgv10-spec PR #141): goal-driven functional and
performance certification of the DKG against the live Base-Sepolia testnet.
This workspace is **Phase 0** of the RFC's rollout — the generalization of the
OT-RFC-59 certification harness (`harness.mjs`, single-file) into a modular,
fleet-configurable tool — plus the scenario/measurement scaffolding Phase 1
builds on.

Zero runtime dependencies (Node ≥ 20 built-ins only, ESM). No build step:
runs straight from a laptop without installing or compiling the monorepo.
Tests use `node --test`.

## Quickstart

```bash
cp testnet/fleet.example.json  testnet/fleet.json    # fill in your fleet (gitignored)
cp testnet/policy.example.json testnet/policy.json   # operator safety policy (gitignored)

node testnet/bin/harness.mjs selftest                # offline: unit tests + config validation
node testnet/bin/harness.mjs monitor                 # read-only fleet snapshot (safe, no load)
node testnet/bin/harness.mjs baseline                # snapshot + journal cursors, no load
node testnet/bin/harness.mjs certify --scenario certify-100   # scored run (interactive only)
```

## Modes and safety

| Mode | Load? | Fleet access | Notes |
| --- | --- | --- | --- |
| `selftest` | no | none | unit tests + validates fleet/policy/scenario files |
| `monitor` | no | read-only | light snapshots on a loop; safe anytime |
| `baseline` | no | read-only | full snapshot + journal cursor capture |
| `certify` | YES | read-only | scored workload through the LOCAL edge; S3 watch active |

Per RFC-61 §8 S2, fleet access is observation-only. `--autonomous` runs refuse
to start unless credential isolation is verified (forced-command key, no agent
socket); interactive operator runs (the default) may use an operator key but
still never mutate fleet hosts. S3 abort trips come from `policy.json`
(defaults + hard maxima in `policy.example.json`); scenarios may only tighten
them; a missing watch signal fails closed. A tripped run quiesces in-flight
work and ends as terminal `SAFETY_ABORT`.

## Layout

```
bin/harness.mjs      CLI entry: mode dispatch, run lifecycle (preflight → baseline → workload → soak → verdict)
lib/util.mjs         waitFor, fetchRetry, percentile (nearest-rank), parseLastJsonBlock, term normalizers
lib/config.mjs       fleet.json / policy.json / scenario loading + validation, S2 credential check
lib/evidence.mjs     append-only JSONL evidence stream (ts + run_id + schema_version), run manifest
lib/ssh.mjs          bounded-concurrency SSH exec, k=v snapshot parsing (base64 values)
lib/fleet.mjs        light/full fleet snapshots, build-identity attestation, journal cursors + signature ledger
lib/edge.mjs         local edge daemon client (status, KA lifecycle, jobs, query, catchup, SSE), CLI runner
lib/scoring.mjs      outcomes, failure enum, aggregates + coverage gates, verdict builder
lib/watch.mjs        S3 abort-trip evaluation + quiesce controller
lib/scenario.mjs     scenario schema + runner; scenarios/certify-100.json is scenario #1
ledger.json          versioned forbidden-signature classes (gated vs recorded)
schema/EVIDENCE.md   evidence record types + schema_version contract
scenarios.json       scenario manifest (drift-guarded against scenarios/ by test)
```

## Provenance

- Spec: `dkgv10-spec/rfcs/OT-RFC-61-testnet-harness.md` (PR #141)
- Generalizes: the OT-RFC-59 certification harness (single-file `harness.mjs`)
- Ports devnet `_bootstrap` primitives: `waitFor`, `fetchRetry`,
  `parseLastJsonBlock`, SPARQL term normalizers, suite-manifest drift guard.

Phase 0 exit gate: the RFC-59 certify workload (2 waves × (25 public + 25
private) KAs at concurrency 2, byte-exact readback, 600 s soak, gate battery)
reproduces under this tool. Phase 1 (observer edge, propagation anchors, full
op matrix) extends `lib/scenario.mjs` + `lib/edge.mjs` without structural change.
