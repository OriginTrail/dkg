// SPDX-License-Identifier: Apache-2.0

import { normalizeAuthorityIndexSnapshotConfig } from './authority-index-snapshot-service.js';

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
  try {
    const normalized = normalizeAuthorityIndexSnapshotConfig(value as AuthorityIndexConfig);
    return Object.freeze({
      mode: 'core-snapshot',
      trustedCorePeers: Object.freeze(normalized.trustedCorePeers.map((peer) => peer.multiaddr)),
      maxTailBlocks: normalized.maxTailBlocks,
      cacheEpoch,
    });
  } catch (cause) {
    throw new TypeError(`authorityIndex: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
