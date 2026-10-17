# Reviewer evidence for #2963

See the [self-contained report](../2026-10-16-2963-share-recovery.md) for interpretation, runtime, exact revisions, deadlines and limitations. Raw node homes, wallet/API/claim secrets and node logs remain private. These files are generated from an explicit public-field allowlist by `scripts/testnet-share-recovery/reviewer-evidence.py`.

- `baseline2/summary.json`: fixed-deadline outcome and exact catalog identity errors.
- `baseline2/requests.csv`: all 48 publication and 256 synchronous share requests, including both failures.
- `baseline2/assets.json`, `seals.json`, `catalog-identities.json`: all original asset identities, content checks, lifecycle outcomes and catalog coverage.
- `baseline2/fault-*.json`, `fault-identity-proof.json`: selected failure boundary, captured partial commit and exact identity/content preservation.
- `baseline2/recovery-descriptor-probes.json`, `recovery-times.json`: all recovery probes, including unavailable descriptors and absent recovery owners.
- `baseline2/observations.json`, `publication-timing.json`, `publication-deadline.json`: catalog convergence observations and full publication timing/deadline denominator.
- `baseline2/chain-events.json`, `nonce-accounting.json`: decoded creation events and all signer transactions in the run's nonce intervals.
- `baseline2/environment.json`, `protocol.json`, `traffic-end.json`: reproducible setup and fixed observation bounds.
- `invalid-attempt/`: retained request denominator and correctness evidence from the readiness-invalid first attempt; excluded from the controlled performance comparison.

`candidate/` contains the same complete evidence set for the first candidate at `7dfc334200bb2a716e7dc11cf25ec7a033cd9481`: 2/2 automatic recoveries, 436/436 exact catalog entries and descriptors, with higher publication latency in this pair. Both arms use the corrected whole-graph content audit. The latest review-fixed matched pair is in `baseline3/` and `candidate10/`; actual process-exit evidence is reported separately below. No manual repair counts as automatic recovery.


`baseline3/` contains the same full evidence set for clean merged base `2aba84de35754e5663b52018f9781a6e6c8b948d`: 0/2 automatic recoveries, exactly 434/436 catalog entries and descriptors, 48/48 publications, all original content/identities preserved and all 98 transactions accounted for. It is the baseline for the final review-fixed candidate, not a replacement for the original pair.

`candidate2-preparation-only/` through `candidate8-preparation-only/` preserve superseded startup/preparation outcomes separately. Each records one natural startup 503 and its original automatic recovery, exact preparation denominators, zero measured publications, settled nonce accounting and owned-process shutdown. None is a performance sample or a replacement for the final matched candidate.


`candidate9/` preserves the preceding completed runtime at `f7fdbdfaedc9bb3b8e1ff2307ec50a856d4010e7`: all 304 requests, 2/2 automatic injected recoveries, exact 436/436 catalog/inventory/descriptors, all seals/content/publication effects preserved and the full 98-transaction interval without gaps. `deadline-observations.json` retains observations after early convergence through the fixed observation window. `startup-recovery.json` preserves its separate one-request natural preparation failure. `local-validation.json` records final native regression batches without summing overlapping suites. `independent-proof-assertions.json` records explicit checks of the generated proof values.

The separate `candidate9/restart-regression/` evidence records the successful actual process-exit scenario and all 79 observations through its fixed 20-minute deadline. The worker completed the original job after the unchanged lease, and exact readback verified 437 identities with unchanged content and publication/nonce effects. It must be read independently from the 256-share denominator. Raw queue records containing internal claim capabilities are excluded. The normal 900000 ms lease is never edited, and OS exit status is not claimed: the read-only witness observes process disappearance and automatic supervisor replacement.

`candidate10/` contains the latest matched runtime `a76cb38a5aacf2261d888c69c7e2abd5dbb0878c`: all 304 requests, 2/2 automatic injected recoveries, exact 436/436 identities/descriptors, unchanged seals/content/publication effects and 98 accounted transactions. Its full-deadline observations, one-request startup failure, local validation and explicit proof assertions are preserved separately. `candidate10/restart-regression/` contains the successful actual process-exit proof, all 79 observations, unchanged 15-minute lease, original-job completion and exact 437-identity readback with unchanged content/publication/nonces. One startup read failure is retained. Cleanup and matching claim release are recorded separately.

`baseline4/` is the new optimized baseline at `e3d134dd7c5fef1b479362bcc91a9de620b31277`: 48/48 finalized publications, 254 natural successful shares, two injected 503s without owners/recovery, exactly 434/436 catalog entries and descriptors, and 98 accounted transactions. Its fixed window and post-shutdown reconciliation are preserved. Candidate11 remains pending. All six completed arms now include immutable manifest imports labelled historical provenance; main lifecycle checks use the authoritative graph and historical restart metadata/payloads were revalidated without changing their original observation timestamps.
