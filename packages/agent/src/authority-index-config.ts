// SPDX-License-Identifier: Apache-2.0

import {
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
