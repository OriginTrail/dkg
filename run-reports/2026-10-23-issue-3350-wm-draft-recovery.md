# Testnet Validation Report — issue 3350

## Executive Summary

**Passed:** the candidate distinguishes an exact recovered WM draft from interrupted or conflicting public/private content without returning private payload or modifying an unproven draft. Authenticated named HTTP tests and a real Base Sepolia node covered a dropped successful response, full daemon/store restart, and an actual worker exit immediately before private insertion after public WM had committed. Existing reject semantics, explicit replacement, edit/finalize/share, async VM publication and VM readback also passed. The VM transaction was independently checked against its receipt, historical Hub bindings, on-chain root and graph membership.

Public RPC authority reads caused temporary share failures; the admitted share recovered on its fifth attempt. An initial unregistered-graph setup failed before SWM commit and is excluded from passing scenarios. No product regression was observed in the completed matrix. CI and reviewer readiness are tracked separately in the implementation plan.

## Environment and source identity

- Date: 2026-10-23, Europe/Belgrade (UTC+02); native macOS arm64, Node 22.23.3, pnpm 10.28.1.
- PR: https://github.com/OriginTrail/dkg/pull/3429, base `testnet-canary`; starting base `9031533da8981d7d934b58f2440bbe42a424c224`.
- Run: `issue-3350-20261023`; immutable pool batch `batch-2`. Ownership record and token remain in private local evidence.
- Isolated home: `.tmp/issue-3350/home`; raw evidence: `.tmp/issue-3350/evidence`. No normal user node home was used.
- API/store: authenticated loopback ports **64728/64729**, managed Oxigraph 0.5.8 with RocksDB persistence. Auto-update disabled.
- Network: DKG Base testnet, EVM chain **84532**. Hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6`, TRAC `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8`. Four connected peers at readiness.
- The final live retest used the round-2 candidate source tree. SHA-256 manifest `ae8df5b42c4e115bdbf73f12ca159ad592054c8d2efc0eb604cadbed396f5999` covers all nine changed executable source files; its Git blob IDs are checked against the submitted head in private `source-head-proof.json`. Build stamps and runtime logs are retained, including earlier dirty-tree builds. This avoids inferring executed code from a branch label.
- First operational wallet and first publisher submitted testnet transactions. No wallet funding or PCA changes were performed; no new publisher profiles were provisioned for this test.

| Role | Selected public address |
|---|---|
| Admin | `0x6F5a22fa95828CB602763D963BD0eCE354a4e2bf` |
| Operational 1 | `0x5d9b553e9D8c5859734272d3eFba2311C69878BE` |
| Operational 2 | `0x95081A20D970b40C9cb925d5657afE8d036D7Ca1` |
| Operational 3 | `0x52994A33D6f5Fc1F549674a9ca6CC106C03fB4d6` |
| Publisher 1 | `0xE3fD6176F0cD5ff0A823476A271B196D74e19fF0` |
| Publisher 2 | `0x546a0c83A2E0024d2C90bb585d5D96cdF26DA5C7` |
| Publisher 3 | `0x36A4371004Aaf98F8693acA4ED3AE4eD18D8bb10` |
| Publisher 4 | `0xc977E91C8215a69ae9360758D8a26A2EB1B0Af94` |
| Publisher 5 | `0x84502E000ae5725932a44525a62042356bf2bC00` |
| Publisher 6 | `0x6056FC0FFe573bfa5510d9CC77348912273Dee9E` |

## Executed plan and results

Private fixtures/corruption were prepared through the isolated local store because named HTTP draft writes expose public quads. All create, finalize, share, pull, exact recovery and publication operations used the authenticated named API. Faults ran in external test infrastructure; no production fault hook was added.

| Scenario | Observed result |
|---|---|
| Auth | Protected read rejected an absent bearer and accepted the native local token; real daemon/Hardhat coverage also refused actor override |
| Complete mixed pull, response dropped by HTTP proxy | Upstream completed with 200; downstream connection was dropped; ordinary retry remained `409 WM_DRAFT_CONFLICT` |
| Complete draft after daemon and managed-store restart | `recoverExact` returned scope-bound roots/counts for the pinned source; 1 public + 1 private source partition; full scoped store snapshot unchanged |
| Public-only and incomplete-private fixtures after restart | Exact public-only draft accepted; incomplete private draft refused with `WM_DRAFT_NOT_EXACT`; snapshots unchanged |
| Process interruption at the public/private boundary | At 10:46:44 CEST, test preloader recorded worker PID 15001 exiting before the private draft INSERT was sent. Supervisor replaced worker/store; ordinary retry conflicted and exact recovery refused the incomplete draft unchanged |
| Same-count wrong private content | Refused unchanged; count equality did not authorize recovery |
| Public-only source plus stray private WM | Refused unchanged |
| Wrong version and superseded original source | Refused with `WM_RECOVERY_SOURCE_UNAVAILABLE`, including a superseding unpublished assertion with a changed root |
| Same-count wrong public content on final candidate | Refused unchanged; restored fixture reverified |
| Missing immutable private source on final candidate | Refused unchanged; fixture source restored and reverified against its seal |
| Explicit replace → edit → finalize → share | Passed; final payload had 2 public + 1 private quads |
| Async publication | Job `2c1b10df-1e12-458b-89f8-b9a1ed251037` reached `finalized`; three storage ACKs recorded |
| VM pull and exact retry | Passed; public RDF equals the two expected triples, private count/root and combined root match the seal |
| Privacy | Recovery responses contain commitments/counts only. No private sentinel appeared in daemon logs; local tests also check bounded errors and omitted causes |

The code also has real-Oxigraph tests for private-only, subgraph and VM recovery; wrong actor/context/subgraph/KA/version; corrupted/missing sources; restart/partial seed; partial-seal recovery; and caller option mutation. These are unit/integration checks, not claims of additional live multi-node scenarios.

## On-chain evidence

- Transaction: `0x401bd81040df991d54ba6ac0a3b9df4512a6e93928eb97f2a0ff824eff1ab214`; successful receipt at block **49118021**, hash `0x775e9f2fbee53f1ba46481ae756bf21c4019a3061503aeb78420d655a1bae150`.
- KA: `did:dkg:base:84532/0x5d9b553e9d8c5859734272d3efba2311c69878be/138`, assertion version 1; registered context graph **944**.
- On-chain and sealed Merkle root: `0x886a49c2364d3542254292e26e0b92ba781603d6aa2a3b9365045c02e61c3df4`.
- EIP-1898 reads pinned to that receipt block independently resolved the Hub's asset-storage bindings, checked `getLatestMerkleRoot` and `kaToContextGraph`.
- Actual storage contracts: `0x2B2e1bCB7C52A1587264e01F6B53782d791e6FA0` and `0x4F905efD3Ebb62e94502B6722a816b5A3e4DAca2`. Admission alone was not counted as publication.

## Local validation

- 73-test pre-change baseline passed; initial exact-recovery regressions demonstrated nine failures before implementation.
- **116 publisher/lifecycle tests passed** across both pull/recovery suites and sealed-create/lifecycle checks.
- **69 real daemon/Hardhat named HTTP tests passed**, plus **seven** focused pull error-mapping tests.
- CLI smoke: 15 tests passed; the strengthened recovery flags were retested after parser consolidation.
- Publisher, agent and CLI builds/type/package-boundary checks passed; discriminated result type is checked by compile-time positive/negative fixtures.
- Gated real-store concurrency test passes normally and **fails when exact recovery deliberately bypasses its lifecycle lock**; source restored afterward.
- Repository lint, source-size guard and `git diff --check` passed. The first post-split CI run caught five unused test imports; these were removed and tracked-file lint rerun successfully.

## Cleanup and retained evidence

All six share jobs are terminal (five succeeded; initial unregistered setup failed) and the publication job finalized. Owned daemon/supervisor/store processes and both listeners were verified stopped. Pending/latest nonces match for every selected signer after shutdown; used operational wallet ends at nonce 39, used publisher at nonce 90. The matching `batch-2` claim was released successfully.

The checkout and private home/store/evidence are retained for review and reproduction. Credentials, claim tokens, private fixture contents and raw logs are excluded from this PR. Resuming the home requires reacquiring the same batch. No background monitoring automation or live node remains active.

## Limits

This is one isolated edge-node campaign against the public testnet, not exhaustive network or performance validation. Temporary live authority failures recovered through the existing durable owner; no manual share replay was used to count that recovery. The earlier setup failure is retained separately. Recovery evidence is a snapshot under the lifecycle lock and does not authorize a later mutation after concurrent writes.
