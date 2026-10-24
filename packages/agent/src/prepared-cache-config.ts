// SPDX-License-Identifier: Apache-2.0
import {
  resolvePreparedContentCacheConfig, type PreparedContentCacheConfig,
} from './sync/responder/prepared-content-cache.js';

/** Agent policy is resolved once at creation; responders receive explicit settings. */
export function normalizeAgentPreparedCacheConfig(config: {
  nodeRole?: 'core' | 'edge';
  dataDir?: string;
  preparedContentCache?: PreparedContentCacheConfig;
}): PreparedContentCacheConfig {
  const resolved = resolvePreparedContentCacheConfig(
    config.preparedContentCache ?? { enabled: config.nodeRole === 'core' && !!config.dataDir },
    config.dataDir,
  );
  return resolved ? { enabled: true, ...resolved } : { enabled: false };
}
