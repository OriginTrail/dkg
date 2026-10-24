# DKG 10.0.14 distributed 500-asset release run

## Summary

The release run completed the full Shared Memory cohort and synchronized every
published asset to two remote Edge nodes. The Verifiable Memory cohort published
497 of 500 planned assets. The harness therefore closed the run as
`INCONCLUSIVE`, with reason `insufficient-publishes`. The operator accepted this
result as release evidence with a documented waiver. It must not be described as
a strict 500/500 pass.

## Tested revisions

| Component | Revision |
| --- | --- |
| DKG | `c7afca89baa58f101738c37ff774b63211123ca4` |
| Blackbox harness | `f79c2d887845841816d46f20cd4c2b3bbace0bdb` |
| Run | `open-20260824-0e360` |

The DKG revision is the merge commit for OriginTrail/dkg#2310 on
`testnet-canary`. The harness revision is on the
`OriginTrail/dkg-blackbox-harness` main branch.

## Topology and result

The source and both remote participants ran as Edge nodes. The two admitted
remote participants were Branimir's macOS node and Jurij's WSL node.

| Cohort | Source published | Branimir synchronized | Jurij synchronized |
| --- | ---: | ---: | ---: |
| Shared Memory | 500/500 | 500/500 | 500/500 |
| Verifiable Memory | 497/500 | 497/497 published | 497/497 published |

Both receivers had zero missing, mismatched, excluded, pending, or relabelled
eligible pairs. All three evidence chains were contiguous and matched the
declared plan. The observed source sealing rates were 18.50 Shared Memory assets
per minute and 28.97 Verifiable Memory assets per minute, measured from the first
to the last sealed asset in each cohort.

## Unresolved VM cases

- VM ordinal 426 completed create and Shared Memory share, then failed the VM
  lift during publisher validation with `canonicalization_failed`. It was
  non-retryable and no transaction or nonce was created.
- VM ordinal 922 failed in the same way: create and Shared Memory share
  completed, then VM lift canonicalization failed before transaction submission.
- VM ordinal 918 finalized its VM lift, but the harness could not resolve a
  Verifiable Memory assertion graph. The strict grader recorded
  `NO_ASSERTION_GRAPH` and did not seal the asset.

These cases produced 497/500 published VM assets. The receivers synchronized all
497 published VM assets, so the run found no receiver convergence defect.

## Evidence integrity

The full evidence remains in the release operator's preserved run directory.
Only aggregate facts are recorded in this report.

| Artifact | SHA-256 |
| --- | --- |
| `verdict.json` | `2e9287bf4bc0c94ffe53d3323a7d7a644fcb466400534e8bc53471334ab58a24` |
| Curator fact chain | `eebcc373d87713b77cb9f2135d5d2c9fd3fec75a6938880c4ffae16f8bc4f235` |

No authentication material, wallet material, transactions, publisher bodies, or
raw API envelopes are included in this report.
