# Testing policy and implementation record

This implements the six workstreams approved after the September 5, 2026 audit: coverage, reachability/gates, generated tests, real processes/backends, mutation testing, and removal of weak duplication/resource checks. Assertion quality and reporting changes apply across these workstreams.

The starting point is `testnet-canary` at `580a3607f532f561c8aa7c5f8aab316e418c89fe`, whose source tree matched `main` at `244f6943fe7a909a23fe3671c9da088de942f8ed`. These are local validation results, not a claim that a GitHub run or a distributed certification campaign has passed.

## 1. Coverage measures production source

All 22 Vitest runtime packages use `coverageForPackage` from `vitest.coverage.ts`. Coverage includes production JavaScript/TypeScript under `src` and, for Prime Agent, `extension/src`. Tests, declarations, JSON, generated output, and test helpers do not count. `check-coverage.mjs` independently compares the report with executable source, rejects missing or unexpected files, requires LCOV, and enforces the checked-in policy. A pure type module may emit no executable code; a runtime barrel may not silently disappear.

`coverage-baselines.json` records measured percentages separately from enforced floors. Each whole-package floor starts at the measured percentage rounded down, minus one percentage point for platform variability; existing floors are retained where the expanded source scope still meets them. This is a regression budget, not an acceptable long-term coverage target. Changes to these values require a reviewed policy edit; the test command never rewrites them.

The full denominator exposes previously omitted source. In particular, Graph Viz measures about 24% line coverage and Network Sim about 9%. Existing covered Graph Viz files retain individual floors, and Network Sim retains its former engine floor. Core branch/statement floors are rebaselined against all production source; its existing line floor is retained. These denominator corrections must not be described as newly introduced product regressions or as improved test coverage.

PR and merge-queue reports also require 90% of changed executable lines in agent, chain, core, publisher, storage, random-sampling and RDF Utils; other runtime packages require 80%. Branch/function/statement coverage remains subject to whole-package floors. There is no invented changed-branch percentage.

Commands:

```sh
pnpm run build:runtime:packages
pnpm --dir packages/core test:coverage
node scripts/ci/check-coverage.mjs core --base BASE_COMMIT
pnpm test:coverage
```

The root command is intentionally expensive: Turbo visits each package, including the separate Solidity suite. Coverage tasks do not reuse cached reports. Python prerequisites must be installed before the Hermes coverage command.

CI collects coverage during existing Vitest executions. Individual shards temporarily disable aggregate thresholds; the required `coverage-results` job verifies exact package/shard membership, revision, source/config/lockfile fingerprints and nonempty evidence, merges Istanbul hit maps, then enforces source scope and floors. It does not average shard percentages. Missing, stale, duplicate or failed shards cannot produce a passing coverage verdict. Two real RDF Utils shards were checked locally against the unsharded report and produced identical totals.

Vitest percentages measure instrumented test-worker execution. Code exercised only in separately spawned daemons is still in the source denominator, but those child-process hits are not merged into this V8 report; the process tests provide separate behavioral evidence.

Python coverage is separate. Hermes instruments the complete `hermes-plugin` source tree, including nested and unimported modules, emits JSON/XML and JUnit, and fails if prerequisites or a source file are missing. Pytest-only coverage rose from 29.33% to 34.45% after adding CLI contract cases; the CLI file measures about 98%. Floors are 34% overall and 97% for CLI. Python executions embedded in the TypeScript suite are not included in this pytest measurement.

Solidity retains its independent coverage tool, floors and instrumentation exclusions. `Identity.sol` remains functionally tested despite its coverage instrumentation limitation.

## 2. Test execution has an explicit route

`pnpm test:inventory` asks each real Vitest configuration to list its tests, parses the dedicated EVM runner, and accounts for other systems in `test-routes.json`. The output, `test-inventory.json`, lists maintenance surface, layer, command, cadence and prerequisites. A maintenance surface is a package/tool directory, not an invented human owner assignment. Newly orphaned files, empty package discovery, missing package registrations and stale secondary routes fail the gate. Secondary manual commands are recorded separately from required CI obligations.

The root Vitest watch/project list now includes all 22 runtime packages. This does not make `pnpm test` a distributed/devnet certification command. Devnet, browser, Solidity, Python and observability tools have their own routes and prerequisites.

The previously orphaned A2/B3 test is in `pnpm test:evm agent`. Its dependent steps now form one fail-fast journey: preserve KA identity through finalize/publish, parse and resolve its UAL, reopen and update, then check the chain root count and latest root. Assertions use the current consumed-SWM contract, and pulling into an existing VM explicitly requests replacement.

The disabled-test scanner adapts the implementation from open PR #1769 (`8bd5d905a33354ed7cdae01d0ea003b71f9a6cca`). Its tests are included. The initial ledger contains 72 existing findings represented by 69 semantic fingerprints; these are legacy debt, not newly approved quarantines. Reducing debt is allowed; substituting a new skip at the same count is not. Populated packages no longer use `--passWithNoTests`. Vitest/Mocha focused tests are forbidden, and the source guard detects focused aliases while ignoring example strings and comments.

A new temporary `test-disable-allow:` exception needs the scanner's issue/reason plus `owner=NAME lane=EXECUTION-OBLIGATION expires=YYYY-MM-DD`, with at most 31 days remaining. An example, to adapt only after providing a real issue and running lane:

```text
// test-disable-allow: D1 #123 -- backend-specific repair owner=storage lane=tornado-blazegraph expires=2026-09-20
```

The named lane must actually execute the platform/backend obligation; the marker alone does not create that lane. Review is still required to evaluate whether an exception's reason and execution obligation are truthful.

Main CI now requires both merged coverage and the selected Windows lifecycle job. The Windows workflow is reusable and is invoked by the primary workflow, including merge queue. Expected skips remain explicit. The reviewed controller stays pinned at `780f14aa60c39bdca788967121085c3c0d82d85c`; this change does not repin an unreviewed controller.

## 3. Generated tests exercise independent invariants

`pnpm test:properties` runs bounded fast-check pilots, also discovered in ordinary package tests:

- Context-graph join policy: valid round trips, idempotence, unknown-field stripping, wrong-graph rejection and one-field corruption, with protocol bounds expressed independently in the oracle.
- Durable sync progress: generated data/boundary/failure observations, completeness only after the required terminal/data evidence, triple totals and order-independent merge invariants.
- Publisher lifecycle: generated claims/transitions/replays and publisher reconstruction over real embedded Oxigraph, with an independently declared allowed transition model and persisted identity checks.

PR runs use seed `640905` and 100 cases. Scheduled CI records the run-number seed and uses 1,000 cases. To replay a minimized failure, retain the test name, seed and fast-check path printed in the failure, then run:

```sh
DKG_PROPERTY_SEED=640905 DKG_PROPERTY_PATH='PATH_FROM_FAILURE' \
  pnpm exec vitest run --config vitest.properties.config.ts -t 'FAILING_TEST_NAME'
```

These are bounded pilots, not a claim of exhaustive distributed-protocol verification. Broader revoke/key-rotation, RDF equivalence and Solidity accounting models can extend the same pattern after their independent oracles are specified. No additional Foundry framework is justified by the pilot evidence yet.

## 4. Real process and backend conformance

`pnpm test:conformance` uses built storage/publisher/CLI code, embedded Oxigraph, and the production-managed, checksum-pinned native Oxigraph server with an isolated RocksDB directory and owned port. It checks escaped/Unicode/language literals, private graph isolation, deletion effects and malformed-query failures. After an acknowledged broadcast identity is persisted, the server receives SIGKILL through its owned restart mechanism; it must recover within 20 seconds. A reconstructed publisher must see the exact old job and transaction identity, and the broadcast job must remain unclaimable. Public/private counts are checked independently after restart.

With `BLAZEGRAPH_TEST_URL` set, the same vectors exercise a real Blazegraph endpoint. The existing primary Blazegraph job sets `DKG_REQUIRE_BLAZEGRAPH=1`, so omission is a failure there. Local validation passed on native Blazegraph 2.1.6 RC (JAR SHA-256 `930c38b5bce7c0ae99701c1f6ef3057c52f3f385d938e1397a3e05561c7df5de`), plus embedded/native HTTP Oxigraph. The exact pinned CI Docker image remains a separate Linux CI validation.

The pass packet is `test-systems/.runtime/storage-conformance.json`, with revision, binary version, backends, crash point, transaction hash, recovery generation and logs. Stale packets are removed before a run. A test failure or absent packet cannot count as successful conformance. Tests stop only processes they own and clean up after failure as well as success.

Storage adapter unit tests now use a real embedded SPARQL endpoint behind HTTP instead of hard-coded count replies. Their Blazegraph adapter case tests the HTTP adapter contract; the conformance suite above supplies the real Blazegraph evidence.

Hardhat helpers ask their own child to bind and never kill an arbitrary listener. They verify readiness from their own child, require successful deployment process completion, impose a deployment deadline and release owned providers/processes on errors. A separate port-ownership regression verifies that an unrelated listener survives. Every Hardhat-backed Vitest project now receives a unique context filename, and each deployment has its own temporary contract-record directory. This prevents parallel checkouts and fresh chains from reusing or overwriting each other's records. An owned child that exits with `EADDRINUSE` retries on an ephemeral port, at most three attempts; other startup errors fail immediately. Both error boundaries have regression tests. Real-daemon fixtures let their child bind port zero, read its own API-port file, and clean up failed starts. Small CLI and agent snapshot fixtures use explicit 16 MiB reserves instead of inheriting a production node's 5 GiB reserve; production capacity tests and defaults remain intact.

During the baseline run, startup stalled in `process.report.getReport()` doing synchronous reverse DNS. `checkFdLimit` now excludes network diagnostics during its limits-only read and restores the caller's setting even on exceptions. Regression tests cover both prior settings and both success/error paths. This is the product fix directly found by running the broader tests.

The existing coverage cron moves into main CI for full coverage, rotating property cases and opt-in heavy browser scenarios. This consolidates a repository scheduler; it does not create a competing Jenkins deployment campaign. PR #1571 and its described Jenkins integration were inspected, but live Jenkins configuration was not available for validation. Gate 3/Blackbox upgrades and distributed release campaigns remain separate rollout work. Release validation retains local public/private runs before any network campaign and the harness-owned observer entry point.

## 5. Mutation testing measures assertion strength

`pnpm test:mutation` runs Stryker against `core/src/context-graph-join-policy.ts` using the existing policy tests. Pinned Stryker/Vitest versions were exercised locally. The initial score was 95 killed / 8 survived (92.23%). Added boundary, fallback and malformed-object cases improved it to 102 killed / 1 survived (99.03%), with zero timeouts, uncovered mutants or errors. The module's regression floor is 99%.

The survivor removes a redundant `typeof updatedAt` check; `Number.isFinite` also rejects nonnumbers. It remains visible in the score and report. No hard-to-test source was excluded to raise the result. Reports are `reports/mutation/mutation.json` and `index.html`, uploaded in the Core CI lane. The measured pilot takes about nine seconds locally; larger module campaigns should be separately budgeted before expansion.

## 6. Remove weak checks and measure resources

A controlled navigation-removal defect was caught by the replacement DOM test; renaming its callback while preserving behavior still passed. The legacy finalization suite now reuses the shared Hardhat fixture, removing 195 lines of duplicate startup/deployment/profile code and retaining all six passing scenarios. It fails on a missing backend instead of dynamically skipping the suite. Two notification source-substring checks in `ui-compat.test.ts` are replaced by DOM interaction coverage in `notifications-pane.dom.test.ts`: approve/deny and error flows, active/approved navigation, and rejected-row non-interactivity. Existing architecture/export/source policy tests remain. A 10,000-failure retry-queue test checks bounded entries, capped backoff, expiry and complete drain using deterministic counters/time, without a fragile wall-clock threshold.

JUnit artifacts now cover all primary Vitest packages, the dedicated EVM runner and Python. Solidity shard tests emit validated Mocha JSON. Playwright keeps raw JSON/JUnit/HTML and adds a first-attempt summary with recovered retries, final failures and skips. Retried passes do not erase the initial failure. Raw reports retain detailed IDs, durations and errors; artifact/workflow provenance binds them to the candidate. A 30-run reliability history has not yet been collected, so there is no fabricated repository-wide flake rate.

The existing W1 benchmark smoke and reachability gates remain. Stable-runner throughput, memory and latency thresholds need measured variance and a pinned environment; none are invented on this shared machine. CI critical-path and runner-minute changes require before/after CI runs.

Retained deliberately:

- The chain EVM adapter runs in both default and dedicated EVM obligations. Removing one requires a coordinated change to the reviewed cross-workflow routing contract, plus evidence of equivalent environments.
- The random-sampling skeleton/version test exposes an old public version constant. Changing that public export requires a compatibility decision; it is not silently rewritten as test cleanup.
- Archived compatibility suites and architectural guards retain their explicit historical/contract routes. Source cleanup in PR #2460 is separate.

## Validation and rollout

See `coverage-baselines.json` for per-package measurements. Validation used Node 22.23.1 and pnpm 10.28.1 on macOS ARM64. Frozen installation, the runtime package build, strict conformance/Hardhat fixture type checks, lint, W1 reachability and the existing benchmark smoke passed. The local evidence directory alongside the implementation checkout contains command logs and raw reports.

| Check | Local evidence |
| --- | --- |
| Execution inventory | 1,650 test files across 22 Vitest packages and secondary systems; an intentionally orphaned file and an empty package selection both fail |
| Repository policy/script tests | 268 passed; disabled-test ledger has no additions |
| Core full-source coverage run | 1,865 tests passed; all six changed executable startup lines covered |
| Agent full-source coverage run | 4,951 passed, 10 existing skips; all 391 discovered files appear exactly once across ten successful isolated shards |
| CLI full-source coverage run | 3,933 passed, 13 existing skips; 66.50% lines across the expanded source scope |
| Dedicated agent EVM runner | 16 passed, including A2/B3; consolidated finalization also passed all six retained scenarios |
| Property pilot | Five properties passed with 100 PR cases and with 1,000 cases using a second seed |
| Mutation pilot | 102 killed, one surviving equivalent guard mutation, no timeouts/uncovered/errors; enforced floor 99% |
| Python contract suite | 166 passed; 34.45% combined statement/branch coverage, CLI about 98% |
| Backend/process conformance | Embedded Oxigraph, native HTTP Oxigraph 0.5.8 and native Blazegraph 2.1.6 RC passed; persisted identity survived owned-process SIGKILL/restart |
| Reporter/merger checks | Real two-shard RDF hit-map merge matches the unsharded totals; real Query shared-runner receipt passes the aggregate; missing/stale/duplicate shards and absent coverage are rejected |
| Solidity report pilot | 25 Identity tests passed with validated Mocha JSON; full Solidity coverage remains its existing separate CI obligation |

Initial failed runs remain in the evidence directory. They identified incomplete deployment acceptance, deployment/context collisions, the limits-report DNS stall and small disk fixtures inheriting production reserves. Repaired runs are recorded separately; diagnostic failures are not rewritten as first-attempt passes.

Before merging, require the full GitHub candidate run: the exact Linux Blazegraph image, Windows lifecycle behavior, all shard receipts, browser suite and aggregate checks. Then collect scheduled-run history and measure CI cost before increasing campaigns or removing expensive cross-workflow obligations. This repository change does not claim external Jenkins verification, a stable performance baseline, network certification, or release approval.

## Review follow-up validation (September 5)

The inventory now covers JS/TS test filenames, Python `test_*`/`*_test` files and `run_all_tests.py` drivers, shell test/e2e/smoke/soak/verify drivers, and YAML cases under test/case directories or named `*.test.yaml`. Explicit routes include the CCL Python/YAML corpus and shell soak drivers; removing a route fails discovery. Manual routes remain manual obligations.

`ci-lanes.mjs` is the candidate-side source for planner lane IDs, aggregate job mapping, coverage package membership and shard counts. Both the inventory gate and tooling tests validate the executable workflow against this model. Matrix and package-invocation drift have negative regression cases. The supporting job runs up to three packages concurrently with two workers per package, waits for every result, and then executes the required Python and demo steps even if a Vitest lane failed. Each package retains its own JUnit and coverage receipt. This concurrency limit is not a measured CI speedup claim.

The disabled-test scanner now separates pure AST analysis, Git/file discovery and CLI dispatch. Its former embedded self-tests run in the tooling suite. Imported test aliases, namespace imports, computed skip members and chained APIs cannot bypass the debt ledger; locally shadowed imports are ignored. The legacy debt ledger is unchanged.

Shared KA request fixtures and owned native-server startup live under `scripts/testing`, with an explicit ESM boundary. Backend conformance no longer imports a publisher-private test module or a package-private port helper. The publisher helper-type gate still checks the shared request contract, and shared fixtures participate in Turbo cache inputs.

Browser HTML uses a subdirectory so its cleanup cannot erase raw JSON. A real Playwright reporter run verifies that both outputs survive and the quality-summary consumer succeeds. Prime's nested extension build participates in both the shared archive and Turbo build outputs; its coverage command builds the extension from an empty output directory. An actual archive/restore round trip preserved the extension file hashes.

Additional local checks: 1,735 inventoried test files; 281 repository tooling tests; 1,871 Core tests with 87.03% full-source line coverage and all 15 changed executable startup lines covered; 88 Prime tests from a clean extension build; 57 focused publisher/lifecycle cases; nine agent-chain EVM cases; and embedded/native Oxigraph plus native Blazegraph recovery conformance. Core's first unrestricted parallel coverage run hit three timing failures; a bounded two-worker run passed without changing test deadlines, assertions or coverage floors. These remain local results; current GitHub candidate checks are reported separately on each PR.

The ten supporting package lanes also passed together using the bounded runner and the configured Python environment; all ten revision/fingerprint receipts and full-source coverage gates passed. The required Python suite passed 169 cases and the demo passed 36. A cold shared build completed all 25 tasks; an empty Prime extension output was then restored byte-for-byte from a three-task Turbo cache hit.
