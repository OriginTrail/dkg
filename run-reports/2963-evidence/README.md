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

`candidate/` contains the same complete evidence set for the first candidate at `7dfc334200bb2a716e7dc11cf25ec7a033cd9481`: 2/2 automatic recoveries, 436/436 exact catalog entries and descriptors, with higher publication latency in this pair. Both arms use the corrected whole-graph content audit. Final review-fixed runtime and actual restart evidence are still pending. No manual repair counts as automatic recovery.


`baseline3/` contains the same full evidence set for clean merged base `2aba84de35754e5663b52018f9781a6e6c8b948d`: 0/2 automatic recoveries, exactly 434/436 catalog entries and descriptors, 48/48 publications, all original content/identities preserved and all 98 transactions accounted for. It is the baseline for the final review-fixed candidate, not a replacement for the original pair.
