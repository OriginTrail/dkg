# Issue-liveness regression tests

A suite that encodes confirmed-live GitHub issues as runnable tests, so we can
(a) prove which issues are still real and (b) get a self-closing signal when one
gets fixed.

## How it works (the `it.fails` / `test.fixme` convention)

Each test asserts the **correct** behaviour the issue asks for. While the bug is
live, that assertion throws — so the test is wrapped in vitest's `it.fails`
(`test.fixme` for Playwright). That means:

- **Bug live →** assertion fails → `it.fails` reports **pass** → CI stays green.
- **Bug fixed →** assertion passes → `it.fails` reports **fail** ("expected to
  fail but passed") → CI goes **red**, telling the fixer to remove `.fails`,
  make it a plain `it(...)`, and close the issue.

So a red `it.fails` is the cue that an issue can be closed. Every test names its
issue in the title and links it in the file header.

All tests were written against — and confirmed failing-as-expected on — a real
node / live devnet during the 2026-06-11 QA sweep. Zero mocks for chain or
network behaviour.

## What's covered (14 issues)

### Tier 1 — single-node, runs in the normal `turbo test` CI lanes

| Issue | Test file | Asserts (correct behaviour) |
|---|---|---|
| [#1125](https://github.com/OriginTrail/dkg/issues/1125) | `packages/cli/test/skill-md-dynamic-section.test.ts` | served skill.md has no literal `(dynamic)` placeholders |
| [#675](https://github.com/OriginTrail/dkg/issues/675) | `packages/query/test/subgraph-view-scoping.test.ts` | WM-view query includes sub-graph data |
| [#184](https://github.com/OriginTrail/dkg/issues/184) | `packages/query/test/subgraph-view-scoping.test.ts` | `view` + `subGraphName` scopes instead of throwing |
| [#416](https://github.com/OriginTrail/dkg/issues/416) | `packages/core/test/escape-rdf-literal-control-chars.test.ts` | escaper UCHAR-encodes NUL/VT/DEL control bytes |
| [#709](https://github.com/OriginTrail/dkg/issues/709) | `packages/epcis/test/event-type-container-filter.test.ts` | events query excludes the `EPCISDocument` container |
| [#15](https://github.com/OriginTrail/dkg/issues/15) | `packages/cli/test/rdf-parser-jsonld.test.ts` | `.jsonld` with `@context` parses (or isn't advertised) |
| [#787](https://github.com/OriginTrail/dkg/issues/787) | `packages/cli/test/issue-liveness-daemon-routes.test.ts` | SWM write of string quads → 4xx, not 500 |
| [#306](https://github.com/OriginTrail/dkg/issues/306) | `packages/cli/test/issue-liveness-daemon-routes.test.ts` | KA wm/write of string quads → 4xx, not 500 |
| [#158](https://github.com/OriginTrail/dkg/issues/158) | `packages/cli/test/issue-liveness-daemon-routes.test.ts` | ccl/eval not-found (real CG) → 4xx, not 500 |
| [#309](https://github.com/OriginTrail/dkg/issues/309) | `packages/cli/test/issue-liveness-daemon-routes.test.ts` | `/api/status` exposes `defaultAgentAddress` |
| [#757](https://github.com/OriginTrail/dkg/issues/757) | `packages/cli/test/issue-liveness-daemon-routes.test.ts` | non-curator token is 403'd from `/join-requests` |

The daemon-route file spins one real edge daemon against the shared Hardhat node
(zero chain mocks), same harness as `daemon-http-behavior-extra.test.ts`.

### Tier 2 — multi-node, manual-run devnet suite

`devnet/issue-liveness/automated.test.ts` (run: `pnpm test:devnet:issue-liveness`
after `./scripts/devnet.sh start 6` + bootstrap). A `CONTROL` test proves the SWM
data actually replicated to the peer, so the `it.fails` repros can't pass for the
wrong reason.

| Issue | Asserts (correct behaviour) |
|---|---|
| [#705](https://github.com/OriginTrail/dkg/issues/705) / [#923](https://github.com/OriginTrail/dkg/issues/923) | a peer can resolve lifecycle state for a peer-authored assertion |
| [#872](https://github.com/OriginTrail/dkg/issues/872) | a public-CG peer can fetch imported Markdown source bytes |

## HIGH-priority coverage — all 25 high / pre-mainnet issues

The manager asked for a reproducing test for every high-priority issue. All 25
now have a suite entry: 14 are **runnable `it.fails` repros** that reproduce the
bug today; 11 are **documented `it.skip` stubs** with the exact repro recipe,
used where a faithful test needs a fixture/design/topology that doesn't exist
yet (a wrong test is worse than an honest stub). When the stub's fixture lands,
unskip it.

| Issue | Where | Kind |
|---|---|---|
| #11 | `packages/agent/test/op-wallets-at-rest-encryption.test.ts` | runnable `it.fails` |
| #184, #675 | `packages/query/test/subgraph-view-scoping.test.ts` | runnable `it.fails` |
| #757 | `packages/cli/test/issue-liveness-daemon-routes.test.ts` | runnable `it.fails` |
| #1121, #1122 | `packages/publisher/test/async-lift-canonicalization-and-encryption.test.ts` | runnable `it.fails` |
| #886, #1093, #1094, #1095, #1096, #1097, #1098, #1104 | `devnet/issue-liveness/high-issues.test.ts` | runnable `it.fails` (devnet) |
| #1099 | `devnet/issue-liveness/high-issues.test.ts` | `it.skip` — timing/gossip-retention sensitive (repros on testnet, not a fast local devnet) |
| #1124 | `devnet/issue-liveness/high-issues.test.ts` | `it.skip` — host-mode sharded topology (all devnet cores are CG members) |
| #1013, #936 | `devnet/issue-liveness/high-issues.test.ts` | `it.skip` — needs publisher-runtime / 2-replica-reconcile harness |
| #999, #1008 | `devnet/issue-liveness/high-issues.test.ts` | `it.skip` — load-dependent store saturation (verified live on testnet) |
| #723 | `devnet/issue-liveness/high-issues.test.ts` | `it.skip` — emergent network-wide RS metric, not a single-node assertion |
| #462 | `devnet/issue-liveness/high-issues.test.ts` | `it.skip` — needs a MessageHandler ACL harness (skill_request has no authz) |
| #1078 | `devnet/issue-liveness/high-issues.test.ts` | `it.skip` — needs a layer-scoped private-store API |
| #1091, #614 | `packages/evm-module/test/issue-liveness-contracts.test.ts` | `it.skip` — contract/design, needs a contracts-engineer fixture |

The 9 fix-in-flight highs (#886, #1093–#1099, #1104) are also fixed on PR #1107:
when it merges their `it.fails` repros should start passing → unwrap them.

## Lower-priority deferred (test should come with the fix PR)

- **#1112 / #1113 / #1015** (UI count caps) — need a >50k-triple fixture; too heavy
  for the Playwright lane.
- **#966** (single-root publish UI path) — needs a multi-root SWM UI fixture.
- **#467 / #703 / #998** — environment-specific (markitdown install fidelity, live
  OpenClaw runtime) that a CI box can't fake.
