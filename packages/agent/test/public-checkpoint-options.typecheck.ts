import type { DKGAgent, createFreshPublicCheckpointEdge, resumePublicCheckpointEdge } from '../src/index.js';

type Preparation = Parameters<DKGAgent['preparePublicGraphCheckpoint']>[0];
type FreshSources = Parameters<typeof createFreshPublicCheckpointEdge>[0]['sync'];
type RestartSources = Parameters<typeof resumePublicCheckpointEdge>[0]['sync'];
type Recovery = Parameters<DKGAgent['syncPublicGraphSnapshot']>[0];
const sources = { contextGraphId: 'public', onChainId: '14', trustedCorePeerIds: ['core'] };
const signal = new AbortController().signal;
const preparation: Preparation = { ...sources, signal };
const fresh: FreshSources = sources;
const restart: RestartSources = { ...sources, trustedCorePeerIds: [], sourcePolicy: 'DKG_Core_chain_cache' };
const recovery: Recovery = { ...sources, signal, transport: 'bulk' };
// @ts-expect-error Preparation owns checkpoint transport; callers cannot select bulk/exact recovery.
const ignoredTransport: Preparation = { ...sources, transport: 'bulk' };
// @ts-expect-error Fresh activation has one outer job signal, not a nested ignored signal.
const ignoredFreshSignal: FreshSources = { ...sources, signal };
// @ts-expect-error Fresh activation always performs exact catch-up.
const ignoredFreshTransport: FreshSources = { ...sources, transport: 'bulk' };
// @ts-expect-error Restart has one outer job signal, not a nested ignored signal.
const ignoredRestartSignal: RestartSources = { ...sources, signal };
// @ts-expect-error Restart always performs exact catch-up.
const ignoredRestartTransport: RestartSources = { ...sources, transport: 'exact' };
// @ts-expect-error Typed recovery options cannot smuggle ignored controls into activation.
const nestedRecovery: FreshSources = recovery;
// @ts-expect-error Explicit peers and the registered-core policy remain mutually exclusive.
const mixed: Preparation = { ...sources, sourcePolicy: 'DKG_Core_chain_cache' };
void [preparation, fresh, restart, recovery, ignoredTransport, ignoredFreshSignal,
  ignoredFreshTransport, ignoredRestartSignal, ignoredRestartTransport, nestedRecovery, mixed];
