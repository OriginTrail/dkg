import type { DkgHomeFiles } from '../src/config.js';
import { DkgConfigStore, mutableConfigSnapshot } from '../src/daemon-config-store.js';
import { getStoredLocalAgentIntegrations, getLocalAgentIntegration } from '../src/daemon/local-agents.js';
import { resolveContextGraphs, resolveSharedMemoryTtlMs, resolveChainConfig, resolveNetworkConfigName } from '../src/config.js';

declare const store: DkgConfigStore;
declare const files: DkgHomeFiles;
const current = store.current;
// @ts-expect-error Committed top-level state is immutable.
current.name = 'mutated';
// @ts-expect-error Nested integration state is recursively immutable.
current.localAgentIntegrations!.openclaw.enabled = false;
// @ts-expect-error Nested runtime fields are recursively immutable.
current.localAgentIntegrations!.openclaw.runtime!.ready = false;
// @ts-expect-error Configuration arrays cannot be changed in place.
current.contextGraphs!.push('mutated');
const integrations = getStoredLocalAgentIntegrations(current);
// @ts-expect-error A selector must preserve the frozen input contract.
integrations.openclaw.enabled = false;
// @ts-expect-error Only the canonical factory may construct configuration handles.
new DkgConfigStore(files, current);
getLocalAgentIntegration(current, 'openclaw');
resolveContextGraphs(current);
resolveSharedMemoryTtlMs(current);
const draft = mutableConfigSnapshot(current);
draft.name = 'draft';
draft.localAgentIntegrations!.openclaw.enabled = false;
draft.contextGraphs!.push('draft');
void store.update(latest => {
  const next = mutableConfigSnapshot(latest);
  next.name = 'committed through owner';
  return next;
}, 'configuration-only');

// Existing mutable configurations and full chain literals remain valid reader inputs.
resolveChainConfig(draft, null);
resolveNetworkConfigName(draft);
resolveNetworkConfigName(current);
resolveNetworkConfigName({ chain: { rpcUrl: 'http://localhost:8545', rpcUrls: ['http://localhost:8546'] as const } });

// @ts-expect-error A live commit must declare its activation semantics.
void store.update(latest => latest);
// @ts-expect-error Runtime activation must provide compensation.
void store.update(latest => latest, () => ({ apply() {} }));
