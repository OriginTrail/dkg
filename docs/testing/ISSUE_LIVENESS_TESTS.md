# Issue-liveness regression tests

A suite that encodes confirmed-live GitHub issues as runnable tests, so we can
(a) prove which issues are still real and (b) get a self-closing signal when one
gets fixed.

## The convention: red while the bug is live, green when it's fixed

Each test asserts the **correct** behaviour the issue asks for. While the bug is
live, that assertion **fails** — the test is **RED**. That red is the point: it
proves the test actually catches the bug. When the bug is fixed, the assertion
passes and the test goes **GREEN** and stays green.

- **Bug live →** test **RED** (it caught the bug).
- **Bug fixed →** test **GREEN** (and stays green; close the issue).

This is why PR [#1129](https://github.com/OriginTrail/dkg/pull/1129) (the test
suite) is **expected to be red** — every red test is a live, reproduced bug. The
**fix** PRs (e.g. #1107, #1132) are the ones that must be green. As each fix
merges, the matching liveness test flips to green.

Every test names its issue in the title and links it in the file header. A
"control" assertion (proving the precondition really holds — data present, the
in-memory config really carries a key, the merkle really matched) sits next to
each negative assertion so a test can't pass for the wrong reason.

To distinguish "RED because the bug is live" from "RED because the test is
broken", each test was authored against a known-fixed build (the #1107/#1132 fix
branches or a hand-applied fix) and confirmed to go **green** there. Zero mocks
for chain or network behaviour.

## HIGH-priority coverage — all 25 high / pre-mainnet issues

| Issue | Test | Tier |
|---|---|---|
| [#11](https://github.com/OriginTrail/dkg/issues/11) | `packages/agent/test/op-wallets-at-rest-encryption.test.ts` | CI unit |
| [#184](https://github.com/OriginTrail/dkg/issues/184) | `packages/query/test/subgraph-view-scoping.test.ts` | CI unit |
| [#462](https://github.com/OriginTrail/dkg/issues/462) | `packages/agent/test/issue-462-skill-acl.test.ts` | CI unit |
| [#675](https://github.com/OriginTrail/dkg/issues/675) | `packages/query/test/subgraph-view-scoping.test.ts` | CI unit |
| [#757](https://github.com/OriginTrail/dkg/issues/757) | `packages/cli/test/issue-liveness-daemon-routes.test.ts` | CI integration (real daemon) |
| [#936](https://github.com/OriginTrail/dkg/issues/936) | `packages/agent/test/issue-936-tokenid-determinism.test.ts` | CI unit |
| [#1013](https://github.com/OriginTrail/dkg/issues/1013) | `packages/publisher/test/issue-1013-async-finalization-honesty.test.ts` | CI unit |
| [#1078](https://github.com/OriginTrail/dkg/issues/1078) | `packages/storage/test/issue-1078-private-layer-scope.test.ts` | CI unit |
| [#1091](https://github.com/OriginTrail/dkg/issues/1091) | `packages/random-sampling/test/e2e-hardhat-chain.test.ts` | CI integration (real Hardhat) |
| [#1121](https://github.com/OriginTrail/dkg/issues/1121) | `packages/publisher/test/async-lift-canonicalization-and-encryption.test.ts` | CI unit |
| [#1122](https://github.com/OriginTrail/dkg/issues/1122) | `packages/publisher/test/async-lift-canonicalization-and-encryption.test.ts` | CI unit |
| [#886](https://github.com/OriginTrail/dkg/issues/886) | `devnet/issue-liveness/high-issues.test.ts` | devnet (multi-node) |
| [#1093](https://github.com/OriginTrail/dkg/issues/1093) | `devnet/issue-liveness/high-issues.test.ts` | devnet (multi-node) |
| [#1094](https://github.com/OriginTrail/dkg/issues/1094) | `devnet/issue-liveness/high-issues.test.ts` | devnet (multi-node) |
| [#1095](https://github.com/OriginTrail/dkg/issues/1095) | `devnet/issue-liveness/high-issues.test.ts` | devnet (multi-node) |
| [#1096](https://github.com/OriginTrail/dkg/issues/1096) | `devnet/issue-liveness/high-issues.test.ts` | devnet (multi-node) |
| [#1097](https://github.com/OriginTrail/dkg/issues/1097) | `devnet/issue-liveness/high-issues.test.ts` | devnet (multi-node) |
| [#1098](https://github.com/OriginTrail/dkg/issues/1098) | `devnet/issue-liveness/high-issues.test.ts` | devnet (multi-node) |
| [#1104](https://github.com/OriginTrail/dkg/issues/1104) | `devnet/issue-liveness/high-issues.test.ts` | devnet (multi-node) |
| [#614](https://github.com/OriginTrail/dkg/issues/614) | `packages/evm-module/test/issue-liveness-contracts.test.ts` | pending fixture (`it.skip` + recipe) |
| [#1099](https://github.com/OriginTrail/dkg/issues/1099) | `devnet/issue-liveness/high-issues.test.ts` | pending fixture (`it.skip` + recipe) |
| [#1124](https://github.com/OriginTrail/dkg/issues/1124) | `devnet/issue-liveness/high-issues.test.ts` | pending fixture (`it.skip` + recipe) |
| [#723](https://github.com/OriginTrail/dkg/issues/723) | `devnet/issue-liveness/high-issues.test.ts` | emergent metric (`it.skip` + recipe) |
| [#999](https://github.com/OriginTrail/dkg/issues/999) | `devnet/issue-liveness/high-issues.test.ts` | load-dependent (`it.skip` + recipe) |
| [#1008](https://github.com/OriginTrail/dkg/issues/1008) | `devnet/issue-liveness/high-issues.test.ts` | load-dependent (`it.skip` + recipe) |

### Why three tiers

- **CI unit / integration (11):** single-process or single-Hardhat-node bugs,
  reproduced in the package test dirs. These run in the normal `turbo test` CI
  lanes (Tornado / Bura / Kosava) and are red today.
- **Devnet multi-node (8):** publish → quorum → replication bugs that cannot be
  reproduced in a single process. They run on the devnet harness
  (`./scripts/devnet.sh start 6` + bootstrap, `pnpm test:devnet:issue-liveness`),
  not the standard CI lanes. A `CONTROL` test proves SWM data actually
  replicated, so the repros can't pass for the wrong reason.
- **Pending fixture / emergent (6):** issues whose faithful reproduction needs a
  fixture, topology, or scale that doesn't exist yet (#614 billing-window math,
  #1124 host-mode sharded cores, #1099 gossip-retention timing) — or that are
  emergent / load-dependent and have **no** deterministic single-run assertion
  (#723 is a 6-hour network-wide RS proof-rate metric; #999/#1008 are
  store-saturation hangs that only appear under sustained load). For these a
  fake green-able test would be a **false positive**, which is worse than an
  honest `it.skip` carrying the exact repro recipe. Each was confirmed live on a
  real node / testnet during the QA sweep; unskip when its fixture lands.

The 8 fix-in-flight highs (#886, #1093–#1098, #1104) are also fixed on PR #1107:
when it merges their devnet repros start passing → they go green.

## Lower-priority deferred (test should come with the fix PR)

- **#1112 / #1113 / #1015** (UI count caps) — need a >50k-triple fixture; too heavy
  for the Playwright lane.
- **#966** (single-root publish UI path) — needs a multi-root SWM UI fixture.
- **#467 / #703 / #998** — environment-specific (markitdown install fidelity, live
  OpenClaw runtime) that a CI box can't fake.
