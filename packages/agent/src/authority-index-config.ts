// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS,
  normalizeAuthorityIndexSnapshotConfig,
  type NormalizedAuthorityIndexSnapshotConfig,
} from './authority-index-snapshot-service.js';

const resolvedConfigs = new WeakSet<object>();

/** Explicit trust in the history supplied by these core PeerIDs. */
export interface AuthorityIndexConfig {
  mode: 'core-snapshot';
  trustedCorePeers: readonly string[];
  maxTailBlocks?: number;
  /** Increment to discard cached trusted history while keeping the same peers. */
  cacheEpoch?: number;
}

export interface ResolvedAuthorityIndexConfig extends AuthorityIndexConfig {
  readonly maxTailBlocks: number;
  readonly cacheEpoch: number;
  /** Canonical identities retained for transport and persistence namespacing. */
  readonly snapshot: NormalizedAuthorityIndexSnapshotConfig;
}

/**
 * `nodeRole` is required: this resolver's job includes rejecting cores, so a
 * default would silently opt an embedder's unlabelled core out of that rule.
 */
export function resolveAuthorityIndexConfig(
  config: unknown,
  nodeRole: 'core' | 'edge',
): ResolvedAuthorityIndexConfig | undefined {
  if (config === undefined) return undefined;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('authorityIndex must be an object');
  }
  const allowedKeys = new Set(['mode', 'trustedCorePeers', 'maxTailBlocks', 'cacheEpoch']);
  const unknownKeys = Object.keys(config).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(
      `Unknown authorityIndex option(s): ${unknownKeys.join(', ')}. `
      + 'Supported options: mode, trustedCorePeers, maxTailBlocks, cacheEpoch',
    );
  }
  const value = config as Partial<AuthorityIndexConfig>;
  const cacheEpoch = value.cacheEpoch === undefined ? 0 : value.cacheEpoch;
  if (!Number.isSafeInteger(cacheEpoch) || cacheEpoch < 0) {
    throw new TypeError('authorityIndex.cacheEpoch must be a non-negative safe integer');
  }
  if (value.mode !== 'core-snapshot') {
    throw new TypeError('authorityIndex.mode must be core-snapshot');
  }
  if (nodeRole !== 'edge') {
    throw new TypeError('authorityIndex core-snapshot mode is only supported on edge nodes');
  }
  // The daemon validates before allocating resources, then passes this same
  // immutable value to DKGAgent.create. Only our own objects bypass re-parsing.
  if (resolvedConfigs.has(config)) return config as ResolvedAuthorityIndexConfig;
  try {
    const normalized = normalizeAuthorityIndexSnapshotConfig(value);
    const resolved = {
      mode: 'core-snapshot' as const,
      trustedCorePeers: Object.freeze(normalized.trustedCorePeers.map((peer) => peer.multiaddr)),
      maxTailBlocks: normalized.maxTailBlocks,
      cacheEpoch,
      snapshot: normalized,
    };
    // Persisted config keeps its public wire shape; parsed runtime metadata must
    // not become an unknown field when a caller serializes a resolved config.
    Object.defineProperty(resolved, 'snapshot', { enumerable: false });
    Object.freeze(resolved);
    resolvedConfigs.add(resolved);
    return resolved;
  } catch (cause) {
    throw new TypeError(`authorityIndex: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * The persistence namespace of a trust set: its sorted PeerIDs, so moving a
 * core to a new address keeps its imported prefix. Epoch zero preserves the
 * original namespace; increasing it lets an operator discard a suspect
 * imported prefix without changing peers.
 */
export function authorityIndexTrustDomain(config: ResolvedAuthorityIndexConfig): string {
  const peerIds = config.snapshot.trustedCorePeers.map((peer) => peer.peerId).sort();
  return createHash('sha256').update(JSON.stringify(
    config.cacheEpoch === 0 ? peerIds : { trustedCorePeers: peerIds, cacheEpoch: config.cacheEpoch },
  )).digest('hex');
}

/** The agent config fields that decide authority-index bootstrap; `DKGAgentConfig` satisfies it. */
export interface AuthorityIndexBootstrapInput {
  /** The operator's `authorityIndex` block, raw or already resolved. */
  readonly authorityIndex?: unknown;
  readonly nodeRole?: 'core' | 'edge';
  readonly chainAdapter?: unknown;
  readonly chainConfig?: { readonly operationalKeys?: readonly string[] };
  readonly localContextGraphAuthorityIndexStore?: unknown;
  /** The network file's relay multiaddrs; see `DKGAgentConfig.networkRelays`. */
  readonly networkRelays?: readonly string[];
}

export type AuthorityIndexBootstrapPlan =
  | {
    /** The operator's `authorityIndex` block: its pinned cores, failing closed. */
    readonly source: 'operator';
    readonly config: ResolvedAuthorityIndexConfig;
  }
  | {
    /**
     * The edge default: the network file's relays, each pinned by the PeerID
     * in its multiaddr, falling back to local history when none answers.
     */
    readonly source: 'network-relays';
    readonly config: ResolvedAuthorityIndexConfig;
  }
  | {
    /** No snapshot bootstrap: the index is scanned from chain history. */
    readonly source: 'local-history';
    readonly config?: undefined;
    /** Why an edge without operator config does not seed from the network relays. */
    readonly skipReason?: string;
  };

/** A plan that seeds the index from trusted snapshots. */
export type AuthorityIndexSnapshotPlan = Exclude<AuthorityIndexBootstrapPlan, { readonly source: 'local-history' }>;

/**
 * How an agent builds its authority index. The daemon plans from the config it
 * hands `DKGAgent.create`, which plans again from the same config, so the
 * startup line always describes the policy the agent runs.
 *
 * Operator config always wins and is never downgraded: without the agent's
 * core-snapshot prerequisites it throws. An edge without operator config
 * seeds from the network file's relays and falls back to local history. Only
 * those relays are trusted: agent-registry profiles are unauthenticated
 * gossip, and nothing binds a profile's PeerID to the staked identity it
 * names. A core indexes its own chain history.
 */
export function planAuthorityIndexBootstrap(input: AuthorityIndexBootstrapInput): AuthorityIndexBootstrapPlan {
  const nodeRole = input.nodeRole ?? 'edge';
  const operatorConfig = resolveAuthorityIndexConfig(input.authorityIndex, nodeRole);
  const unmet = unmetCoreSnapshotPrerequisite(input);
  if (operatorConfig !== undefined) {
    if (unmet !== undefined) {
      throw new TypeError('authorityIndex core-snapshot mode requires a configured EVM chain and a local authority index store');
    }
    return Object.freeze({ source: 'operator', config: operatorConfig });
  }
  if (nodeRole !== 'edge') return Object.freeze({ source: 'local-history' });
  if (unmet !== undefined) return Object.freeze({ source: 'local-history', skipReason: unmet });
  const relays = pinnableNetworkRelays(input.networkRelays ?? []);
  if (relays.length === 0) {
    return Object.freeze({ source: 'local-history', skipReason: 'no network relay is available to seed from' });
  }
  const relayConfig = resolveAuthorityIndexConfig({ mode: 'core-snapshot', trustedCorePeers: relays }, 'edge');
  return Object.freeze({ source: 'network-relays', config: relayConfig! });
}

/**
 * Core-snapshot mode needs the agent to construct its own EVM adapter, so it
 * installs the snapshot transport and trust namespace together, with
 * operational keys and a durable local index store.
 */
function unmetCoreSnapshotPrerequisite(input: AuthorityIndexBootstrapInput): string | undefined {
  if (input.chainAdapter !== undefined) {
    return 'the chain adapter is injected (such as the mock chain), not a configured EVM chain';
  }
  if (input.chainConfig === undefined) return 'no EVM chain is configured';
  if (!input.chainConfig.operationalKeys?.length) return 'no operational key is configured';
  if (input.localContextGraphAuthorityIndexStore === undefined) {
    return 'no local authority index store is available';
  }
  return undefined;
}

/**
 * The network relays an explicit `trustedCorePeers` entry could name: first
 * address per PeerID, at most eight. A network file may still list
 * placeholder PeerIDs, which never become trust.
 */
function pinnableNetworkRelays(relays: readonly string[]): string[] {
  const peerIds = new Set<string>();
  const pinnable: string[] = [];
  for (const relay of relays) {
    if (pinnable.length === AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS) break;
    let peerId: string;
    try {
      [{ peerId }] = normalizeAuthorityIndexSnapshotConfig({ trustedCorePeers: [relay] }).trustedCorePeers;
    } catch {
      continue;
    }
    if (peerIds.has(peerId)) continue;
    peerIds.add(peerId);
    pinnable.push(relay);
  }
  return pinnable;
}
