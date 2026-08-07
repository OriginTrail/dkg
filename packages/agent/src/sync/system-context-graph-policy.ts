import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { parseBooleanEnv } from './agents-meta-policy.js';

export interface AutomaticSystemContextGraphSyncOptions {
  nodeRole?: 'core' | 'edge';
  configValue?: boolean;
  envValue?: string;
}

/**
 * Core nodes retain the complete network catalogue needed for hosting, while
 * Edge nodes fetch only graphs their operator selected. Explicit catch-up and
 * the live system GossipSub subscriptions are outside this policy.
 */
export function resolveAutomaticSystemContextGraphSync(
  options: AutomaticSystemContextGraphSyncOptions,
): boolean {
  const envValue = parseBooleanEnv(options.envValue);
  if (envValue !== undefined) return envValue;
  if (options.configValue !== undefined) return options.configValue;
  return options.nodeRole === 'core';
}

export function automaticDurableSyncContextGraphs(
  selectedContextGraphIds: readonly string[],
  options: AutomaticSystemContextGraphSyncOptions,
): string[] {
  const ordered = resolveAutomaticSystemContextGraphSync(options)
    ? [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, ...selectedContextGraphIds]
    : [...selectedContextGraphIds];
  return [...new Set(ordered)];
}
