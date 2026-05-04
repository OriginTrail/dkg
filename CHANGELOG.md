# Changelog

All notable changes to the DKG V9 node are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **CLI**: `dkg init`, `start`, `stop`, `status`, `peers`, `publish`, `query`, `query-remote`, `subscribe`, `paranet create/list/info`, `set-ask`, `wallet`, `logs`.
- **GitHub Actions CI**: build and test on push/PR; Solidity compile and tests.

### Changed
- Broadcast publish uses result's `publicQuads` so private triples are not re-sent over gossip.
- Agent supports `listenHost` for binding to a specific interface (e.g. 127.0.0.1 in tests).
