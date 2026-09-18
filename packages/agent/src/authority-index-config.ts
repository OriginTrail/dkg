// SPDX-License-Identifier: Apache-2.0

import { normalizeAuthorityIndexSnapshotConfig } from './authority-index-snapshot-service.js';

/** Explicit trust in the history supplied by these core PeerIDs. */
export interface AuthorityIndexConfig {
  mode: 'core-snapshot';
  trustedCorePeers: readonly string[];
  maxTailBlocks?: number;
}

export interface ResolvedAuthorityIndexConfig extends AuthorityIndexConfig {
  readonly maxTailBlocks: number;
}

export function resolveAuthorityIndexConfig(
  config: unknown,
  nodeRole: 'core' | 'edge' = 'edge',
): ResolvedAuthorityIndexConfig | undefined {
  if (config === undefined) return undefined;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('authorityIndex must be an object');
  }
  const value = config as Partial<AuthorityIndexConfig>;
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
    });
  } catch (cause) {
    throw new TypeError(`authorityIndex: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
