# Changelog

All notable changes to the DKG V9 node are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

---

## [10.0.0-rc.7] - 2026-05-13

RFC 07 in-process `PeerResolver` consolidation, Relay Registry tri-state on-chain semantics, PCA wiring at registration, and full invite/join e2e coverage in the devnet smoke suite. **No testnet contract redeploy** — `chainResetMarker` unchanged from rc.6 (`v10-rc6-pca-author-attestation-2026-05-10`); rc.7 is a node-only update over the existing on-chain world.

### Added
- **RFC 07 — In-process `PeerResolver` (consolidated PRs #494, #496, #497, #499, #501, #506)**: every outbound libp2p dial now flows through a single resolution chain (live-conn → DHT → RFC 04 registry stub → agents-CG fallback). New `/api/connect` semantics return precise HTTP codes (`504 PEER_NOT_FOUND`, `502 DIAL_FAILED`, `400 INVALID_PEER_ID`) with structured error bodies so callers can distinguish "peer is unknown to us" from "we know it but can't reach it." A CI grep gate (`scripts/audit-dial-protocol.mjs`) prevents new raw `libp2p.dialProtocol(peerId, …)` callers from sneaking in around the resolver.
- **Backend-agnostic `dkgGossipMsgId` primitive** (PR #501): unified gossip message-id derivation behind a single helper so every gossipsub publisher (heartbeat, agent-ad, KC-ad, SWM-write) uses identical message-id logic regardless of transport (real libp2p vs in-memory test bus). Cuts class of duplicate-rebroadcast bugs the `/api/agents` heartbeat exhibited under restart.
- **devnet-test.sh sections 28-31** (PRs #501, #506, #507): the smoke suite now exercises (28) `/api/connect` resolver path + HTTP semantics, (29) cross-node connect matrix, (30) Node1 cold-restart + post-restart resolver wiring, (31) curated CG invite/join end-to-end including silent-NACK regression guards. Knobs `SKIP_RESTART=1`, `SKIP_MATRIX=1`, `SKIP_INVITE_FLOW=1` for fast iteration.
- **PCA wiring at registration** (PR #502, rebase of #423, `packages/cli/src/daemon/routes/context-graph.ts`, `packages/agent/src/dkg-agent.ts`): when an operator registers a CG with `publishPolicy: 'pca'`, the daemon now records the PCA owner address, the chain signer address, and the `getRegistrationTxSignerAddress` separately. PCA agents can publish to the registered CG without 500-error fallthroughs; non-existent PCA accounts return a clean `404` rather than a generic 500; `publishPolicy` is now exposed on `ApiClient.createContextGraph` so dkg-node-ui can surface the choice at create-time.

### Fixed
- **`relayCapable` was sticky on chain** (PR #506, `packages/agent/src/dkg-agent.ts`, `packages/cli/src/daemon/lifecycle.ts`): `publishRelayRegistry` previously treated `false` and `undefined` identically as no-ops, so a node that ever ran with `relayCapable=true` would keep advertising itself as relay-capable on chain forever. Now tri-state: `true` ensures on-chain flag is true, `false` actively clears any stale opt-in, `undefined` leaves the on-chain flag untouched (preserves manual `dkg admin set-relay-capable` flips). 12 new regression tests in `packages/agent/test/publish-relay-registry.test.ts`.
- **Curated CG invite/acceptance regressions caught by SECTION 31** (PR #507): the standalone `scripts/devnet-test-invite-flow.sh` is folded into the main smoke suite, so future runs assert (a) `DKG_CURATOR` triple is present in the curator's `_meta` graph (silent-NACK regression guard for PR #448 round-6), (b) the inbound `PROTOCOL_JOIN_REQUEST` handler logs accept + persist, (c) `denied` catch-up status produces no phantom CG entries, and (d) post-approval catch-up actually completes with `_meta` triples mirrored to the invitee.

---

## [10.0.0-rc.6] - 2026-05-10

RFC-001 sign-at-creation lifecycle, on-chain agent provenance, robust replica sync, devnet release-gate test layer. **Testnet contract redeploy required** — `chainResetMarker` bumped to `v10-rc6-pca-author-attestation-2026-05-10`, which auto-wipes node-side state on first boot. All non-Hub/Token contracts on Base Sepolia have new addresses (Hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` and Token `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8` preserved); operators must re-create profiles and stakers must re-stake (TRAC stuck in the orphaned `DKGStakingConvictionNFT` is non-recoverable on testnet by design).

### Added
- **Sign-at-creation assertion lifecycle** (PR #436, `packages/agent/src/dkg-agent.ts`, `packages/cli/src/daemon/routes/assertion.ts`): chained `assertion.create → write → finalize → promote` REST flow plus four standalone routes that each emit `memory_graph_changed` SSE so external lifecycle composers (staking-ui, dkg-node-ui) reflect every step in real time. Seal binds `merkleRoot + rootEntities + EIP-712 author attestation` together; `publishFromFinalizedAssertion` recomputes the root from the same `kaMap` partition the seal used so any drift between finalize-time and publish-time is rejected before a signature is wasted.
- **On-chain agent provenance via EIP-712 author attestation** (PR #436, `packages/evm-module/contracts/KnowledgeAssetsV10.sol`, `packages/agent/src/finalization-handler.ts`, `packages/chain/src/evm-adapter.ts`): unified `publish(PublishParams)` entry point with `_verifyAuthorAttestation` (EIP-712 + EIP-1271 for smart-contract wallets); new `KCCreated(uint256,bytes32,uint96,address)` event indexed-topic carries the recovered author address. Originator path emits `dkg:authoredBy` + `dkg:Publication` triples on the publishing node; replicas now reconstruct the same triples by reading the on-chain `author` topic in `FinalizationHandler.verifyOnChain` and threading it through `promoteSharedMemoryToCanonical`.
- **Robust sync-on-connect retry** (PR #436, `packages/agent/src/dkg-agent.ts`, `packages/agent/src/sync/on-connect/sync-on-connect.ts`): event-driven retry on `peer:update` (covers libp2p `identify` race) plus a 5-minute periodic reconciler that re-pulls from any connected peer whose last successful sync is staler than 10 minutes. Handles the "node joins network at random time, peer protocols arrive late" failure mode that previously stranded fresh nodes without historical KCs.
- **Hardhat interval mining default** (PR #436, `scripts/devnet.sh`): devnet now mines a block every 1000 ms via `evm_setIntervalMining`, so on-chain time keeps ticking without new transactions. Required for RandomSampling proofing periods, operator-fee accrual, and any time-based contract behavior to work on a quiet local devnet.
- **`devnet/v10-core-flows` release-gate test suite** (PR #436): release-gate validation against a live 6-node devnet. Four canonical scenarios (chained sign-at-creation lifecycle + SSE emission per step, edge-node publish surfaces `tentative` correctly, NFT staking withdraw round-trip, operator-fee accrual within 1 % of RFC-26 prediction → request → cooldown → finalize). Run via `pnpm test:devnet:v10-core-flows`. Companion `FINDINGS.md` documents every architectural confirmation and deferred trade-off.
- **Devnet test suites promoted out of `experiments/`** (PR #436): `agent-provenance`, `v10-core-flows`, `v10-end-to-end`, `v10-stress` now live under `devnet/`. Their `package.json` `test` scripts were renamed to `test:devnet` so `turbo run test` no longer pulls them into the default CI fan-out — they require a live devnet and bootstrap state and are run via dedicated `pnpm test:devnet:*` scripts.

### Fixed
- **Sync responder dropped per-cgId `_meta` graphs** (PR #436, `packages/agent/src/sync/responder/sync-handler.ts`): the data-phase SPARQL filter `!STRENDS(STR(?g), "/_meta")` was over-matching and excluded every per-context-graph metadata graph (where KC merkle roots, `kaCount`, and other RandomSampling preconditions live). Replaced with an exact-match exclusion of just the canonical top-level `_meta` graph. Without this fix, every non-publisher core node failed `kc-not-synced` on every prover tick.
- **Standalone `/api/assertion/:name/finalize` did not emit `memory_graph_changed`** (PR #436, `packages/cli/src/daemon/routes/assertion.ts`): a merge-conflict resolution oversight. Clients composing the lifecycle by hand missed the `assertion_finalized` state transition. Pinned by `packages/cli/test/memory-graph-events.test.ts`.
- **Round-5 review: `assertionFinalize` could seal an unrecoverable merkleRoot** (PR #436, `packages/agent/src/dkg-agent.ts`): finalize hashed every quad in the assertion graph but `assertionPromote` and `publishFromFinalizedAssertion` later filtered out unsafe-IRI roots through `isSafeIri`, so the sealed root could not be recomputed at publish time. Now rejects finalize when *any* root entity fails `isSafeIri` rather than silently dropping the unsafe subset.
- **Round-5 review: replicas missed `dkg:authoredBy` triples** (PR #436, `packages/agent/src/finalization-handler.ts`, `packages/chain/src/evm-adapter.ts`): `KCMetadata` was rebuilt on the receive side with no author fields. Threaded the EIP-712-attested `author` from the `KnowledgeCollectionCreated` event through `EVMChainAdapter.listenForEvents → FinalizationHandler.verifyOnChain → promoteSharedMemoryToCanonical`. Two regression tests added in `finalization-promote-extra.test.ts`.
- **Publisher no longer auto-mints an ephemeral signing wallet** (`packages/publisher/src/dkg-publisher.ts`): `DKGPublisher` constructed without `publisherPrivateKey` previously generated `ethers.Wallet.createRandom()` whenever chain was enabled and used it to sign on-chain publish digests, ACK self-signatures, and authorship proofs. Signatures were unverifiable (signed by a throw-away key the caller never saw, attributed via `publisherAddress` to a different address). The constructor now leaves `publisherWallet` undefined, rejects zero/mismatched `publisherAddress` values, and publish/update fail before emitting publisher-attributed output unless a real signing key exists.

### Added (carried forward from PR #366 follow-ups)
- **`scripts/audit-create-random.mjs`** + CI gate: bans new `Wallet.createRandom()` use in `packages/*/src/**` outside three explicitly justified call sites (`op-wallets.ts` first-run wallet bootstrap, `agent-keystore.ts` custodial chat-agent registration, `evm-module/utils/helpers.ts` deploy script). Same anti-pattern destroyed nine testnet admin keys in May 2026 via the pre-PR-#366 `ensureProfile` random-and-discard path; audit runs in <300 ms on every CI build.

### Changed
- **Base Sepolia (chainId 84532): full v10.1 contract redeploy.** Hub at `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` and Token at `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8` retain their addresses and Token retains its `50,052,000 v9TRAC` total supply. The 34 deployable non-Hub/Token contracts (including the changed `KnowledgeAssetsV10`, `KnowledgeCollectionStorage`, `ContextGraphs`, `ContextGraphStorage`, `KnowledgeCollection`) were freshly deployed and registered on-chain in a single batched `Hub.setAndReinitializeContracts` call. New addresses are committed to `packages/evm-module/deployments/base_sepolia_v10_contracts.json`; agents discover them via `Hub.getContractAddress(...)` at runtime so `network/testnet.json` was not edited (only `chainResetMarker` was bumped). 11 auxiliary contracts (the legacy `ContextGraph*` registry family superseded by the new `ContextGraphs`/`ContextGraphStorage` and the V6/V8 reward migrators) intentionally skipped redeploy via their existing in-script gates.

### Deferred to follow-up PRs
- **PCA discount/attribution decoupling** (review comment 3215083795): the `DKGPublishingConvictionNFT` discount branch is keyed to `agentToAccountId(msg.sender)` while publishing credit goes to `p.publisherNodeIdentityId` (RFC-001 §3.6 — attribution decoupled from payment by design). Off-chain accounting concern is real but tightening it is a contract API change; will be its own PR.
- **Replica `dkg:authoredBy` via the gossip-publish path** (review comment 3215169754): the rc.6 fix covers the finalization-gossip replica path. Peers that confirm via `GossipPublishHandler` (the full-publish gossip path) still rebuild `kcMeta` without `authorAddress`; same one-line shape of fix as the finalization path, scoped to a separate PR for `GossipPublishHandler`-focused review.

---

## [10.0.0-rc.4] - 2026-05-04

Hotfix on top of `v10.0.0-rc.3`. **Restores random-sampling proof submission for v9-style `<owner>/<slug>` context graphs on testnet** and brings the deployed Base Sepolia `Profile` contract into line with what the post-PR-#366 daemon expects, so `op[1]` / `op[2]` ACK signer auto-registration finally lands on-chain. No `chainResetMarker` change — per-node state (oxigraph store, RS WAL, publish journals) is preserved across the operator update.

### Fixed
- **V9-style `<owner>/<slug>` context graph names no longer fail `extractV10KCFromStore`** (#377): the kc-extractor's `resolveContextGraphNameFromOnChainId` previously rejected any CG name containing `/`, so finalized KCs surfaced as `KCNotFoundError` in `[rs.tick.kc-not-synced]` and silently dropped every random-sampling proof submission for slash-named CGs (which is the v9 namespacing convention `<owner_address>/<slug>`). Validation now uses `assertSafeIri` on the *derived* meta-graph URI — the actual SPARQL injection surface — instead of an over-tight name-level allowlist that was conflating namespacing with safety. Reproduced first as a unit test in `kc-extractor.test.ts` and then end-to-end in `e2e-hardhat-chain.test.ts`; both regression-tested by reverting the resolver fix and confirming the new tests fail.
- **`scripts/devnet.sh` no longer crashes with `SyntaxError: Unexpected end of input` on startup** (#377): three JavaScript comments inside `node -e ...` blocks contained unescaped inner double-quotes that bash interpreted as string delimiters, truncating the script. Comments rephrased to avoid embedded double-quotes — necessary precondition for validating the kc-extractor fix on a local devnet.

### Changed
- **Base Sepolia (chainId 84532): `Profile` upgraded `v1.0.0` → `v1.1.0`, `Identity` re-deployed (`v1.0.0`, source-only zero-address-check tightening) so it stays in lockstep with the Profile that calls into it** (#372). The new Profile carries the `addOperationalWallets(uint72, address[])` external function the post-PR-#366 `ensureProfile` flow expects when registering the operational ACK wallet trio; without this upgrade the daemon failed silently with `Operational wallet auto-registration failed: missing revert data ... to: 0x4Ad9B99C…0493A` and only `op[0]` ever made it on-chain. Both contracts are pure logic (zero per-identity state) so no migration is required — existing identities 1-14, including freshly-recreated beacon-01 with 50,000 v9TRAC stake on identity 14, are unaffected. Hub mappings updated atomically via `Hub.setAndReinitializeContracts` (tx [`0xf7c8dfe2…1914`](https://sepolia.basescan.org/tx/0xf7c8dfe2c242bec2ee64f648757aba5b8d3b567b2129c3ebe89849abe8221914)).

---

## [10.0.0-rc.3] - 2026-05-03

Operator hardening on top of `v10.0.0-rc.2`. No contract redeploy — `chainResetMarker` unchanged, no per-node state wipe is triggered. Ships the admin / operational wallet key split, RandomSampling Hub-rotation self-refresh, prover stale-period detection, and devnet bootstrap fail-fast guards.

### Added
- **Persisted profile admin wallet** (#366): `wallets.json` now contains a distinct admin wallet alongside operational wallets so newly-created profiles do not lose their admin key.
- **Operational wallet self-healing for ACK signing** (#366): core nodes now auto-register configured operational ACK signer wallets on-chain for their profile identity during startup.
- **`Profile.addOperationalWallets(uint72,address[])` facade** (#366): profile admins can add operational-only keys without using the lower-level generic key-management surface.
- **End-to-end ACK signer registration coverage** (#366): a real Hardhat/libp2p test now verifies startup registration, StorageACK signing by the confirmed key, and refusal to sign after the key is removed on-chain.
- **RandomSampling Hub-rotation self-refresh** (#367): `EVMChainAdapter` re-resolves `RandomSampling` + `RandomSamplingStorage` addresses through `HubResolutionCache` on every prover tick instead of caching them at boot, so a Hub rotation no longer strands the prover on dead addresses.
- **`[rs.tick.forcing-rotation]` log + behaviour** (#369): the prover now compares the cached challenge's period against the on-chain block height every tick and forces a fresh `createChallenge` when the cached "unsolved" challenge is past its wall-clock period boundary, instead of stranding on a stale challenge after a Hub rotation.
- **Devnet stake-probe via `getNodeStakeV10`** (#368): `scripts/devnet.sh` checks for an existing identity-scoped V10 stake before issuing `createConviction`, preventing duplicate stakes when re-running `start` on an already-bootstrapped devnet.
- **Devnet hosting-node discovery fail-fast** (#370): `scripts/devnet-test-publish.sh` now distinguishes file-level `wallets.json` failures (refuses to run a partial smoke) from intentional edge-node skips.

### Changed
- **Admin-only operational wallet registration** (#366): `Profile.addOperationalWallets` requires a profile admin key; operational keys can no longer add more operational keys.
- **New profile creation uses the persisted admin wallet** (#366): `EVMChainAdapter.ensureProfile` now uses `chainConfig.adminPrivateKey` for the profile admin address instead of creating an unrecoverable random admin wallet.
- **StorageACK signing is gated by on-chain confirmation** (#366): core nodes only register/sign with ACK keys confirmed as `OPERATIONAL_KEY` for the node identity.
- **Devnet bootstrap fail-fast** (#370): `scripts/devnet.sh` now exits non-zero when `staked < coreCount`, refusing to declare devnet ready when only some cores ended up staked.
- **Single-flight RPC duration probe** (#369): `EVMChainAdapter` uses Contract-instance identity (rather than `HubResolutionCache.generation`) to scope the duration probe slot, so a TTL refresh that mints a new Contract handle correctly invalidates an in-flight probe without breaking `resolveAndAssignRandomSamplingPair`'s concurrent-invalidation detection.

### Fixed
- **Invalid ACKs from unregistered wallets** (#366): ACK handlers no longer produce signatures from local keys that are not confirmed operational wallets on-chain.
- **`HubResolutionCache` invalidate-vs-await race** (#367): a `generation` counter bumped only on `invalidate()` ensures an in-flight resolve started under generation N cannot write back its value if `invalidate()` was called while it was suspended.
- **Devnet single-wallet `wallets.json` file shape** (#368): `scripts/devnet.sh` now writes the `{ adminWallet, wallets }` shape expected by post-#366 daemons (graceful fallback for legacy single-wallet files retained for testnet operators).

---

## [10.0.0-rc.2] - 2026-05-01

V10 RandomSampling + V8/V10 staking consolidation. Testnet reset required (Base Sepolia) — see `docs/TESTNET_RESET.md`.

### Added
- **V10 RandomSampling end-to-end** (`packages/random-sampling`): per-node challenge/proof loop driven by `RandomSampling.sol`; chunk selection reads `merkleLeafCount` from on-chain V10 storage; non-zero `getNodeEpochProofPeriodScore` once a node holds V10 stake.
- **Auto chain-reset wipe** (`packages/cli/src/daemon/chain-reset-wipe.ts`): on boot, the daemon compares the bundled `network.chainResetMarker` against the persisted marker and one-shot wipes `store.nq{,.tmp}` + `publish-journal.*` + `random-sampling.wal` when they differ. Operators no longer need a manual wipe procedure on a testnet reset.
- **`ensureProfile` auto-stake via V10 path** (`packages/chain/src/evm-adapter.ts`): on a clean chain, agents auto-create their on-chain identity and stake 50k TRAC into a V10 NFT position via `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier=1)` so the V10 stake vault (`ConvictionStakingStorage.nodeStakeV10`) is non-zero from the first proof period.
- **Required `merkleLeafCount` on the V9→V10 publish bridge** (`packages/chain/src/chain-adapter.ts`, `evm-adapter.ts`): `PublishToContextGraphParams.merkleLeafCount` is now required; the bridge throws on missing/invalid input instead of silently defaulting to 1 (which would corrupt RandomSampling chunk selection for any KC with more than one leaf).
- **Stale-proof-period detection in the prover** (`packages/random-sampling/src/prover.ts`): tick now checks the actual chain block height against the cached period's expiry and forces `createChallenge` to rotate when the period has elapsed, instead of stranding on a stale "already-solved" cache view.
- **Testnet reset runbook** (`docs/TESTNET_RESET.md`): full procedure for the V10 cutover covering maintainer release (npm publish + git merge), contracts deploy, automatic per-node state wipe, and smoke verification.
- **Operator-supplied `randomSampling.walPath`** (`packages/cli/src/daemon/chain-reset-wipe.ts`, `daemon/lifecycle.ts`): chain-reset wipe now honors a custom WAL path from config instead of only the default location.
- **Codex PR review workflow** (`.github/workflows/codex-review.yml`): `pull_request_target` + SHA-pinned for review on every PR.

### Changed
- **Consolidated V8 `StakingStorage` into V10 `ConvictionStakingStorage`**: the dual-store coupling between V8 `Staking` / `DelegatorsInfo` and V10 storage is dropped. V10 contracts (`StakingV10`, `DKGStakingConvictionNFT`, `ConvictionStakingStorage`, `RandomSampling`, `RandomSamplingStorage`) are the canonical staking surface; V8 staking is unregistered from the Hub on the testnet reset.
- **Test helpers updated to V10 staking** (`hardhat-harness.ts:stakeAndSetAsk`): switches from V8 `Staking.stake` to `DKGStakingConvictionNFT.createConviction` so E2E flows match the agent's actual auto-stake path.
- **`enrichEvmError` regex generalised** (`packages/chain`): now decodes EVM revert reasons across Hardhat-style `data="0x..."` and the broader provider variants.

### Fixed
- **Zero RandomSampling node scores** caused by V8/V10 stake-vault split — `RandomSampling.calculateNodeScore` reads `ConvictionStakingStorage.getNodeStakeV10` exclusively, but legacy `Staking.stake` only updated V8 `StakingStorage`. Resolved by routing all stake through V10 (`ensureProfile`, `stakeAndSetAsk`).
- **`chainResetWipe` daemon crash on FS errors** (`packages/cli/src/daemon/chain-reset-wipe.ts`): wipe + `saveState` are now wrapped in `try/catch`; FS errors log a warning and boot continues instead of crashing the daemon.
- **`ensureProfile` profile-without-stake on partial failure**: profile creation and staking are now in separate `try/catch` blocks so a failed stake leaves the on-chain identity intact for retry instead of leaving the operator without either.
- **ABI pinning test drift** for V10 publish/update functions after `merkleLeafCount` was added (`abi-pinning.test.ts`): pin digests refreshed.

[Unreleased]: https://github.com/OriginTrail/dkg/compare/v10.0.0-rc.3...HEAD
[10.0.0-rc.3]: https://github.com/OriginTrail/dkg/releases/tag/v10.0.0-rc.3
[10.0.0-rc.2]: https://github.com/OriginTrail/dkg/releases/tag/v10.0.0-rc.2
[9.0.0]: https://github.com/OriginTrail/dkg-v9/releases/tag/v9.0.0

---

## [9.0.0] - 2026-02-26

First tracked release (DKG V9). Includes:

### Added
- **Cross-agent query protocol** (`/dkg/query/2.0.0`): query another node's knowledge store over libp2p (ENTITY_BY_UAL, ENTITIES_BY_TYPE, ENTITY_TRIPLES, SPARQL_QUERY) with access policies and rate limiting.
- **Node dashboard UI** (`@origintrail-official/dkg-node-ui`): web UI served by the daemon — dashboard, Knowledge Explorer (SPARQL + graph viz), Operations log, Network, Wallet, Integrations, chat assistant (rule-based + optional LLM).
- **Oxigraph persistence and sync**: triple store persists to disk; sync protocol for catch-up on connect.
- **On-chain publishing**: Base Sepolia testnet integration, TRAC staking, ask setting, knowledge asset minting.
- **CLI**: `dkg init`, `start`, `stop`, `status`, `peers`, `publish`, `query`, `query-remote`, `subscribe`, `contextGraph create/list/info`, `set-ask`, `wallet`, `logs`.
- **GitHub Actions CI**: build and test on push/PR; Solidity compile and tests.

### Changed
- Broadcast publish uses result's `publicQuads` so private triples are not re-sent over gossip.
- Agent supports `listenHost` for binding to a specific interface (e.g. 127.0.0.1 in tests).
