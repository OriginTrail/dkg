# DKG V9 Architecture Feedback

> Audience: architecture owner and contributors
> Last updated: 2026-03-04
> Scope: architecture and package-level issues to resolve early

Severity scale used here: High (security/correctness/operational risk), Medium (design debt with meaningful impact), Low (quality improvement).

## Executive Summary

- The three biggest problems are clear: publish recovery after restart, query access being too open by default, and recurring merge conflicts in large integration files.
- Updatability is now a core requirement: if this repo will be upstream for many implementations, we need version-bump upgrades, not manual fork merges.
- Today the architecture still pushes teams toward custom glue and hotspot edits, which is exactly what creates long-lived fork pain.
- Plugin support exists in parts, but there is no full plugin runtime yet (dependency ordering, lifecycle, collision checks).
- Product behavior is also confusing in a few places (`tentative` vs `confirmed`, and JSON-LD support expectations).
- Recommended order: first lock reliability and security defaults, then lock the no-fork extension/update model.

## Priority Now (Top Issues)

1. `I-011` - reliability ownership in queueless mode
2. `I-012` - merge hotspots in `dkg-agent.ts` and `daemon.ts`
3. `I-018` - full-monorepo fork model does not scale
4. `I-013` - unclear extension governance (core vs plugin vs adapter)
5. `I-017` - missing plugin runtime for dependency/lifecycle/collision control
6. `I-001` - publish state loss on restart
7. `I-004` + `I-009` - query exposure and scope bypass risk

Issue IDs stay stable on purpose, so references do not break.

## Risk Heatmap

| Area | Risk | Severity | Linked items |
|---|---|---|---|
| Merge conflicts | `dkg-agent.ts` and `daemon.ts` are hotspots for parallel work | High | I-012 |
| Updatability model | Forking the full monorepo does not scale for upstream updates | High | I-018 |
| Reliability contract | Queueless mode has no clear ownership for retries/finality checks | High | I-011 |
| Extension rules | Upstreaming and extension boundaries are not explicit | High | I-013 |
| Plugin runtime | No first-class plugin kernel yet | High | I-017 |
| Publish recovery | In-flight publish state is lost on restart | High | I-001 |
| Query exposure | Remote queries are too open by default and can bypass graph limits | High | I-004, I-009 |
| Signature trust | Receiver signature flow is unclear and effectively self-attested | High | I-003 |
| Access checks | Private access verification is incomplete | High | I-005 |
| Update safety | Daemon auto-update can hard reset local state | High | I-006 |
| Secrets | Keys/tokens are stored as plaintext on disk | Medium | I-007 |
| Query architecture | Query handler depends on a concrete class | Medium | I-008 |
| Publish UX | `tentative` can be mistaken for final success | Medium | I-010 |
| JSON-LD UX | `.jsonld` is advertised but full JSON-LD is not supported | Medium | I-014 |
| Embedded parity | Embedded mode has no standard optional API/UI bridge | Medium | I-015 |
| Adapter consistency | Framework adapters duplicate capability wiring | Medium | I-016 |

## Quick Clarifications (Requested)

- `I-002`: same publish data can pass through different validation levels depending on entry path.
- `I-003`: receiver approval is represented in a way that can currently be produced by publisher flow.
- `I-005`: private-access verification path is partially implemented.
- `I-008`: query handler is hard-wired to one engine class, so swapping/testing is harder.
- `I-009`: specific SPARQL shapes can bypass intended paranet query limits.

## Issue Register

### I-001 - No durable crash recovery for in-flight operations
- Severity: High
- What is happening: in-flight publish state is kept in memory (`pendingPublishes`) and not restored after restart.
- Why it matters: a restart can lose publish progress.
- Decision option A (keep this design): make user-owned retries explicit, document it as a product contract, and expose clear status/finality APIs.
- Decision option B (change, recommended): add a durable publish journal + startup reconciliation.
- Evidence: `packages/publisher/src/publish-handler.ts:50`, `packages/publisher/src/publish-handler.ts:288`.

### I-002 - Gossip ingestion path diverges from strict publish validation path
- Severity: High
- What is happening: one ingest path stores gossip payloads directly, while another path uses stricter checks.
- Why it matters: the same data can be accepted/rejected differently depending on route.
- Decision option A (keep this design): mark gossip ingest as trusted/internal only and block it for untrusted peers.
- Decision option B (change, recommended): use one shared validation pipeline for all publish ingress paths.
- Evidence: `packages/agent/src/dkg-agent.ts:771`, `packages/agent/src/dkg-agent.ts:811`, `packages/publisher/src/publish-handler.ts:195`, `packages/publisher/src/publish-handler.ts:240`.

### I-003 - Receiver-signature semantics are effectively self-attested in publisher path
- Severity: High
- What is happening: publisher signs and submits data that is labeled like receiver signatures.
- Why it matters: trust semantics are unclear and audit confidence drops.
- Decision option A (keep this design): rename and document the model as explicit single-signer attestation.
- Decision option B (change, recommended): collect real receiver signatures before chain finalization.
- Evidence: `packages/publisher/src/dkg-publisher.ts:398`, `packages/publisher/src/dkg-publisher.ts:419`.

### I-004 - Remote query default posture is permissive
- Severity: High
- What is happening: if `queryAccess` is not set, default policy is `public`.
- Why it matters: operators can expose data by accident.
- Decision option A (keep this design): keep public default only for explicit dev profile and warn loudly at startup.
- Decision option B (change, recommended): switch to deny-by-default and require explicit allow rules.
- Evidence: `packages/agent/src/dkg-agent.ts:236`, `packages/query/src/query-handler.ts:120`.

### I-005 - Access protocol verification is incomplete
- Severity: High
- What is happening: requester signature/payment checks are still partial.
- Why it matters: private data controls are weaker than expected.
- Decision option A (keep this design): keep feature marked experimental and off by default in production.
- Decision option B (change, recommended): finish requester signature + payment verification before production use.
- Evidence: `packages/publisher/src/access-handler.ts:67`.

### I-006 - Auto-update uses destructive `git reset --hard` in daemon flow
- Severity: High
- What is happening: daemon update flow uses `git reset --hard` during update/rollback.
- Why it matters: local changes can be lost and updates are risky.
- Decision option A (keep this design): allow only in local/dev mode behind explicit dangerous flag.
- Decision option B (change, recommended): move to release artifact updates with safe rollback.
- Evidence: `packages/cli/src/daemon.ts:913`, `packages/cli/src/daemon.ts:925`.

### I-007 - Secrets are stored plaintext on disk
- Severity: Medium
- What is happening: keys and tokens are stored unencrypted.
- Why it matters: host compromise immediately exposes secrets.
- Decision option A (keep this design): dev-only profile with strict host hardening and explicit risk notice.
- Decision option B (change, recommended): add encryption-at-rest and key rotation procedures.
- Evidence: `packages/agent/src/agent-wallet.ts:73`, `packages/agent/src/op-wallets.ts:46`, `packages/cli/src/auth.ts:70`.

### I-008 - Query handler is tightly coupled to concrete query engine class
- Severity: Medium
- What is happening: `QueryHandler` depends on `DKGQueryEngine` directly.
- Why it matters: harder to swap/test implementations.
- Decision option A (keep this design): keep as-is short term if only one engine is expected.
- Decision option B (change, recommended): depend on `QueryEngine` interface in constructor.
- Evidence: `packages/query/src/query-handler.ts:4`, `packages/query/src/query-engine.ts:17`.

### I-009 - Paranet scoping can be bypassed by explicit SPARQL shape
- Severity: High
- What is happening: current wrapper is skipped in some SPARQL shapes (`FROM`/`GRAPH`).
- Why it matters: remote queries may read more than intended.
- Decision option A (keep this design): disable remote SPARQL by default until stricter controls are added.
- Decision option B (change, recommended): enforce graph scope in policy/parser, not only wrapper logic.
- Evidence: `packages/query/src/dkg-query-engine.ts:30`, `packages/query/src/dkg-query-engine.ts:140`, `packages/query/src/query-handler.ts:103`.

### I-010 - Tentative vs confirmed lifecycle is easy to misinterpret in UX
- Severity: Medium
- What is happening: publish can return `tentative`, and tentative data may expire.
- Why it matters: users can think publish is done when it is not.
- Decision option A (keep this design): keep lifecycle as-is, but clearly label tentative everywhere.
- Decision option B (change, recommended): add explicit finality states with next-step guidance in CLI/API/UI.
- Evidence: `packages/publisher/src/dkg-publisher.ts:359`, `packages/publisher/src/publish-handler.ts:283`.

### I-011 - Queueless mode lacks explicit reliability ownership contract
- Severity: High
- What is happening: there is no clear contract for retries/timeouts/finality checks in queueless mode.
- Why it matters: each integrator handles failures differently.
- Decision option A (keep this design): keep queueless model, but make user-owned retryability explicit and testable.
- Decision option B (change, recommended): add platform-side durability (journal/queue) to reduce client burden.
- Evidence: `packages/publisher/src/dkg-publisher.ts:359`, `packages/publisher/src/publish-handler.ts:283`, `packages/cli/src/daemon.ts:535`.

### I-012 - Core integration files are merge-conflict hotspots
- Severity: High
- What is happening: too much orchestration lives in `dkg-agent.ts` and `daemon.ts`.
- Why it matters: parallel work collides and merges are slow/risky.
- Decision option A (keep this design): keep file structure short term, but enforce strict code ownership and change windows.
- Decision option B (change, recommended): split into smaller modules and keep top-level files thin.
- Evidence: `packages/agent/src/dkg-agent.ts:216`, `packages/agent/src/dkg-agent.ts:764`, `packages/cli/src/daemon.ts:401`.

### I-013 - Extensibility seams exist, but upstreaming and interface strategy are under-specified
- Severity: High
- What is happening: extension points exist, but rules are unclear for what stays core and what moves to shared plugins.
- Why it matters: teams patch core files for project needs and create more merge conflicts.
- Decision option A (keep this design): keep ad-hoc extension rules while team is small and centralized.
- Decision option B (change, recommended): define a 3-tier model: immutable core, reusable plugins, thin adapters.
- Evidence: `packages/storage/src/triple-store.ts:62`, `packages/agent/src/dkg-agent.ts:59`, `packages/adapter-openclaw/src/DkgNodePlugin.ts:17`, `README.md:250`.

### I-014 - JSON-LD support is advertised but not fully implemented in CLI ingest
- Severity: Medium
- What is happening: `.jsonld` is listed, but true JSON-LD (`@context`) is not handled.
- Why it matters: users get confusing behavior and parser errors.
- Decision option A (keep this design): narrow docs/flags now to currently supported formats only.
- Decision option B (change, recommended): implement full JSON-LD transformation support.
- Evidence: `packages/cli/src/cli.ts:437`, `packages/cli/src/rdf-parser.ts:58`, `packages/cli/src/rdf-parser.ts:71`, `packages/cli/package.json:14`.

### I-015 - Embedded mode does not have a standard optional API/UI bridge
- Severity: Medium
- What is happening: daemon mode has `/api/*`; embedded mode usually does not.
- Why it matters: teams rebuild similar API/UI glue in each integration.
- Decision option A (keep this design): keep embedded mode direct-call only and treat UI/API as optional custom work.
- Decision option B (change, recommended): define one optional embedded API bridge profile for reuse.
- Evidence: `packages/cli/src/daemon.ts:326`, `packages/adapter-openclaw/src/DkgNodePlugin.ts:67`, `packages/adapter-elizaos/src/service.ts:44`.

### I-016 - Framework adapters duplicate capability wiring without shared contract
- Severity: Medium
- What is happening: OpenClaw and Eliza adapters map similar features independently.
- Why it matters: behavior drifts and fixes must be repeated.
- Decision option A (keep this design): keep separate mappings while adapter count is low.
- Decision option B (change, recommended): define a minimal shared adapter contract and keep wrappers thin.
- Evidence: `packages/adapter-openclaw/src/DkgNodePlugin.ts:87`, `packages/adapter-openclaw/src/types.ts:9`, `packages/adapter-elizaos/src/actions.ts:14`, `packages/adapter-elizaos/src/types.ts:34`.

### I-017 - No first-class plugin kernel for large-scale extension governance
- Severity: High
- What is happening: there is no full plugin runtime (manifest/deps/lifecycle/collision checks).
- Why it matters: extension becomes ad-hoc as ecosystem grows.
- Decision option A (keep this design): keep explicit registration model while ecosystem is small.
- Decision option B (change, recommended): add a plugin kernel on top of `@dkg/agent` with explicit activation and checks.
- Evidence: `packages/agent/src/dkg-agent.ts:46`, `packages/agent/src/dkg-agent.ts:305`, `packages/adapter-openclaw/src/DkgNodePlugin.ts:32`, `packages/storage/src/triple-store.ts:62`.

### I-018 - Forking the full monorepo is not a scalable implementation model
- Severity: High
- What is happening: implementations fork the whole monorepo and edit hotspot files.
- Why it matters: upstream updates become expensive and merge conflicts grow.
- Decision option A (keep this design): allow forks only for short-lived prototypes with strict rebase windows.
- Decision option B (change, recommended): move to package-consumption model (implementation repo + config + plugins), and treat full forks as last resort.
- Evidence: `package.json:1`, `pnpm-workspace.yaml:1`, `packages/agent/src/dkg-agent.ts:216`, `packages/cli/src/daemon.ts:401`.

## Decision Asks for Architecture Owner

### D-001 - Receiver attestation model
- Decide whether receiver signatures are truly multi-party trust evidence or a simplified publisher-only attestation in current V9 scope.

### D-002 - Query security baseline
- Decide and codify deny-by-default policy and strict graph-scope enforcement rules for remote SPARQL.

### D-003 - Durability target for V9
- Decide minimum acceptable crash-recovery guarantee (none vs lightweight journal vs queue-backed orchestration).

### D-004 - Product operating model for non-technical users
- Decide target model: self-hosted nodes, managed hosted nodes, or hybrid.

### D-005 - Auto-update policy
- Decide whether daemon-level git-based updater remains supported or is replaced by release artifact updater.

### D-006 - Economy feature scope and sequencing
- Decide timeline and ownership for FairSwap/conviction/rewards integration (interface is present; runtime support is partial).

### D-007 - Chain strategy
- Decide whether Base-only is an intentional phase gate or if multi-chain parity (for example Gnosis) is required near-term.

### D-008 - Monorepo shared-utils governance
- Decide extraction policy for cross-package utilities (trigger threshold, ownership, versioning discipline).

### D-009 - Reliability ownership model for queueless operation
- Decide explicit boundary: what the platform guarantees vs what clients must handle (retries, timeouts, confirmation polling, duplicate handling).

### D-010 - Refactor policy for integration hotspots
- Decide whether to proactively decompose `dkg-agent.ts`/`daemon.ts` now to reduce recurring merge conflicts before feature growth accelerates.

### D-011 - Extensibility governance model
- Decide and document the official extension strategy: preferred extension seams, package ownership boundaries, and review requirements for cross-cutting changes.

### D-012 - Non-technical interface strategy (MCP vs HTTP/UI)
- Decide whether MCP is an explicit near-term product surface, deferred intentionally, or replaced by another interface path for non-technical users; if enabled, prefer a thin wrapper over existing daemon APIs.

### D-013 - Core immutability and adapter-to-core promotion policy
- Decide which core behaviors are immutable product semantics, and how capabilities proven in project/framework adapters (for example retrieval/EPCIS-like flows) are promoted into shared reusable packages.

### D-014 - RDF ingest contract
- Decide whether first-class JSON-LD `@context` ingest is required in V9; if yes, implement and test it, otherwise narrow CLI/docs contract to currently supported formats.

### D-015 - Embedded-mode API/UI bridge strategy
- Decide whether to provide an official optional API bridge for embedded agents so they can reuse Node UI/operator tooling, or intentionally keep embedded mode direct-call only.

### D-016 - Framework adapter abstraction strategy
- Decide whether to introduce a shared runtime-adapter contract for framework integrations (OpenClaw/ElizaOS/others), or intentionally keep adapters fully framework-specific.

### D-017 - Reusable extension packaging policy
- Decide explicit criteria for when functionality should be a standalone reusable package (for example graph-viz, EPCIS-like extensions) vs staying inside app-specific UI/runtime packages.

### D-018 - UI modularization strategy (avoid package sprawl)
- Decide whether to introduce a shared UI kit package for common primitives while keeping specialized engines (for example graph visualization) as separate packages.

### D-019 - Extension registration model
- Decide whether V9 keeps explicit registration/import-based extension activation only, or introduces a controlled dynamic plugin discovery model.

### D-020 - Plugin kernel strategy
- Decide whether to introduce a first-class plugin kernel (manifest metadata, dependency ordering, lifecycle hooks, collision checks) on top of `@dkg/agent` for implementation-level extensibility.

### D-021 - Pluggable capability boundary
- Decide which capabilities are immutable core semantics vs pluggable provider interfaces (for example retrieval, indexing, policy) so extension does not mutate core guarantees.

### D-022 - Instance customization policy (no-fork path)
- Decide the official customization ladder for implementers: config overrides first, wrapper plugins second, alternative provider plugins third, and core patching as last resort.

### D-023 - Distribution model for implementations
- Decide the standard model for future implementations: package consumption with version bumps (recommended) vs full monorepo forks (exception-only).

### D-024 - Upstream learning loop (dev -> validate -> release)
- This is one possible workflow option (not the only valid one): local linking/tarball test -> pre-release -> validation in reference implementation -> stable release, without editing `node_modules`.

### I-019 - OpenClaw adapter missing paranet discovery tool
- Severity: Medium
- What is happening: the OpenClaw adapter exposes `dkg_status`, `dkg_publish`, `dkg_query`, `dkg_find_agents`, `dkg_send_message`, and `dkg_invoke_skill`, but has no tool for discovering available paranets. The agent must know the paranet ID upfront.
- Why it matters: agents have no way to discover which paranets exist on the network before publishing or querying. This forces hardcoded paranet IDs or user intervention.
- Decision option A (keep this design): document that paranet IDs must be provided by the user or configured in advance.
- Decision option B (change, recommended): add a `dkg_list_paranets` tool that wraps the existing `DKGAgent.listParanets()` method.
- Evidence: `packages/adapter-openclaw/src/DkgNodePlugin.ts:119`, `packages/agent/src/dkg-agent.ts:1021`.

### I-020 - OpenClaw adapter plugin ID is too generic
- Severity: Low
- What is happening: the plugin manifest ID is `adapter-openclaw` (from `openclaw.plugin.json`). This appears in `plugins.entries` and `plugins.allow` as just `adapter-openclaw`.
- Why it matters: if an operator runs multiple plugins, the name does not convey that this is a DKG adapter. Could be confused with any other adapter.
- Decision option A (keep this design): keep `adapter-openclaw` while there is only one DKG plugin.
- Decision option B (change, recommended): rename to `dkg-node` or `dkg-openclaw-adapter` in the manifest ID to be self-descriptive.
- Evidence: `packages/adapter-openclaw/openclaw.plugin.json:2`.

### I-021 - Stale dist when installing adapter from local path (dev-only)
- Severity: Low
- What is happening: when installing `@dkg/adapter-openclaw` from a local monorepo path (pre-publish), the compiled `dist/` can be stale (e.g. using `handler` instead of `execute` for tool functions). This causes `tool.execute is not a function` at runtime.
- Why it matters: local development setup appears to work (plugin loads, tools register by name) but silently fails on first use. Only affects pre-publish local installs — once published to npm, `prepublishOnly` ensures fresh builds.
- Decision option A (recommended): document in README that local installs require `pnpm --filter @dkg/adapter-openclaw run build` before `npm install`. Add a `prepack` script as a safety net.
- Decision option B: no action needed if all contributors use published packages.
- Evidence: `packages/adapter-openclaw/package.json:23`.

## eval.txt Coverage (Issues and Decisions)

Only issue/decision mappings are listed here. Clarification-only mappings live in `.ai/clarifications.md`.

Additional follow-up from clarification review (not directly from `eval.txt`): `I-015`, `I-017`, `I-018`, `D-015`, `D-018`, `D-019`, `D-020`, `D-021`, `D-022`, `D-023`, `D-024`.

| eval.txt line(s) | Mapped items |
|---|---|
| 1 | I-001, I-006, I-007, I-011, I-013, I-014, D-003, D-004, D-007, D-009, D-012, D-013, D-014 |
| 3 | I-008, I-013, D-008, D-011, D-013 |
| 7 | (clarification only) |
| 9 | I-003, D-001, D-006 |
| 12 | I-004, I-009, D-002, D-006 |
| 15 | I-010 |
| 18 | (clarification only) |
| 20 | D-006 |
| 23 | D-017 |
| 26 | I-016, D-008, D-016 |
| 31 | I-001, I-003, I-010, D-001, D-003 |
| 33 | I-004, I-009, D-002 |
| 35 | (clarification only) |
| 37 | (clarification only) |
| 39 | (clarification only) |
| 42 | I-004, I-009, I-010, I-011, D-002, D-004, D-009 |
| 44 | (clarification only) |
| 47 | (clarification only) |
| 50 | I-013, D-012, D-013 |
| 58 | I-012, I-013, D-008, D-010, D-011 |
