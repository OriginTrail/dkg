import { readFile, writeFile, mkdir, symlink, rename, unlink, readlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { DKGAgentConfig } from '@origintrail-official/dkg-agent';
import {
  blueGreenSlotEntryPoint,
  blueGreenSlotReady,
  findPackageRepoDir,
  isDkgMonorepoRoot,
  resolveDkgConfigHome,
  SELECTABLE_SETUP_NETWORKS,
} from '@origintrail-official/dkg-core';
import {
  resolveStorageAckTiming,
  STORAGE_ACK_SEND_TIMEOUT_DEFAULT_MS,
  STORAGE_ACK_HANDLER_DEADLINE_DEFAULT_MS,
  STORAGE_ACK_TIMING_SAFETY_MARGIN_MS,
  type StorageAckTiming,
} from '@origintrail-official/dkg-publisher';

/**
 * Per-step build timeouts (milliseconds) used by the git-based auto-update
 * path. Slow hosts (notably ARM64 nodes compiling Solidity contracts via the
 * WASM solc fallback) can exceed the defaults; operators set overrides via
 * `~/.dkg/config.json` -> `autoUpdate.buildTimeoutMs`. All keys are optional;
 * unset keys fall back through network/<env>.json -> built-in defaults.
 */
export interface AutoUpdateBuildTimeouts {
  /** `pnpm install --frozen-lockfile` (default 180_000). */
  install?: number;
  /** `pnpm build:runtime` / `pnpm build` (default 180_000). */
  build?: number;
  /**
   * @deprecated Ignored since the auto-updater stopped invoking `hardhat
   * compile` on node hosts. Committed `packages/evm-module/abi/*.json` are
   * now the runtime contract surface, and CI enforces freshness (see
   * `abi-freshness` job in `.github/workflows/ci.yml`). The field is
   * retained on the type so existing user configs don't fail to parse.
   */
  contracts?: number;
  /** MarkItDown bundling step (default 900_000). */
  markitdown?: number;
}

export interface AutoUpdateConfig {
  enabled: boolean;
  /** Optional in ~/.dkg/config.json: omit to inherit from network/project config. */
  repo?: string;
  /** Optional in ~/.dkg/config.json: omit to inherit from network/project config. */
  branch?: string;
  /** Allow auto-updating to pre-release versions (e.g. 9.0.5-rc.1). */
  allowPrerelease?: boolean;
  /**
   * npm dist-tag this node tracks for auto-updates. When set, the updater
   * follows ONLY `dist-tags[channel]` (e.g. "testnet", "mainnet", "latest")
   * instead of the default `max(latest, dev, beta, next)`. This decouples a
   * cohort from whatever `latest` happens to point at — e.g. testnet nodes
   * pinned to `channel: "testnet"` keep tracking testnet releases even after
   * `latest` is repurposed for mainnet. Omit to keep the legacy behaviour.
   *
   * Forward-only: a node updates only when the channel's target is a HIGHER
   * semver than its current version (same gate as the default path), so
   * re-pointing a tag at a LOWER version is a no-op, not a downgrade.
   */
  channel?: string;
  /** Optional SSH private key path for git-based update fetches/clones. */
  sshKeyPath?: string;
  /** Optional raw GIT_SSH_COMMAND override for git-based update fetches/clones. */
  sshCommand?: string;
  /**
   * Optional in ~/.dkg/config.json: omit to inherit from network/project config.
   * `resolveAutoUpdateConfig()` falls back to network -> 30 (minutes).
   */
  checkIntervalMinutes?: number;
  /** Optional per-step build timeout overrides for the git-based update path. */
  buildTimeoutMs?: AutoUpdateBuildTimeouts;
  /**
   * Override how the daemon resolves "am I an npm-installed node or a
   * monorepo dev checkout?" under OT-RFC-41 §4.3 / Bundle B1d.
   *
   *   `'npm'` (recommended; default for fresh installs from rc.12+):
   *     Edge → `npm install -g`; Core → `npm install` into a
   *     blue-green slot. `dkg init` writes this value explicitly
   *     for every new node.
   *
   *   `'monorepo'`: dev checkout — auto-update polling is suppressed
   *     entirely. Contributors update via `git pull && pnpm install
   *     && pnpm build` from the repo root.
   *
   *   `'auto'` (legacy; pre-rc.12): probe the filesystem
   *     (`repoDir() === null`). Treated as `'npm'` under rc.12+ via
   *     `resolveStandaloneInstall()`.
   *
   *   `'git'` (legacy; pre-rc.12): the now-removed git-build update
   *     path. Treated as `'monorepo'` under rc.12+ (the daemon does
   *     not auto-update, no git pull/build). User-facing `dkg
   *     update` from such a config refuses to run — see OT-RFC-41
   *     §4.2 and `cli.ts dkg update`.
   *
   * Implementation: read once at boot via `resolveStandaloneInstall(source)`
   * in `daemon/state.ts`, which writes the result into the shared
   * `daemonState.standaloneCache` memo so every later caller (status
   * route, `dkg update` CLI subcommand, …) sees the same answer.
   */
  source?: 'auto' | 'npm' | 'git' | 'monorepo';
}

/**
 * AutoUpdateConfig with `repo` and `branch` guaranteed present — the shape
 * returned by `resolveAutoUpdateConfig()` after falling back through
 * ~/.dkg/config.json -> network/<env>.json -> project.json. Consumers of the
 * auto-update subsystem should accept this type, not the raw `AutoUpdateConfig`,
 * since the raw form allows `repo`/`branch` to be omitted.
 */
export type ResolvedAutoUpdateConfig = AutoUpdateConfig & {
  repo: string;
  branch: string;
  checkIntervalMinutes: number;
};

export interface NetworkConfig {
  _status?: string;
  networkName: string;
  genesisId: string;
  networkId: string;
  genesisVersion: number;
  relays: string[];
  /** V10: context graphs */
  defaultContextGraphs?: string[];
  defaultNodeRole: 'core' | 'edge';
  autoUpdate?: {
    enabled: boolean;
    repo: string;
    branch: string;
    allowPrerelease?: boolean;
    /** npm dist-tag this network's nodes track — see `AutoUpdateConfig.channel`. */
    channel?: string;
    sshKeyPath?: string;
    sshCommand?: string;
    checkIntervalMinutes: number;
    buildTimeoutMs?: AutoUpdateBuildTimeouts;
    /**
     * Network-level default for `AutoUpdateConfig.source` — see the
     * matching doc comment on that field. Lets `network/<env>.json` set the
     * recommended source policy (e.g. testnet defaulting to `'npm'` so new
     * Core operators don't have to know about the override). Local config
     * still wins per field.
     */
    source?: 'auto' | 'npm' | 'git';
  };
  chain?: {
    type: 'evm';
    rpcUrl: string;
    rpcUrls?: string[];
    /** Public RPC URLs safe to expose to browser wallets for wallet_addEthereumChain. */
    walletRpcUrls?: string[];
    hubAddress: string;
    tokenAddress?: string;
    chainId: string;
    /**
     * ContextGraphNameRegistry discovery scan `eth_getLogs` block-window.
     * Defaults to the EVM adapter's 2,000-block common provider cap.
     */
    cgRegistryScanPageSize?: number;
    /**
     * Network-level per-chain funding floors (wei). See
     * `ChainConfig.minPublisher*Wei`. Overlay JSON can only carry
     * string/number; both are normalized to bigint in `resolveChainConfig`.
     */
    minPublisherNativeWei?: bigint | string | number;
    minPublisherTracWei?: bigint | string | number;
  };
  faucet?: {
    url: string;
    mode: string;
  };
  /**
   * Maintainer-controlled marker bumped on every chain reset (e.g. testnet
   * V10 staking consolidation, fresh contract redeploy with state wipe).
   * The daemon's chain-reset-wipe hook compares this against the last value
   * persisted in `<dataDir>/.network-state.json`; on mismatch it auto-wipes
   * `store.nq` + `publish-journal.*` + `random-sampling.wal` so the node
   * boots clean against the new chain. Operators do nothing.
   *
   * Distinct from `networkId` which is a SHA256 of the bundled genesis
   * TriG and only changes when the genesis itself does — chain redeploys
   * happen far more often than that, so they need a separate marker.
   *
   * Free-form string, suggested format: `<purpose>-<yyyy-mm-dd>` (e.g.
   * `v10-rs-staking-consolidation-2026-04-30`). Maintainer bumps in the
   * same commit that captures the post-deploy state.
   */
  chainResetMarker?: string;
}

/**
 * Operator-facing config block for V10 TRAC allowance sizing. Mirrors
 * `ApprovalPolicy` from `@origintrail-official/dkg-chain` but with
 * stringly-typed numeric fields (YAML doesn't speak bigint) so YAML/JSON
 * config can express it.
 *
 * Defaults match the legacy behaviour (`mode: per-publish`); operators
 * preparing for high-volume publishing should consider `replenishing`.
 * See `packages/cli/skills/dkg-node/SKILL.md` §8 for the operator guide.
 */
export type ApprovalPolicyMode = 'per-publish' | 'replenishing' | 'unlimited';

export interface ApprovalPolicyConfig {
  /**
   * Allowance sizing strategy. Defaults to `'per-publish'`:
   *
   *   - `per-publish` — approve exactly each publish's TRAC cost (with the
   *     on-chain `1n` floor). Cheapest blast radius, most approve-gas at
   *     scale. Backward-compatible.
   *   - `replenishing` — approve a configurable ceiling (default 1000 TRAC),
   *     refill when allowance drops below `target × refillBelowFraction`
   *     (default 10%). One approve per ~9 publishes' worth of TRAC.
   *     **Recommended for mainnet.**
   *   - `unlimited` — approve `MaxUint256` once per wallet, never again.
   *     Lowest gas, widest blast radius. Use only if you trust the V10 KA
   *     contract absolutely.
   */
  mode?: ApprovalPolicyMode;
  /**
   * `replenishing` only. TRAC amount (decimal wei-TRAC string — `1000 *
   * 10^18 = '1000000000000000000000'` for 1000 TRAC) to approve up to.
   * Defaults to `'1000000000000000000000'` (1000 TRAC).
   */
  targetAllowance?: string;
  /**
   * `replenishing` only. Refill when current allowance drops below
   * `targetAllowance × refillBelowFraction`. Float between 0 and 1.
   * Defaults to `0.1` (refill at 10% remaining).
   */
  refillBelowFraction?: number;
}

export type ApprovalPolicyConfigInput = ApprovalPolicyConfig | ApprovalPolicyMode;

export interface ChainConfig {
  /** 'evm' for real blockchain, omit or 'mock' for in-memory (testing only) */
  type: 'evm' | 'mock';
  /** JSON-RPC endpoint URL */
  rpcUrl: string;
  /** Ordered JSON-RPC backup endpoints. `rpcUrl` remains the primary endpoint. */
  rpcUrls?: string[];
  /** Public RPC URLs safe to expose to browser wallets for wallet_addEthereumChain. */
  walletRpcUrls?: string[];
  /** Hub contract address */
  hubAddress: string;
  /** Optional token contract address override. When omitted, resolve from Hub.Token. */
  tokenAddress?: string;
  /** Chain identifier (e.g., 'base:84532') */
  chainId?: string;
  /**
   * Test-only: when using `type: "mock"`, force the daemon's signer address to map
   * to this identity ID so private participant flows can be exercised from black-box CLI tests.
   */
  mockIdentityId?: string;
  /**
   * V10 TRAC auto-approve policy. Controls how the adapter sizes the
   * allowance it requests from each operational signer before a publish or
   * update. The object form is preferred; a mode string shorthand is accepted
   * for compatibility. See {@link ApprovalPolicyConfig} for the modes and
   * `packages/cli/skills/dkg-node/SKILL.md` §8 for the operator guide.
   */
  approvalPolicy?: ApprovalPolicyConfigInput;
  /**
   * ContextGraphNameRegistry discovery scan `eth_getLogs` block-window.
   * Defaults to the EVM adapter's 2,000-block common provider cap.
   */
  cgRegistryScanPageSize?: number;
  /**
   * Funding floors for funding-aware operational-wallet selection (wei of the
   * native gas token / TRAC). A wallet is preferred for a publish only when its
   * native balance > `minPublisherNativeWei` AND its own-TRAC covers the publish
   * above `minPublisherTracWei`; below the floor it is deprioritized (best-funded
   * fallback still sends). Both default to `0n` (only strictly-empty wallets are
   * skipped) — per-chain non-zero native defaults are supplied by the network
   * overlay.
   *
   * Persisted config (JSON/YAML) cannot express a bigint: use a decimal wei
   * **string** (recommended — wei amounts overflow the safe number range) or an
   * integer number. `resolveChainConfig` normalizes + validates both into the
   * strict bigint that reaches `EVMAdapterConfig.minPublisher*Wei`, failing
   * fast at startup on decimals, negatives, or unsafe-precision numbers.
   */
  minPublisherNativeWei?: bigint | string | number;
  minPublisherTracWei?: bigint | string | number;
}

export type ResolvedChainConfig = Partial<
  Omit<ChainConfig, 'approvalPolicy' | 'minPublisherNativeWei' | 'minPublisherTracWei'>
> & {
  approvalPolicy?: ApprovalPolicyConfig;
  /** Normalized funding floors — always bigint past resolution. */
  minPublisherNativeWei?: bigint;
  minPublisherTracWei?: bigint;
};

export interface LargeLiteralStorageConfig {
  enabled?: boolean;
  thresholdBytes?: number;
  directory?: string;
}

export interface SharedMemoryPublicSnapshotStorageConfig {
  enabled?: boolean;
  directory?: string;
}

/** Optional LLM config for the Node UI chatbot (OpenAI-compatible API). */
export interface LlmConfig {
  /** API key (e.g. OpenAI, Anthropic, or compatible provider). */
  apiKey: string;
  /** Model name (default: gpt-4o-mini). */
  model?: string;
  /** Base URL for the API (default: https://api.openai.com/v1). */
  baseURL?: string;
}

export type LocalAgentIntegrationStatus =
  | 'disconnected'
  | 'configured'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'error';

export interface LocalAgentIntegrationCapabilities {
  localChat?: boolean;
  chatAttachments?: boolean;
  connectFromUi?: boolean;
  installNode?: boolean;
  dkgPrimaryMemory?: boolean;
  wmImportPipeline?: boolean;
  nodeServedSkill?: boolean;
}

export interface LocalAgentIntegrationTransport {
  kind?: string;
  bridgeUrl?: string;
  gatewayUrl?: string;
  healthUrl?: string;
}

export interface LocalAgentIntegrationManifest {
  packageName?: string;
  version?: string;
  setupEntry?: string;
}

export interface LocalAgentIntegrationRuntime {
  status?: LocalAgentIntegrationStatus;
  ready?: boolean;
  lastError?: string | null;
  updatedAt?: string;
}

/**
 * Inbound chat authorisation policy. Layered on top of the existing
 * Ed25519 signature check on every libp2p chat message — this controls
 * *which* authenticated peers we're willing to talk to, not *whether*
 * they're authenticated.
 *
 * Modes:
 *   - `any` — accept all authenticated peers (legacy behaviour). Only
 *     appropriate on a closed dev network where every peer is trusted.
 *   - `peer-allowlist` — only accept peerIds listed in `peerAllowlist`.
 *     Strongest, also most manual.
 *   - `scoped` (recommended Phase 1 default) — only accept peers whose
 *     node-principal is an `active` member of `contextGraphId`. Requires
 *     `contextGraphId` to be set; if it isn't, all inbound chats are
 *     rejected (fail-closed).
 *   - `shared-context-graph` — accept any peer that's an active
 *     node-member of at least one CG this node is also subscribed to.
 *     More flexible than `scoped`; less strict.
 *
 * Loopback (a node chatting itself) is always accepted, regardless of
 * mode — useful for local CLI testing and for the daemon's own
 * outbound→inbound debugging shortcuts.
 */
export type ChatAclMode = 'any' | 'peer-allowlist' | 'scoped' | 'shared-context-graph';

export interface ChatAclConfig {
  mode?: ChatAclMode;
  /** Required when `mode: 'scoped'`. */
  contextGraphId?: string;
  /** Required when `mode: 'peer-allowlist'`. */
  peerAllowlist?: string[];
}

export interface ChatConfig {
  /** Inbound chat authorisation policy. See {@link ChatAclConfig}. */
  acl?: ChatAclConfig;
}

export interface LocalAgentIntegrationConfig {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  transport?: LocalAgentIntegrationTransport;
  capabilities?: LocalAgentIntegrationCapabilities;
  manifest?: LocalAgentIntegrationManifest;
  setupEntry?: string;
  metadata?: Record<string, unknown>;
  runtime?: LocalAgentIntegrationRuntime;
  connectedAt?: string;
  updatedAt?: string;
}

export interface QueryAccessConfig {
  defaultPolicy: 'deny' | 'public';
  contextGraphs?: Record<string, {
    policy: 'deny' | 'public' | 'allowList';
    allowedPeers?: string[];
    allowedLookupTypes?: Array<'ENTITY_BY_UAL' | 'ENTITIES_BY_TYPE' | 'ENTITY_TRIPLES' | 'SPARQL_QUERY'>;
    sparqlEnabled?: boolean;
    sparqlTimeout?: number;
    sparqlMaxResults?: number;
  }>;
  rateLimitPerMinute?: number;
}

export interface GraphSetIndexConfig {
  enabled?: boolean;
  /** Revalidate the named-graph index after this many milliseconds. 0 means every read. */
  revalidateMs?: number;
}

export interface LoggingConfig {
  /** Emit detailed KA publish lifecycle logs. Default: false. */
  kaPublishLifecycleDebug?: boolean;
}

export interface DkgConfig {
  name: string;
  /**
   * Selects which bundled network/<name>.json overlay this node should use.
   * When omitted, runtime falls back to project.json#defaultNetwork.
   */
  networkConfig?: string;
  relay?: string;
  apiPort: number;
  /** Host to bind the API server (default '127.0.0.1', use '0.0.0.0' for external access). */
  apiHost?: string;
  listenPort: number;
  nodeRole: 'core' | 'edge';
  /**
   * Core-Node-specific operator tuning. Today only `allowDegradedRelay`;
   * future Core-only knobs (e.g. relay-target prioritisation) belong here
   * rather than at the top level so they stay grouped.
   */
  core?: {
    /**
     * Gate for the boot-time core-relay sanity check (`core-prereq-check.ts`).
     *
     *   - `true` (default): the daemon logs `[CORE-PREREQ] looks degraded`
     *     with a structured reason if its bound multiaddrs can't serve
     *     inbound traffic, but boots normally. Backwards-compatible — no
     *     behaviour change for any existing operator on this PR.
     *   - `false`: the daemon refuses to boot if the sanity check says
     *     degraded. Opt-in for operators who want fail-loud semantics
     *     instead of warn-and-continue.
     *
     * Edge nodes ignore this field — the prereq check skips the degraded
     * verdict for `nodeRole: 'edge'`.
     */
    allowDegradedRelay?: boolean;
  };
  /**
   * Core Node relay-server capacity tuning. Forwarded into the libp2p
   * relay configuration via `DKGNodeConfig.relayServerCapacity`. Sets
   * the maximum number of simultaneous circuit-relay v2 reservations
   * this node will hold; HOP/STOP stream caps and
   * `connectionManager.maxConnections` are derived at a 1:2 ratio
   * (capacity=1024 → 2048 streams + 2048 max conns).
   *
   * Default: 1024 when omitted on a Core Node. Ignored on edge nodes
   * (with a startup warning if set there). Invalid values (0,
   * negative, fractional, NaN) fall back to the default with a
   * warning. See packages/core/src/types.ts and packages/cli/README.md
   * for the full rationale + ulimit -n requirements.
   */
  relayServerCapacity?: number;
  /**
   * Number of relay reservations to hold in parallel when behind NAT.
   * Forwarded into `DKGNodeConfig.relayReservationCount`. Defaults to 3
   * when relayPeers are configured (N-2 tolerance to relay blackouts).
   * Capped at 16. Ignored (with a warning when set explicitly) in two
   * cases: no relayPeers configured, or the node itself runs a relay
   * server (core / `enableRelayServer: true` — relay servers don't
   * multi-reserve through other relays). Invalid values
   * (0/neg/NaN/fractional/non-numeric/over-cap) fall back to the
   * default with a warning. See packages/core/src/types.ts for the
   * full rationale.
   */
  relayReservationCount?: number;
  /**
   * Operator-preferred relay multiaddrs that take priority over the
   * network/<env>.json public relay set (rc.9 PR-7).
   *
   * When set, these multiaddrs are prepended to the active relayPeers
   * list at daemon startup so libp2p attempts reservations on them
   * first. The public testnet relays remain configured as fallback —
   * if an operator-relay disappears, the node continues to function
   * via the public set. Repeatable; populate from CLI via
   * `dkg start --relay-preferred <multiaddr>` (sets env var
   * `DKG_RELAY_PREFERRED` for the spawned daemon, comma-separated)
   * or write into `~/.dkg/config.json` for persistence.
   *
   * See `docs/messenger-operator.md` for the relay-setup playbook
   * (standing up a relay VM, sharing multiaddrs, monitoring).
   */
  preferredRelays?: string[];
  /** Public multiaddrs to announce (for VPS/cloud nodes where the public IP is not on the interface). */
  announceAddresses?: string[];
  /** Bootstrap peer multiaddrs to connect to on startup (for direct peer discovery without relay). */
  bootstrapPeers?: string[];
  /** V10: context graphs to subscribe. */
  contextGraphs?: string[];
  /** Local daemon logging controls. */
  logging?: LoggingConfig;
  /** Cross-agent query access policy for inbound query-remote requests. */
  queryAccess?: QueryAccessConfig;
  autoUpdate?: AutoUpdateConfig;
  /**
   * Chain config. Field-merged on top of `network/<env>.json#chain` via
   * `resolveChainConfig()`, so an operator can override individual fields
   * (e.g. just `rpcUrl` to point at a private RPC) without having to
   * restate `hubAddress` and `chainId`. Fields omitted here inherit the
   * network defaults — including future hub rotations propagated by the
   * auto-updater pulling a fresh network/<env>.json.
   */
  chain?: Partial<ChainConfig>;
  /** Optional LLM for the Node UI chatbot (natural language → SPARQL, answers). */
  llm?: LlmConfig;
  /** Block explorer URL for TX links (default: derived from chainId). */
  blockExplorerUrl?: string;
  /** Triple store backend override (default: oxigraph-worker with file persistence). */
  store?: { backend: string; options?: Record<string, unknown>; graphSetIndex?: boolean | GraphSetIndexConfig };
  /**
   * Intentional cap on how many persisted context-graph subscriptions a node
   * ACTIVATES on boot (gossip + sync). A large stale backlog otherwise fans out
   * store work and starves authenticated routes (#997). coreHosted graphs are
   * always restored regardless of this cap. Rows beyond the cap stay persisted
   * and are reported by GET /api/context-graph/subscriptions. Non-negative
   * integer; 0 = no cap. Raise it on nodes that legitimately subscribe to more
   * than the default (64).
   */
  maxRehydratedContextGraphSubscriptions?: number;
  /** Out-of-line storage for large public SWM RDF literal object terms. */
  largeLiteralStorage?: LargeLiteralStorageConfig;
  /** Out-of-line storage for immutable public SWM operation snapshots. */
  sharedMemoryPublicSnapshotStorage?: SharedMemoryPublicSnapshotStorageConfig;
  /** Disable expensive peer-connect SWM catch-up for bulk benchmark/devnet runs. */
  syncSharedMemoryOnConnect?: boolean;
  /** Emergency switch for the periodic sync reconciler. Env DKG_SYNC_RECONCILER_ENABLED wins. */
  syncReconcilerEnabled?: boolean;
  /** Emergency switch for all peer-connect sync triggers. Env DKG_SYNC_ON_CONNECT_ENABLED wins. */
  syncOnConnectEnabled?: boolean;
  /** Emergency switch for durable/SWM sync execution. Env DKG_DURABLE_SYNC_ENABLED wins. */
  durableSyncEnabled?: boolean;
  /** Global cap for concurrent sync jobs. Env DKG_SYNC_GLOBAL_MAX_INFLIGHT wins. */
  syncGlobalMaxInflight?: number;
  /** StorageACK handler deadline override in milliseconds. Env DKG_STORAGE_ACK_HANDLER_DEADLINE_MS wins. */
  storageAckHandlerDeadlineMs?: number;
  /**
   * STRICT curator-ack gate (OT-RFC-49 curator-leader), default OFF. When true,
   * a non-`localOnly` write to a PRIVATE context graph must be applied+ack'd by
   * the CG's curator before it commits locally; an unconfirmed write is rejected
   * (HTTP 503) and not persisted, closing the silent same-root-update loss.
   * Public CGs / `localOnly` / a node that IS the curator are unaffected.
   */
  swmAwaitCuratorAck?: boolean;
  /**
   * Durable sync of the system `did:dkg:context-graph:agents/_meta` graph.
   * Defaults to OFF on every node role, cores included: `agents/_meta` is
   * bloated KA/KC lifecycle metadata with no cross-node consumer and was a hot
   * contributor to the mainnet sync-retry storm. Set this to `true` (or export
   * `DKG_SYNC_AGENTS_META=1`) to re-enable fetching it. The `agents` DATA graph
   * (the peer phonebook) is always synced regardless of this flag.
   *
   * NOTE: this flag is read once at daemon construction (restart required to
   * change it). Re-enabling fetch on ONE node is not enough on its own — serving
   * cores withhold `agents/_meta` by default too, so a re-enabled fetcher still
   * receives empty pages unless the serving cores also set
   * `DKG_SERVE_AGENTS_META=1` (that serve switch IS runtime-hot, no restart).
   */
  syncAgentsMeta?: boolean;
  /**
   * Generic local agent integration registry used by node-owned connect/install
   * flows. Framework-specific bridges (OpenClaw now, Hermes next) should store
   * status/capabilities here instead of relying on one-off config flags.
   */
  localAgentIntegrations?: Record<string, LocalAgentIntegrationConfig>;
  /**
   * API authentication. When enabled, all non-public endpoints require
   * a Bearer token in the Authorization header. A token is auto-generated
   * on first start and stored in `<DKG_HOME>/auth.token`.
   */
  auth?: { enabled?: boolean; tokens?: string[] };
  /**
   * Opt-in telemetry streaming to a central network dashboard.
   * `enabled` is the master gate: when false, NOTHING is forwarded off the
   * node (local logging — SQLite + daemon.log — is always on regardless).
   */
  telemetry?: {
    enabled?: boolean;
    /**
     * Remote log forwarding (opt-in). Active only when `enabled` is true.
     */
    logs?: {
      /**
       * Outbound transport for logs. 'none' = local only; 'otlp' = OTLP/HTTP
       * to an OpenTelemetry collector; 'syslog' = legacy RFC 5424 → Graylog.
       * Defaults to 'syslog' when unset (preserves prior behaviour).
       */
      exporter?: 'none' | 'otlp' | 'syslog';
      /**
       * OTLP/HTTP logs endpoint, e.g. http://localhost:4318/v1/logs. Falls
       * back to the per-network default (TELEMETRY_ENDPOINTS[network].otlpLogs).
       */
      endpoint?: string;
      /** Bearer credential for the operator's collector. Treated as a secret. */
      token?: string;
      /** Minimum level forwarded remotely. Local sink keeps everything. Default 'info'. */
      level?: 'debug' | 'info' | 'warn' | 'error';
      /** Extra sensitive key names to redact from messages before they leave the node. */
      redact?: string[];
      /** Bounded in-memory buffer; drop-oldest on overflow. Default 500. */
      bufferMaxEntries?: number;
    };
    /**
     * OTel trace export (opt-in, independent of logs). Registers the tracer
     * ONLY when an endpoint resolves (config or OTEL_EXPORTER_OTLP_* env);
     * never falls back to a guessed prod URL.
     */
    traces?: {
      enabled?: boolean;
      /** OTLP traces endpoint, e.g. http://localhost:4318/v1/traces. */
      endpoint?: string;
      /** Bearer credential. Treated as a secret. */
      token?: string;
      /** Parent-based ratio sampler 0..1. Default 1.0. */
      sampleRatio?: number;
    };
    /**
     * OTel metric export (opt-in, independent of logs). Registers the meter
     * ONLY when an endpoint resolves (config or OTEL_EXPORTER_OTLP_* env).
     */
    metrics?: {
      enabled?: boolean;
      /** OTLP metrics endpoint, e.g. http://localhost:4318/v1/metrics. */
      endpoint?: string;
      /** Bearer credential. Treated as a secret. */
      token?: string;
      /** PeriodicExportingMetricReader interval. Default 30000ms. */
      exportIntervalMs?: number;
    };
  };
  /** Shared memory (workspace) data TTL in milliseconds. Default: 30 days (2592000000). Set to 0 to disable cleanup. */
  sharedMemoryTtlMs?: number;
  /** @deprecated Legacy alias for sharedMemoryTtlMs */
  workspaceTtlMs?: number;
  /** EPCIS plugin config. When set, POST /api/epcis/capture is enabled. */
  epcis?: { contextGraphId?: string };
  /**
   * Per-KA metadata writer tuning (RFC ka-metadata-trim Phase 3).
   */
  metadata?: {
    /**
     * P3.3 — write per-transition PROV event nodes (`dkg:AssertionCreated` /
     * `dkg:AssertionPromoted` activities) into `_meta`. Default `true`.
     * Set `false` ("lite mode") on high-throughput publishers / core nodes
     * to skip the event rows: the seal, state and identity rows on the
     * lifecycle subject are ALWAYS written regardless, and the history API
     * simply returns `events: []` for ranges published while disabled.
     */
    provenanceEvents?: boolean;
  };
  /** Async publisher runtime options. */
  publisher?: {
    enabled?: boolean;
    pollIntervalMs?: number;
    errorBackoffMs?: number;
    maxRetries?: number;
  };
  /**
   * Async promote queue worker (WM → SWM). Unlike `publisher` which is
   * opt-in, the promote worker is **on by default** — without it, jobs
   * enqueued via `POST /api/knowledge-assets/{name}/swm/share-async` sit in
   * `queued` forever. Set `enabled: false` to disable when running a
   * read-only / forensic node where you don't want the worker mutating
   * SWM. See `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md` and the
   * `dkg-node` skill (§8 "Async promote queue") for the full contract.
   */
  promoteQueue?: {
    /** Default `true`. Set `false` to disable the in-daemon worker. */
    enabled?: boolean;
    /** Default 4. Number of concurrent worker slots polling the queue. */
    workerConcurrency?: number;
    /** Default 100ms. Polling interval per slot. */
    pollIntervalMs?: number;
    /** Default 60_000ms (1 min). Must be >0 and shorter than the queue's 5-min lease when enabled. */
    heartbeatIntervalMs?: number;
    /** Default 30_000ms. Max time `stop()` waits for in-flight promotes to drain on shutdown. */
    shutdownTimeoutMs?: number;
  };
  /** Allowed CORS origins. Defaults to '*' when apiHost is '127.0.0.1', otherwise restrictive. */
  corsOrigins?: string | string[];
  /** HTTP rate limiting settings. */
  rateLimit?: { requestsPerMinute?: number; exempt?: string[] };
  /**
   * Max concurrent in-flight HTTP requests before the daemon sheds load with
   * 503 (admission control, IP-agnostic). `<= 0` disables. Overridden by the
   * `DKG_MAX_INFLIGHT` env var. Defaults to 64.
   */
  maxInFlightRequests?: number;
  /**
   * Max simultaneous TCP connections the HTTP server will accept. Overridden by
   * the `DKG_MAX_CONNECTIONS` env var. Defaults to 256.
   */
  maxConnections?: number;
  /**
   * C1: StorageACK timing tunables. Resolved by `resolveStorageAckTiming()` so
   * defaults, partial overrides, and the handler-vs-send safety margin are
   * enforced at the CLI config boundary before daemon/agent wiring consumes it.
   */
  storageAck?: {
    handlerDeadlineMs?: number;
    sendTimeoutMs?: number;
  };
  /**
   * V10 Random Sampling prover (core-only). When the node is `core`
   * AND has an on-chain identity, the agent automatically schedules
   * `RandomSamplingProver.tick()` on `tickIntervalMs`. Edge nodes
   * ignore this block. See `dkg-random-sampling` for the prover
   * itself; the bind layer is in `dkg-agent/random-sampling-bind.ts`.
   */
  randomSampling?: {
    /**
     * Persistent WAL path. When set, prover state transitions are
     * appended to this file (JSONL, fsync per write) for crash
     * recovery + `dkg rs wal-tail`. When unset, the prover uses an
     * in-memory WAL (test/dev only — production SHOULD set this).
     */
    walPath?: string;
    /**
     * Tick cadence in ms. Default 30_000. Set lower (e.g. 5_000) for
     * devnet smoke tests where you want the prover to react quickly
     * after a publish lands. The orchestrator is idempotent under
     * fast double-ticks (already-solved short-circuit).
     */
    tickIntervalMs?: number;
    /**
     * Default true on core. When false, the V10 Merkle build runs on
     * the agent's main thread. Useful in tests where spawning a
     * worker is undesirable.
     */
    useWorkerThread?: boolean;
  };
  /**
   * RFC 04 v0.3 / Issue #461 — opt this node into the Network State
   * Registry as a circuit-relay provider. When true, the daemon flips
   * the on-chain `relayCapable` flag on the node's profile so other
   * peers can resolve it as a candidate relay during the chain-driven
   * NetworkStateRegistry rollout (Phase 2+ via attestation KCs).
   *
   * Multiaddrs themselves are NOT published to chain via Profile
   * (RFC 04 §5.2 — they live in per-RS-round attestation KCs). This
   * flag is the operator's "I intend to run as a relay" hint that
   * gates whether they bother running the attestation cosig + submit
   * pipeline at all.
   *
   * Tri-state semantics on startup (Codex PR #506 fix):
   *   - true      → daemon ensures on-chain flag is true
   *   - false     → daemon ensures on-chain flag is false (actively
   *                 clears any stale prior opt-in)
   *   - undefined → daemon does not touch the on-chain flag, preserving
   *                 any manual `dkg admin set-relay-capable` flips
   *
   * Default: undefined (i.e. no chain interaction unless the operator
   * has set this explicitly in config). For a fresh node this is
   * equivalent to relay-incapable.
   */
  relayCapable?: boolean;
  /**
   * Agent-to-agent chat settings. Phase 1 (RFC: agent debug chat) only
   * uses the `acl` block, which controls who is allowed to send us
   * inbound chats over `/dkg/message/1.0.0`. Authentication is always
   * enforced by the protocol; this is the authorisation layer on top.
   * See {@link ChatConfig} / {@link ChatAclConfig}.
   */
  chat?: ChatConfig;
  /**
   * GH #462 — agent-to-agent messaging authorization. `skill_request` over
   * `/dkg/message/1.0.0` is default-deny for remote peers (the Ed25519 check
   * authenticates the caller but does not authorize skill invocation). Set
   * `openSkills: true` to restore the legacy open behaviour, or list specific
   * peer ids in `skillAllowedPeers`.
   */
  messaging?: {
    openSkills?: boolean;
    skillAllowedPeers?: string[];
  };
  /** Route-plugin specs (absolute paths / package names) loaded at daemon startup. ADR 0001. */
  routePlugins?: string[];
  /**
   * libp2p / discovery network tunables for small / sparse meshes.
   * Forwarded through `DKGAgentConfig` and applied at `createLibp2p` /
   * `kadDHT` construction (libp2p tunables) and to the agent-profile
   * heartbeat timer (phonebook side). All fields optional; omitting
   * any field preserves the built-in default. See companion knobs in
   * `packages/core/src/types.ts` (libp2p side) +
   * `packages/agent/src/dkg-agent-constants.ts` (agent side).
   *
   * Targeted at testnet / small-mesh operators where DHT lookups are
   * flaky (sparse routing tables) and direct addresses age out before
   * being re-discovered. Mainnet / large-mesh deployments should leave
   * all fields unset to keep upstream defaults.
   *
   * Note: a per-step PeerResolver timeout knob was intentionally NOT
   * exposed here. Production callers (`connectToPeerId`, chat /
   * routed sends) always pass an explicit `perStepTimeoutMs` derived
   * from their own deadline budget, so an operator default would be a
   * silent no-op for those paths. To influence dial latency on small
   * networks, bump the caller-side `timeoutMs` (e.g. `connectToPeerId`'s
   * `timeoutMs` option) instead. Codex review of PR #698 caught this.
   */
  network?: {
    /** libp2p `peerStore.maxAddressAge` (default 3_600_000 = 1h upstream). */
    peerStoreMaxAddressAgeMs?: number;
    /** libp2p `peerStore.maxPeerAge` (default 21_600_000 = 6h upstream). */
    peerStoreMaxPeerAgeMs?: number;
    /** libp2p `kadDHT.querySelfInterval` (default kad-DHT upstream). */
    dhtQuerySelfIntervalMs?: number;
    /**
     * Cadence at which the daemon re-publishes its own profile to the
     * `agents` Context Graph (default 20min — see
     * `AGENT_PROFILE_HEARTBEAT_MS`). Set to `0` to disable; the
     * one-shot startup publish still fires.
     *
     * Each heartbeat refreshes `dkg:multiaddr` + `dkg:lastSeen` so
     * other peers' dial fallback can find fresh phonebook entries
     * even when direct connections have aged out of the peerStore.
     */
    agentProfileHeartbeatMs?: number;
  };
  /**
   * OT-RFC-38 LU-6 host-mode custody config — eviction tiers, discovery-beacon
   * rate limits, and the OT-RFC-49 WS-A `stripCiphertext` kill-switch.
   * Forwarded through to `DKGAgentConfig.swmHostMode` by the daemon lifecycle;
   * WITHOUT this field (and the matching forward in `lifecycle.ts`) the whole
   * block is INERT — only the in-agent defaults apply, so an operator could not
   * toggle `swmHostMode.stripCiphertext` (or any host-mode tunable) from
   * config.json. (This is exactly the inert-flag bug the rung-1 strip hit.)
   */
  swmHostMode?: DKGAgentConfig['swmHostMode'];
}

/**
 * Hardcoded per-network telemetry endpoints.
 * Nodes resolve the correct endpoints from the network they're on.
 * Operators only see a single toggle — no endpoint configuration.
 */
export const TELEMETRY_ENDPOINTS: Record<
  string,
  { syslog: { host: string; port: number }; otlp: string }
> = {
  testnet: {
    syslog: { host: 'loggly.origin-trail.network', port: 12201 },
    otlp: 'https://telemetry-testnet.origintrail.io/v1/metrics',
  },
  mainnet: {
    syslog: { host: 'loggly.origin-trail.network', port: 0 }, // legacy syslog — OTLP is the mainnet path
    otlp: 'https://telemetry.origintrail.io/v1/metrics',
  },
};
// NOTE: there is intentionally NO per-network OTLP *logs* endpoint here. The
// OTLP log exporter resolves its endpoint env-first (OTEL_EXPORTER_OTLP_*) then
// from `config.telemetry.logs.endpoint` (see startOtlpExporter) — never from a
// hardcoded default — so a node can't ship logs to a placeholder URL.

const DEFAULT_CONFIG: DkgConfig = {
  name: 'dkg-node',
  apiPort: 9200,
  listenPort: 0,
  nodeRole: 'edge',
};

export {
  resolveStorageAckTiming,
  STORAGE_ACK_SEND_TIMEOUT_DEFAULT_MS,
  STORAGE_ACK_HANDLER_DEADLINE_DEFAULT_MS,
  STORAGE_ACK_TIMING_SAFETY_MARGIN_MS,
  type StorageAckTiming,
};

/** Resolve context graphs from config. */
export function resolveContextGraphs(config: DkgConfig): string[] {
  return config.contextGraphs ?? [];
}

/** Resolve context graphs from network config. */
export function resolveNetworkDefaultContextGraphs(network: NetworkConfig | null | undefined): string[] {
  return network?.defaultContextGraphs ?? [];
}

type NetworkReadinessValidation =
  | { ok: true; messages: [] }
  | { ok: false; messages: string[] };

type NetworkReadinessInput = Partial<Pick<NetworkConfig, '_status' | 'networkName' | 'relays'>>;

export function validateNetworkConfigReadiness(
  network: NetworkReadinessInput | null | undefined,
): NetworkReadinessValidation {
  const networkName = network?.networkName ?? 'selected network';
  const messages: string[] = [];
  if (network?._status?.toLowerCase().startsWith('pre-deployment')) {
    messages.push(
      `FATAL: network config ${networkName} is marked ${network._status}.`,
    );
  }
  const placeholderRelays = network?.relays?.filter(relay => relay.includes('/p2p/PEER_ID_')) ?? [];
  if (placeholderRelays.length > 0) {
    messages.push(
      `FATAL: network config ${networkName} contains placeholder relay peer IDs: ${placeholderRelays.join(', ')}`,
    );
    messages.push('Replace pre-deployment relay PeerIDs before selecting this network.');
  }
  if (messages.length > 0) return { ok: false, messages };
  return { ok: true, messages: [] };
}

export function assertNetworkConfigReadiness(
  network: NetworkReadinessInput | null | undefined,
): void {
  const readiness = validateNetworkConfigReadiness(network);
  if (!readiness.ok) {
    throw new Error(readiness.messages.join('\n'));
  }
}

/** Resolve shared memory TTL from config, accepting both V10 and legacy keys. */
export function resolveSharedMemoryTtlMs(config: DkgConfig): number | undefined {
  return config.sharedMemoryTtlMs ?? config.workspaceTtlMs;
}

/**
 * Translates the operator-facing {@link ApprovalPolicyConfig} (YAML/JSON,
 * string-typed numerics) into the runtime `ApprovalPolicy` shape the
 * chain adapter expects (`bigint` for `targetAllowance`).
 *
 * - Returns `undefined` if the operator didn't configure a policy — lets
 *   the chain adapter fall back to its built-in default
 *   (`DEFAULT_APPROVAL_POLICY`, currently `per-publish`).
 * - Throws a descriptive `Error` if the operator supplied an unparseable
 *   `targetAllowance` (e.g. `'one thousand TRAC'`). Fails fast at startup
 *   rather than silently falling back — config bugs are easier to find
 *   when they don't lurk for hours.
 */
export function resolveApprovalPolicy(
  policy: ApprovalPolicyConfig | undefined,
): { mode: ApprovalPolicyMode; targetAllowance?: bigint; refillBelowFraction?: number } | undefined {
  if (!policy) return undefined;
  const mode = policy.mode ?? 'per-publish';
  if (mode !== 'per-publish' && mode !== 'replenishing' && mode !== 'unlimited') {
    throw new Error(
      `chain.approvalPolicy.mode must be one of 'per-publish' | 'replenishing' | 'unlimited' (got: ${JSON.stringify(mode)})`,
    );
  }
  let targetAllowance: bigint | undefined;
  if (policy.targetAllowance !== undefined) {
    try {
      targetAllowance = BigInt(policy.targetAllowance);
    } catch (err: any) {
      throw new Error(
        `chain.approvalPolicy.targetAllowance must be a decimal wei-TRAC bigint string (got: ${JSON.stringify(policy.targetAllowance)}, ${err?.message ?? err})`,
      );
    }
    if (targetAllowance < 0n) {
      throw new Error(
        `chain.approvalPolicy.targetAllowance must be non-negative (got: ${targetAllowance})`,
      );
    }
  }
  if (policy.refillBelowFraction !== undefined) {
    if (
      typeof policy.refillBelowFraction !== 'number'
      || !Number.isFinite(policy.refillBelowFraction)
      || policy.refillBelowFraction < 0
      || policy.refillBelowFraction > 1
    ) {
      throw new Error(
        `chain.approvalPolicy.refillBelowFraction must be a finite number in [0, 1] (got: ${JSON.stringify(policy.refillBelowFraction)})`,
      );
    }
  }
  return {
    mode,
    targetAllowance,
    refillBelowFraction: policy.refillBelowFraction,
  };
}

/**
 * Normalize a persisted wei amount (funding floors) into a bigint.
 *
 * JSON/YAML configs and the network overlay can only produce strings and
 * numbers, never bigints — so accept all three and fail fast at startup on
 * anything that would otherwise silently mis-compare downstream: decimal
 * strings (`BigInt('0.002')` throws — good), empty strings (`BigInt('')` is
 * silently `0n` — guarded), non-integer or unsafe-precision numbers (would
 * lose wei), and negatives (would invert the floor comparison).
 */
export function parseWeiFloor(
  value: bigint | string | number | undefined,
  label: string,
): bigint | undefined {
  if (value === undefined) return undefined;
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${label} must be an integer within Number.MAX_SAFE_INTEGER when given as a number — use a decimal wei string for larger amounts (got: ${value})`,
      );
    }
    parsed = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${label} must be a decimal wei bigint string (got an empty string)`);
    }
    try {
      parsed = BigInt(trimmed);
    } catch (err: any) {
      throw new Error(
        `${label} must be a decimal wei bigint string (got: ${JSON.stringify(value)}, ${err?.message ?? err})`,
      );
    }
  }
  if (parsed < 0n) {
    throw new Error(`${label} must be non-negative (got: ${parsed})`);
  }
  return parsed;
}

let _networkConfig: NetworkConfig | null = null;
let _networkConfigName: string | null = null;

export function _resetNetworkConfigCache(): void {
  _networkConfig = null;
  _networkConfigName = null;
}

export interface ProjectConfig {
  repo: string;
  defaultBranch: string;
  githubUrl: string;
  projectName: string;
  syslogAppName: string;
  defaultNetwork: string;
}

let _projectConfig: ProjectConfig | null = null;

/**
 * Return true when `dir` is the published DKG CLI package root, as
 * determined by an adjacent `package.json` whose `name` is
 * `@origintrail-official/dkg`. This is resilient to `projectName`
 * renames in `project.json` and cannot be spoofed by an unrelated app.
 */
function isDkgPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg?.name === '@origintrail-official/dkg'
      && existsSync(join(dir, 'project.json'));
  } catch { return false; }
}

/**
 * Resolve candidate directories where repo-root files (project.json,
 * network/*.json) may live, in priority order.
 *
 * Ordering rationale:
 *   - In a monorepo checkout the DKG root is the single source of
 *     truth, so any detected monorepo ancestor MUST win. Otherwise,
 *     once `packages/cli/build` has copied `project.json` and
 *     `network/*.json` into `packages/cli/`, those stale artifacts
 *     would shadow edits made to the root files until the next
 *     rebuild — breaking the intended "edit root config, rerun" dev
 *     flow.
 *   - In a published npm install there is no monorepo ancestor, so
 *     we fall back to the package-local root (identified unambiguously
 *     by its `package.json.name`). This also guarantees we never
 *     accidentally read a consumer's own `project.json` from
 *     `node_modules/..`.
 */
function candidateRoots(): string[] {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const out: string[] = [];

  // Monorepo ancestors first (dev / source checkout). `dist/` and
  // `src/` live at different depths, so both paths are tried.
  const monorepoCandidates = [
    join(thisDir, '..', '..', '..'),        // from dist/
    join(thisDir, '..', '..', '..', '..'),  // from src/ during dev
  ];
  for (const dir of monorepoCandidates) {
    if (isDkgMonorepoRoot(dir)) out.push(dir);
  }

  // Package-local root as the fallback — the only location that ever
  // wins in a published install, and unambiguous via its package.json.
  const pkgRoot = join(thisDir, '..');
  if (isDkgPackageRoot(pkgRoot)) out.push(pkgRoot);

  return out;
}

/**
 * Load project.json — the single source of truth for repo name,
 * branch, GitHub URL, and default network. Values here drive the
 * startup banner, auto-update fallbacks, and network selection.
 *
 * To rename the repo or change the default branch/network, edit
 * project.json at the repo root — all runtime code follows.
 */
export function loadProjectConfig(): ProjectConfig {
  if (_projectConfig) return _projectConfig;
  for (const root of candidateRoots()) {
    try {
      const raw = readFileSync(join(root, 'project.json'), 'utf-8');
      _projectConfig = JSON.parse(raw) as ProjectConfig;
      return _projectConfig;
    } catch { /* try next */ }
  }
  _projectConfig = {
    repo: 'OriginTrail/dkg',
    defaultBranch: 'main',
    githubUrl: 'https://github.com/OriginTrail/dkg',
    projectName: 'dkg',
    syslogAppName: 'dkg',
    defaultNetwork: 'testnet',
  };
  return _projectConfig;
}

export function _resetProjectConfigCache(): void {
  _projectConfig = null;
}

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isApprovalPolicyMode(value: unknown): value is ApprovalPolicyMode {
  return value === 'per-publish' || value === 'replenishing' || value === 'unlimited';
}

function requireApprovalPolicyConfig(policy: unknown): ApprovalPolicyConfig | undefined {
  if (policy === undefined || policy === null) return undefined;
  if (typeof policy === 'string') {
    if (isApprovalPolicyMode(policy)) return { mode: policy };
    throw new Error(
      `chain.approvalPolicy must be an object or a valid mode string (got: ${JSON.stringify(policy)})`,
    );
  }
  if (!isPlainConfigObject(policy)) {
    throw new Error(`chain.approvalPolicy must be an object (got: ${JSON.stringify(policy)})`);
  }
  return policy as ApprovalPolicyConfig;
}

/**
 * Field-level merge of the effective auto-update configuration.
 *
 * Precedence per field: `~/.dkg/config.json` → `network/<env>.json` →
 * `project.json` (or static fallback). Returns null when auto-update is
 * explicitly disabled in the local config.
 *
 * Rationale: `dkg init` intentionally omits `repo`/`branch` from the
 * persisted config when the user accepts the defaults, so that future
 * changes to the shipped network/project defaults propagate without a
 * config rewrite. Callers must therefore resolve the effective values
 * instead of reading `config.autoUpdate.repo` directly.
 */
export function resolveAutoUpdateConfig(
  config: Pick<DkgConfig, 'autoUpdate'> | null | undefined,
  network: Pick<NetworkConfig, 'autoUpdate'> | null | undefined,
): ResolvedAutoUpdateConfig | null {
  const cfg = config?.autoUpdate;
  const net = network?.autoUpdate;
  const enabled = cfg?.enabled ?? net?.enabled ?? false;
  if (!enabled) return null;

  const proj = loadProjectConfig();
  const repo = cfg?.repo ?? net?.repo ?? proj.repo;
  const branch = cfg?.branch ?? net?.branch ?? proj.defaultBranch;
  const allowPrerelease = cfg?.allowPrerelease ?? net?.allowPrerelease ?? true;
  const sshKeyPath = cfg?.sshKeyPath ?? net?.sshKeyPath;
  const sshCommand = cfg?.sshCommand ?? net?.sshCommand;
  const checkIntervalMinutes = cfg?.checkIntervalMinutes ?? net?.checkIntervalMinutes ?? 30;
  const source = cfg?.source ?? net?.source;
  const channel = cfg?.channel ?? net?.channel;

  // Merge build timeouts per-key so operators can override one step (e.g.
  // `contracts` on slow ARM hosts) without re-specifying the rest.
  const buildTimeoutMs: AutoUpdateBuildTimeouts | undefined = (() => {
    const c = cfg?.buildTimeoutMs;
    const n = net?.buildTimeoutMs;
    if (!c && !n) return undefined;
    return {
      ...(c?.install ?? n?.install ? { install: c?.install ?? n?.install } : {}),
      ...(c?.build ?? n?.build ? { build: c?.build ?? n?.build } : {}),
      ...(c?.contracts ?? n?.contracts ? { contracts: c?.contracts ?? n?.contracts } : {}),
      ...(c?.markitdown ?? n?.markitdown ? { markitdown: c?.markitdown ?? n?.markitdown } : {}),
    };
  })();

  return {
    enabled: true,
    repo,
    branch,
    allowPrerelease,
    ...(sshKeyPath ? { sshKeyPath } : {}),
    ...(sshCommand ? { sshCommand } : {}),
    checkIntervalMinutes,
    ...(buildTimeoutMs ? { buildTimeoutMs } : {}),
    ...(source ? { source } : {}),
    ...(channel ? { channel } : {}),
  };
}

export function resolveAutoUpdateSource(
  config: Pick<DkgConfig, 'autoUpdate'> | null | undefined,
  network: Pick<NetworkConfig, 'autoUpdate'> | null | undefined,
): AutoUpdateConfig['source'] {
  return config?.autoUpdate?.source ?? network?.autoUpdate?.source;
}

/**
 * True for a loopback / local-host RPC URL (localhost, 127.0.0.0/8, ::1,
 * 0.0.0.0). Such a primary is a LOCAL chain (Hardhat / devnet), so the
 * network's PUBLIC backup endpoints must NOT be auto-attached behind it:
 * ethers' FallbackProvider hard-rejects mixing providers on different chains
 * ("cannot mix providers on different networks"), which would break chain
 * init. A real operator's private RPC is non-loopback and still inherits the
 * public backups for failover.
 */
function isLoopbackRpcUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      /^127\./.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Field-level merge of the effective chain configuration.
 *
 * Precedence per field: `~/.dkg/config.json#chain` → `network/<env>.json#chain`.
 * Returns `undefined` when neither source provides a chain block.
 *
 * Rationale: the daemon previously read chain via `config.chain ?? network.chain`
 * (whole-object fallback), which meant an operator who set just `rpcUrl` in their
 * local config would lose `hubAddress` / `chainId` from the network file and
 * crash deeper inside ethers. With per-field merge, operators can override
 * individual fields (e.g. swap public RPC for a private one) and still inherit
 * the rest — including future hub rotations the auto-updater pulls down.
 *
 * The return type is `Partial<ChainConfig>` because either source may be
 * partial; consumers that need both `rpcUrl` and `hubAddress` (lifecycle,
 * publisher-runner) MUST guard for those fields before passing to the agent.
 *
 * This is a raw field-merge helper. Call {@link resolveReadyChainConfig} at
 * CLI/daemon activation boundaries that must reject pre-deployment networks.
 */
export function resolveChainConfig(
  config: Pick<DkgConfig, 'chain'> | null | undefined,
  network: Pick<NetworkConfig, 'chain'> | null | undefined,
): ResolvedChainConfig | undefined {
  const cfg = config?.chain;
  const net = network?.chain;
  if (!cfg && !net) return undefined;

  // Short-circuit when the operator opts in to mock mode. We strip
  // rpcUrl/hubAddress entirely (both inherited-from-network AND any stale
  // values left over in the operator's own config from a previous EVM
  // setup) so no downstream consumer can hit a real chain by accident.
  // Without this, lifecycle.ts/publisher-runner.ts/status.ts/`dkg set-ask`
  // all gate on `rpcUrl && hubAddress` but not on `type`, so a hybrid
  // `{ type: 'mock', rpcUrl: '<real>', hubAddress: '<real>' }` would wire
  // up MockChainAdapter (correct) AND open a real ethers.JsonRpcProvider
  // / EVMChainAdapter against the live network in parallel. MockChainAdapter
  // only needs chainId; rpcUrl/hubAddress are meaningless in mock mode.
  if (cfg?.type === 'mock') {
    const mockMerged: ResolvedChainConfig = { type: 'mock' };
    if (cfg.chainId !== undefined) mockMerged.chainId = cfg.chainId;
    if (cfg.mockIdentityId !== undefined) mockMerged.mockIdentityId = cfg.mockIdentityId;
    return mockMerged;
  }

  const merged: ResolvedChainConfig = {
    type: cfg?.type ?? net?.type ?? 'evm',
  };
  const primaryRpcUrl = cfg?.rpcUrl ?? net?.rpcUrl;
  // Don't inherit the network's PUBLIC backups when the operator pins their OWN
  // PRIMARY rpcUrl on a DIFFERENT chain than the overlay — either a loopback/
  // local primary (Hardhat/devnet) OR a custom primary whose `chainId` differs
  // from the network's. Either would build a cross-chain FallbackProvider
  // (e.g. local 31337 + public Base Sepolia 84532) that ethers rejects at init.
  // The cross-chain risk only exists when the PRIMARY itself is off-overlay, so
  // this requires a custom `rpcUrl`: a `chainId` override with NO custom rpcUrl
  // leaves the primary on the network RPC (same chain as the backups), so the
  // backups stay valid failover and must NOT be dropped. A non-loopback private
  // primary on the SAME chain still inherits the public backups; explicit
  // operator `rpcUrls` always win.
  const operatorPinnedOffOverlayPrimary =
    typeof cfg?.rpcUrl === 'string' &&
    (
      isLoopbackRpcUrl(cfg.rpcUrl) ||
      (cfg?.chainId !== undefined && net?.chainId !== undefined && cfg.chainId !== net.chainId)
    );
  const suppressInheritedBackups = cfg?.rpcUrls === undefined && operatorPinnedOffOverlayPrimary;
  const backupRpcUrls =
    cfg?.rpcUrls ?? (suppressInheritedBackups ? [] : net?.rpcUrls) ?? [];
  const orderedRpcUrls: string[] = [];
  for (const candidate of [primaryRpcUrl, ...backupRpcUrls]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || orderedRpcUrls.includes(trimmed)) continue;
    orderedRpcUrls.push(trimmed);
  }
  if (orderedRpcUrls[0] !== undefined) merged.rpcUrl = orderedRpcUrls[0];
  if (orderedRpcUrls.length > 1 || cfg?.rpcUrls !== undefined || net?.rpcUrls !== undefined) {
    merged.rpcUrls = orderedRpcUrls.slice(1);
  }
  const walletRpcUrls = cfg?.walletRpcUrls ?? (operatorPinnedOffOverlayPrimary ? undefined : net?.walletRpcUrls);
  if (walletRpcUrls !== undefined) {
    merged.walletRpcUrls = Array.from(new Set(
      walletRpcUrls
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map((candidate) => candidate.trim())
        .filter(Boolean),
    ));
  }
  const hubAddress = cfg?.hubAddress ?? net?.hubAddress;
  if (hubAddress !== undefined) merged.hubAddress = hubAddress;
  const tokenAddress = cfg?.tokenAddress ?? net?.tokenAddress;
  if (tokenAddress !== undefined) merged.tokenAddress = tokenAddress;
  const chainId = cfg?.chainId ?? net?.chainId;
  if (chainId !== undefined) merged.chainId = chainId;
  const approvalPolicy = requireApprovalPolicyConfig(cfg?.approvalPolicy);
  if (approvalPolicy !== undefined) merged.approvalPolicy = approvalPolicy;
  const cgRegistryScanPageSize = cfg?.cgRegistryScanPageSize ?? net?.cgRegistryScanPageSize;
  if (cgRegistryScanPageSize !== undefined) merged.cgRegistryScanPageSize = cgRegistryScanPageSize;
  // Funding floors: local config wins, else the network overlay's per-chain
  // default (both default 0n downstream in the adapter when unset). Persisted
  // values arrive as string/number — normalize to bigint here, failing fast on
  // garbage instead of letting it reach the adapter's balance comparisons.
  const minPublisherNativeWei = parseWeiFloor(
    cfg?.minPublisherNativeWei ?? net?.minPublisherNativeWei,
    'chain.minPublisherNativeWei',
  );
  if (minPublisherNativeWei !== undefined) merged.minPublisherNativeWei = minPublisherNativeWei;
  const minPublisherTracWei = parseWeiFloor(
    cfg?.minPublisherTracWei ?? net?.minPublisherTracWei,
    'chain.minPublisherTracWei',
  );
  if (minPublisherTracWei !== undefined) merged.minPublisherTracWei = minPublisherTracWei;
  if (cfg?.mockIdentityId !== undefined) merged.mockIdentityId = cfg.mockIdentityId;
  return merged;
}

export function resolveReadyChainConfig(
  config: Pick<DkgConfig, 'chain'> | null | undefined,
  network: (Pick<NetworkConfig, 'chain'> & NetworkReadinessInput) | null | undefined,
): ResolvedChainConfig | undefined {
  if (config?.chain?.type !== 'mock') {
    assertNetworkConfigReadiness(network);
  }
  return resolveChainConfig(config, network);
}

/**
 * Load a network config from network/<name>.json.
 *
 * @param network - Network name (e.g. 'testnet', 'mainnet-base'). Defaults to
 *   the `defaultNetwork` value from project.json.
 *
 * Candidate paths (tried in order):
 *  1. Monorepo root when running from packages/cli/dist/
 *  2. Monorepo root when running from packages/cli/src/ during dev
 *  3. Bundled alongside dist/ in the published NPM package (dist/../network/)
 *
 * Monorepo paths are checked first so that edits to the repo-root
 * network/ files are picked up immediately during development
 * without requiring a rebuild of the CLI package.
 */
export async function loadNetworkConfig(network?: string): Promise<NetworkConfig | null> {
  const name = network?.trim() || loadProjectConfig().defaultNetwork;
  if (_networkConfig && _networkConfigName === name) return _networkConfig;
  try {
    const file = `${name}.json`;
    const candidates = candidateRoots().map(root => join(root, 'network', file));
    for (const path of candidates) {
      try {
        const raw = await readFile(path, 'utf-8');
        _networkConfig = JSON.parse(raw) as NetworkConfig;
        _networkConfigName = name;
        return _networkConfig;
      } catch { /* try next */ }
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveNetworkConfigName(config?: Pick<DkgConfig, 'networkConfig'> | null): string {
  return config?.networkConfig?.trim() || loadProjectConfig().defaultNetwork;
}

/**
 * Validate an operator-supplied `--network <name>` value before a setup flow
 * persists it. Rejects unknown overlay names and pre-deployment networks
 * (e.g. `mainnet-neuroweb`, whose bundled config is still placeholder-gated)
 * with a clear, early error — instead of letting the node FATAL at daemon
 * boot. A blank/undefined value is a no-op (the caller falls back to the
 * setup default). Shared by the openclaw/hermes/mcp setup actions.
 */
export async function assertSelectableNetwork(name: string | undefined | null): Promise<void> {
  const trimmed = name?.trim();
  if (!trimmed) return;
  const network = await loadNetworkConfig(trimmed);
  if (!network) {
    throw new Error(
      `No bundled network config named "${trimmed}". Common options: ${SELECTABLE_SETUP_NETWORKS.join(', ')}.`,
    );
  }
  const readiness = validateNetworkConfigReadiness(network);
  if (!readiness.ok) {
    throw new Error(
      `Network "${trimmed}" is not available yet:\n${readiness.messages.join('\n')}`,
    );
  }
}

export function dkgDir(): string {
  return resolveDkgConfigHome({ isDkgMonorepo: isDkgMonorepo() });
}

let _isDkgMonorepo: boolean | null = null;
export function isDkgMonorepo(): boolean {
  if (_isDkgMonorepo !== null) return _isDkgMonorepo;
  const root = repoDir();
  if (!root) { _isDkgMonorepo = false; return false; }
  _isDkgMonorepo = isDkgMonorepoRoot(root);
  return _isDkgMonorepo;
}

export type MonorepoInitTarget = 'not-monorepo' | 'explicit-home' | 'dev-home' | 'shared-npm-home';

/**
 * Classify what `dkg init`'s config-home resolution means for a given run, so
 * the command can notify the operator without hard-blocking (issue #960). Pure
 * + fully injectable so the three meaningful branches are unit-testable.
 *
 *  - `not-monorepo`    — an npm install; init behaves normally, no notice.
 *  - `explicit-home`   — the user set `DKG_HOME`; their explicit choice, no notice.
 *  - `dev-home`        — monorepo checkout, no `DKG_HOME`, resolves to the
 *                        separate dev home (`~/.dkg-dev`); safe — informational
 *                        notice only.
 *  - `shared-npm-home` — monorepo checkout, no `DKG_HOME`, but a config already
 *                        exists at `~/.dkg` so `resolveDkgConfigHome` falls back
 *                        to it; init would read and may OVERWRITE the shared
 *                        `~/.dkg` home (which *might* be an npm-installed node).
 *                        The command must NOT silently proceed (that can mutate
 *                        an installed node's config if the operator misses the
 *                        warning) and must NOT hard-block (config presence isn't
 *                        proof of npm ownership, and a dev may intentionally use
 *                        `~/.dkg`). The caller gates this case behind an explicit
 *                        opt-in via {@link sharedHomeInitGate}.
 *
 * `resolvedHome === npmHome` is the signal for the fallback: `dkgDir()` returns
 * `~/.dkg` (rather than `~/.dkg-dev`) only when the resolver's own
 * config-existence check (`config.json` OR `config.yaml`) matched, so the YAML
 * case is handled here for free.
 */
export function classifyMonorepoInit(params: {
  isMonorepo: boolean;
  dkgHomeEnv: string | undefined;
  resolvedHome: string;
  npmHome: string;
}): MonorepoInitTarget {
  if (!params.isMonorepo) return 'not-monorepo';
  if (params.dkgHomeEnv?.trim()) return 'explicit-home';
  return params.resolvedHome === params.npmHome ? 'shared-npm-home' : 'dev-home';
}

export type SharedHomeInitGate = 'proceed' | 'prompt' | 'refuse';

/**
 * Decide how `dkg init` should gate the {@link classifyMonorepoInit}
 * `shared-npm-home` case — running from a monorepo checkout into a pre-existing
 * `~/.dkg` that may belong to an npm-installed node (issue #960, round-3
 * review). A plain warn-and-proceed is a regression: a contributor who misses
 * the warning silently mutates the installed node's config. A hard refusal is
 * also wrong (a dev may intentionally target `~/.dkg`). So we require an
 * **explicit opt-in**:
 *
 *  - `proceed` — the operator passed `--yes`; honor the explicit opt-in.
 *  - `prompt`  — interactive TTY; ask for confirmation before touching `~/.dkg`.
 *  - `refuse`  — non-interactive and no `--yes`; we can't ask and must not
 *                silently overwrite, so abort with guidance (re-run with
 *                `--yes`, or set `DKG_HOME`).
 *
 * Pure + injectable so all three branches are unit-testable without a TTY.
 */
export function sharedHomeInitGate(params: {
  yes: boolean;
  isTty: boolean;
}): SharedHomeInitGate {
  if (params.yes) return 'proceed';
  return params.isTty ? 'prompt' : 'refuse';
}

/**
 * Resolve the repo root from the compiled code location.
 * Works from packages/cli/dist/ (compiled) or packages/cli/src/ (dev).
 */
export function findRepoDir(startDir: string): string | null {
  return findPackageRepoDir(startDir);
}

export function repoDir(): string | null {
  return findRepoDir(dirname(fileURLToPath(import.meta.url)));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function gitCommandEnv(autoUpdate?: Pick<AutoUpdateConfig, 'sshKeyPath' | 'sshCommand'> | null): NodeJS.ProcessEnv {
  const sshCommand = process.env.DKG_GIT_SSH_COMMAND?.trim() || autoUpdate?.sshCommand?.trim();
  const sshKeyPath = process.env.DKG_SSH_KEY_PATH?.trim() || autoUpdate?.sshKeyPath?.trim();
  const env = { ...process.env };

  if (sshCommand) {
    env.GIT_SSH_COMMAND = sshCommand;
    return env;
  }

  if (sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i ${shellQuote(sshKeyPath)} -o IdentitiesOnly=yes`;
  }

  return env;
}

function githubHttpsRepo(repoUrl: string | undefined): boolean {
  if (!repoUrl) return false;
  return /^https:\/\/github\.com\//i.test(repoUrl.trim());
}

export function gitCommandArgs(
  repoUrl?: string,
  autoUpdate?: Pick<AutoUpdateConfig, 'sshKeyPath' | 'sshCommand'> | null,
): string[] {
  const token = process.env.GITHUB_TOKEN?.trim();
  const sshCommand = process.env.DKG_GIT_SSH_COMMAND?.trim() || autoUpdate?.sshCommand?.trim();
  const sshKeyPath = process.env.DKG_SSH_KEY_PATH?.trim() || autoUpdate?.sshKeyPath?.trim();
  if (!token || sshCommand || sshKeyPath || !githubHttpsRepo(repoUrl)) return [];

  const basic = Buffer.from(`x-access-token:${token}`, 'utf-8').toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

export function releasesDir(): string {
  return join(dkgDir(), 'releases');
}

/** Read the active slot from the `releases/current` symlink. Falls back to the `active` file. */
export async function activeSlot(): Promise<'a' | 'b' | null> {
  try {
    const raw = await readlink(join(releasesDir(), 'current'));
    const target = basename(raw);
    if (target === 'a' || target === 'b') return target;
  } catch { /* symlink doesn't exist */ }
  try {
    const raw = (await readFile(join(releasesDir(), 'active'), 'utf-8')).trim();
    if (raw === 'a' || raw === 'b') return raw;
  } catch { /* file doesn't exist */ }
  return null;
}

export async function inactiveSlot(): Promise<'a' | 'b'> {
  const active = await activeSlot();
  return (active ?? 'a') === 'a' ? 'b' : 'a';
}

/**
 * Atomically swap the `releases/current` symlink to point to `target` slot.
 * Uses tmp-symlink + rename to avoid any window where the symlink is broken.
 */
export async function swapSlot(target: 'a' | 'b'): Promise<void> {
  const rDir = releasesDir();
  const currentLink = join(rDir, 'current');
  const tmpLink = join(rDir, 'current.tmp');

  // Check if already pointing to target
  try {
    const dest = await readlink(currentLink);
    if (dest === target) {
      await writeFile(join(rDir, 'active'), target);
      return;
    }
  } catch { /* link doesn't exist yet */ }

  try { await unlink(tmpLink); } catch { /* ok if missing */ }
  await symlink(target, tmpLink);
  await rename(tmpLink, currentLink);
  await writeFile(join(rDir, 'active'), target);
}

export function configPath(): string {
  return join(dkgDir(), 'config.json');
}

export function configYamlPath(): string {
  return join(dkgDir(), 'config.yaml');
}

export function pidPath(): string {
  return join(dkgDir(), 'daemon.pid');
}

export function logPath(): string {
  return join(dkgDir(), 'daemon.log');
}

export function apiPortPath(): string {
  return join(dkgDir(), 'api.port');
}

export async function ensureDkgDir(): Promise<void> {
  await mkdir(dkgDir(), { recursive: true });
}

function mergePersistedConfig(raw: unknown): DkgConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...(raw as Partial<DkgConfig>) };
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT';
}

function readPersistedConfigSync(): unknown {
  if (existsSync(configPath())) {
    return JSON.parse(readFileSync(configPath(), 'utf-8'));
  }
  if (existsSync(configYamlPath())) {
    return yaml.load(readFileSync(configYamlPath(), 'utf-8'));
  }
  return null;
}

export function readNodeRoleFromConfigSync(): 'edge' | 'core' {
  try {
    const parsed = readPersistedConfigSync();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'edge';
    return (parsed as { nodeRole?: unknown }).nodeRole === 'core' ? 'core' : 'edge';
  } catch {
    return 'edge';
  }
}

export async function loadConfig(): Promise<DkgConfig> {
  try {
    const raw = await readFile(configPath(), 'utf-8');
    return mergePersistedConfig(JSON.parse(raw));
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  try {
    const raw = await readFile(configYamlPath(), 'utf-8');
    return mergePersistedConfig(yaml.load(raw));
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  return { ...DEFAULT_CONFIG };
}

// =====================================================================
// External-backend config validation (RFC 120, plan PR 1 item 6)
// =====================================================================
//
// External triple-store backends (Blazegraph, sparql-http) impose two
// requirements beyond the local-file default:
//
//   1. `store.options.url` (or `queryEndpoint`) must be set. The adapter
//      will throw without it, but only deep inside agent boot — by which
//      point logs already have stack traces from finalization wiring
//      that started before the agent. Surfacing the error here at
//      config-load time gives operators a single-line, actionable error.
//   2. `largeLiteralStorage.directory` and
//      `sharedMemoryPublicSnapshotStorage.directory` must be explicit
//      when those features are enabled. The defaults derive a directory
//      from the local triple-store's persistent path; an external
//      backend has no such path, so without explicit directories the
//      blob store throws when it sees its first oversized literal
//      (potentially weeks after install).
//
// Returns an array of error messages — empty if config is valid. Caller
// decides whether to log + exit (boot path) or surface as a config-save
// rejection (future wizard path).
const EXTERNAL_VALIDATION_PREFIX = '[config] store.backend';

export interface StoreConfigValidationError {
  /** Field path within the config that failed validation. */
  field: string;
  /** Human-readable error message including remediation hint. */
  message: string;
}

export function validateStoreConfig(config: DkgConfig): StoreConfigValidationError[] {
  const errors: StoreConfigValidationError[] = [];
  const backend = config.store?.backend;
  // Mirror of `isExternalBackend` from @origintrail-official/dkg-storage.
  // Duplicated here to keep config.ts free of upward dependencies on the
  // storage package (config.ts is leaf-imported by many other modules).
  const isExternal = backend === 'blazegraph' || backend === 'sparql-http';
  if (!isExternal) return errors;

  const opts = (config.store?.options ?? {}) as Record<string, unknown>;

  if (backend === 'blazegraph') {
    if (typeof opts.url !== 'string' || !opts.url.trim()) {
      errors.push({
        field: 'store.options.url',
        message:
          `${EXTERNAL_VALIDATION_PREFIX} is "blazegraph" but ` +
          `store.options.url is missing. Set it to the SPARQL endpoint URL ` +
          `(e.g. http://127.0.0.1:9999/bigdata/namespace/mynode/sparql) or ` +
          `switch backend to oxigraph-worker.`,
      });
    }
  } else if (backend === 'sparql-http') {
    if (typeof opts.queryEndpoint !== 'string' || !opts.queryEndpoint.trim()) {
      errors.push({
        field: 'store.options.queryEndpoint',
        message:
          `${EXTERNAL_VALIDATION_PREFIX} is "sparql-http" but ` +
          `store.options.queryEndpoint is missing. Set it to the SPARQL query URL.`,
      });
    }
  }

  if (config.largeLiteralStorage?.enabled === true) {
    const dir = config.largeLiteralStorage.directory;
    if (typeof dir !== 'string' || !dir.trim()) {
      errors.push({
        field: 'largeLiteralStorage.directory',
        message:
          `largeLiteralStorage.enabled=true with an external store backend requires ` +
          `largeLiteralStorage.directory to be set explicitly (no local store path ` +
          `to infer it from). Either set the directory or disable large-literal storage.`,
      });
    }
  }

  if (config.sharedMemoryPublicSnapshotStorage?.enabled === true) {
    const dir = config.sharedMemoryPublicSnapshotStorage.directory;
    if (typeof dir !== 'string' || !dir.trim()) {
      errors.push({
        field: 'sharedMemoryPublicSnapshotStorage.directory',
        message:
          `sharedMemoryPublicSnapshotStorage.enabled=true with an external store backend ` +
          `requires sharedMemoryPublicSnapshotStorage.directory to be set explicitly.`,
      });
    }
  }

  return errors;
}

/**
 * Convenience helper: validate, log every error, exit if any. Daemon
 * boot uses this; the future wizard path will iterate `errors` to
 * re-prompt instead of exiting.
 */
export function exitOnStoreConfigErrors(
  config: DkgConfig,
  log: (msg: string) => void,
): void {
  const errors = validateStoreConfig(config);
  if (errors.length === 0) return;
  log(`[STORE-CONFIG] ${errors.length} validation error(s) — refusing to start.`);
  for (const err of errors) {
    log(`  ${err.field}: ${err.message}`);
  }
  process.exit(1);
}

export async function saveConfig(config: DkgConfig): Promise<void> {
  await ensureDkgDir();
  await writeFile(configPath(), JSON.stringify(config, null, 2) + '\n');
}

export function configExists(): boolean {
  return existsSync(configPath()) || existsSync(configYamlPath());
}

export async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(pidPath(), 'utf-8');
    return parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

export async function writePid(pid: number): Promise<void> {
  await writeFile(pidPath(), String(pid));
}

export async function removePid(): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(pidPath());
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') throw err;
  }
}

export async function readApiPort(): Promise<number | null> {
  try {
    const raw = await readFile(apiPortPath(), 'utf-8');
    return parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

export async function writeApiPort(port: number): Promise<void> {
  await writeFile(apiPortPath(), String(port));
}

export async function removeApiPort(): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(apiPortPath());
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') throw err;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── NPM / standalone helpers ────────────────────────────────────────

export const CLI_NPM_PACKAGE = '@origintrail-official/dkg';

/**
 * True when running from an `npm install`-ed package rather than a
 * monorepo checkout. In standalone mode the auto-updater uses NPM
 * instead of git to fetch new versions.
 */
export function isStandaloneInstall(): boolean {
  return repoDir() === null;
}

/**
 * Resolve the CLI entry point within a blue-green slot.
 * Supports both git layout (packages/cli/dist/cli.js) and
 * NPM layout (node_modules/@origintrail-official/dkg/dist/cli.js).
 */
export function slotEntryPoint(slotDir: string): string | null {
  return blueGreenSlotEntryPoint(slotDir);
}

/** Return true when a blue-green slot has an entry point and install metadata. */
export function slotReady(slotDir: string): boolean {
  return blueGreenSlotReady(slotDir);
}
