// Persists local agent integration state to the home config. The state
// transitions themselves (connect, update, the legacy OpenClaw prune) live in
// local-agents.ts; this module turns one integration's in-memory state into
// config edits and writes them, leaving every other key as it is on disk.

import { configEdit, updateConfigFile, type DkgConfig, type DkgConfigEdit } from '../config.js';
import { getStoredLocalAgentIntegrations, normalizeIntegrationId } from './local-agents.js';

/**
 * The config edits that persist one integration: its entry, read from the
 * in-memory config when the write runs, and, for OpenClaw, the removal of the
 * legacy keys an older OpenClaw setup wrote, which `connect`/`update` prune
 * in memory (pruneLegacyOpenClawConfig).
 */
export function localAgentIntegrationEdits(config: DkgConfig, id: string): DkgConfigEdit[] {
  const normalizedId = normalizeIntegrationId(id);
  const edits = [
    configEdit(['localAgentIntegrations', normalizedId], () => getStoredLocalAgentIntegrations(config)[normalizedId]),
  ];
  if (normalizedId === 'openclaw') {
    edits.push(configEdit(['openclawAdapter'], () => undefined), configEdit(['openclawChannel'], () => undefined));
  }
  return edits;
}

/**
 * Write one integration's in-memory record to the config file, plus the
 * legacy OpenClaw key cleanup. Other integrations and every other config key
 * are left as they are on disk. The record is read when the write runs, so of
 * two writes for one integration (a connect route and its attach job) the
 * later one stores the newer state.
 */
export async function persistLocalAgentIntegration(config: DkgConfig, id: string): Promise<void> {
  if (!getStoredLocalAgentIntegrations(config)[normalizeIntegrationId(id)]) return;
  await updateConfigFile(localAgentIntegrationEdits(config, id));
}
