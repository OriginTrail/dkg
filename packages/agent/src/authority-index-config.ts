// SPDX-License-Identifier: Apache-2.0

import {
  AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS,
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
  /**
   * Trust set discovered at runtime from cores the chain vouches for. Only the
   * role default sets it; config.json cannot name a discovery mode.
   */
  readonly discovery?: 'on-chain-cores';
  /** Canonical identities retained for transport and persistence namespacing. */
  readonly snapshot: NormalizedAuthorityIndexSnapshotConfig;
}

/**
 * The role default when config.json names no authorityIndex: an edge seeds
 * from cores it can verify on chain and falls back to its own history when
 * none answers; a core always indexes its own chain log. Like any
 * core-snapshot config it needs a configured EVM chain and a local index
 * store, so the caller applies it only where those hold; `DKGAgent.create`
 * enforces that invariant for the default and explicit config alike.
 */
export function resolveDefaultAuthorityIndexConfig(
  nodeRole: 'core' | 'edge',
): ResolvedAuthorityIndexConfig | undefined {
  if (nodeRole !== 'edge') return undefined;
  const snapshot: NormalizedAuthorityIndexSnapshotConfig = Object.freeze({
    trustedCorePeers: Object.freeze([]),
    maxTailBlocks: AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS,
  });
  const resolved = {
    mode: 'core-snapshot' as const,
    discovery: 'on-chain-cores' as const,
    trustedCorePeers: Object.freeze([] as string[]),
    maxTailBlocks: AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS,
    cacheEpoch: 0,
    snapshot,
  };
  // Runtime-only metadata stays off the public wire shape: a serialized
  // default carries no discovery key, and the unknown-key scan below stays
  // uniform for every input instead of exempting our own objects.
  Object.defineProperty(resolved, 'snapshot', { enumerable: false });
  Object.defineProperty(resolved, 'discovery', { enumerable: false });
  Object.freeze(resolved);
  resolvedConfigs.add(resolved);
  return resolved;
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
  // immutable value to DKGAgent.create. Only our own objects bypass
  // re-normalization: the role default names no peers, which explicit
  // configuration may not do.
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
