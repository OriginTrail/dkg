#!/usr/bin/env node
// OT-RFC-61 testnet harness CLI — mode dispatch + run lifecycle (§4.1).
// CONTRACT FILE: implementors replace TODO bodies; flags are frozen:
//   harness.mjs <selftest|monitor|baseline|certify> [--scenario <name>]
//     [--fleet <path>] [--policy <path>] [--run-id <id>] [--runs-dir <path>]
//     [--interval <sec>] [--once] [--autonomous] [--json]
//
// Lifecycle (certify): safetyAbortGate → load config/policy/scenario →
// (autonomous ? verifyCredentialIsolation : record interactive) → preflight
// (edges healthy incl. driver /api/status commit attestation; FULL fleet
// reachable+observable — degraded ⇒ INCONCLUSIVE + workload NOT_RUN (§3.3);
// wallets funded; CGs visible) → fleet_baseline + cursors + attestation →
// runPublishScenario → buildGates → computeVerdict (SAFETY_ABORT terminal) →
// run_manifest + run_verdict + verdict.json next to the evidence file →
// exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE, 3 SAFETY_ABORT, 4 usage/config.
//
// monitor: light snapshot loop (--interval, default 10 s; --once for a single
// pass) printing a fixed-width fleet table (alias, state, commit, rss, mem%,
// recvq, disk, restarts) and writing fleet_snapshot records when --run-id given.
// baseline: one full snapshot + cursors + attestation, written as evidence.
// selftest: node --test test/ + validate fleet/policy/scenarios if present.

async function main() { throw new Error('TODO'); }

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(4); });
