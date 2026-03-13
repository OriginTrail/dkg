# Changelog

All notable changes to the DKG V9 node are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- (Changes go here for the next release.)

### Changed
- (Optional.)

### Fixed
- (Optional.)

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

[Unreleased]: https://github.com/OriginTrail/dkg-v9/compare/v9.0.0...HEAD
[9.0.0]: https://github.com/OriginTrail/dkg-v9/releases/tag/v9.0.0
