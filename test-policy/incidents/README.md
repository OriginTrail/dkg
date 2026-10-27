# Incident closure after 10.0.26

This extends the historical regression register without changing its two proven
historical-replay profiles. `release-10.0.26.json` records five incidents, their
classification, exact detector and required lane. Detector `suite`/`title` fields
use the historical registry’s shared name derivation; discovery and proof reports
must match the resulting identities exactly. `detector-proven` means the
stated component invariant has red/green evidence. It does not mean every
reported symptom is explained or that a network release campaign passed.

The incident loader includes every top-level `release-*.json` file in this
directory, in filename order. Keep incident IDs unique across those files;
nested proof reports are not registers. New releases require data additions
without edits to inventory or status commands.

Run `pnpm qa:check-regressions` to regenerate the inventory and validate both
registers. `pnpm qa:incident-status` prints the validated incident status using
that inventory. Validation discovers actual Vitest test names, rejects disabled
or focused detectors, requires their required CI route and verifies proof bytes. Historical and
incident detectors share source, exact-name, inventory and unit-shard eligibility;
historical replay and guard-mutation evidence retain separate validators.
Changing the production guard or selected test invalidates the mutation proof.

Three actual guard mutations were run on Node 22.23.4 / pnpm 10.28.1:

- GH-3502: suppress the replay-to-notifier callback. The real loopback replay and
  notice test fails its fresh-pull assertion; restoring the callback passes.
  Ownership and the expensive data pull are controlled. This is a retained
  wiring detector, not the original complete relay/devnet RDF probe.
- GH-3475: suppress the connect-time profile follow-up. The second durable pull
  is absent and the test fails. Restoring the scheduling call passes.
- GH-3467: remove the non-core peer reserve. The ninth, edge author is absent
  from the first window and the independent author-presence assertion fails.
  Its whole test file now runs in the required unit route, without Hardhat.

`evidence/<id>/receipt.json` contains the exact production substitution, source
commit, source/test hashes, selected full test name and hashes of both observed
reports. Each report retains the executed assertion, exit code, command and raw
report hash; failure paths are normalized to `<checkout>`. These are mutation
proofs, not assertions that an old release was executed. The existing
`qa:prove-regression` command still exclusively runs historical-replay profiles.

To refresh a mutation proof, use an isolated checkout with dependencies built,
apply exactly the receipt's single substitution, and run the recorded command
with a new report path. Require exactly the named assertion to fail with an
AssertionError; compilation, import errors, skipped tests and timeout are not
proof. Restore the original bytes in a finally block and run the same command
again, requiring success. Keep both reports and update all hashes in the receipt
and register for review. Never run mutations concurrently with another test run
or agent editing the same checkout.

GH-3421 remains open here because its composite relay/membership journey lacks
retained old/new evidence. GH-3408 remains open because the original stall's root
cause is unknown. Neither is silently called a proven regression or closed by a
nearby passing test. The full forced-order named-RDF restart journey, cold member
campaign and broad peer-window network campaign remain release qualification
work alongside these faster detectors.

## Earlier feedback

`pnpm qa:boundary-checks --base <review-base>` runs the small agent checks for
changed startup, networking, seed selection, schema and dependency paths.
`--list` prints the selection without execution. It does not replace or narrow
required CI; routing tests retain the authoritative agent lane. Harness verdict
changes continue to run the complete inexpensive harness unit suite.

`pnpm lint:tests` rejects direct assertions inside try blocks whose catch does
not throw. Assertion observations should leave the tolerant catch before being
checked. Conservative scanning does not claim to prove arbitrary control flow.
Aggregate comparison uses `isDeepStrictEqual` and checks the accumulated
mismatches afterward. HTTP handler assertions now escape into the test body.

The five pure devnet manifest/parser files run in the required build gate via
`pnpm test:devnet:manifest`; their inventory points to that executable config.
The reusable Windows gate scopes concurrency to the caller run and attempt.
The parent CI workflow still cancels superseded branch/PR runs, while ordinary
CI can no longer cancel an independent nightly's Windows evidence.
