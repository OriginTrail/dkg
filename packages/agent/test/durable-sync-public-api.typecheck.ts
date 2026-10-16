import type { DKGAgent } from '../src/index.js';
import type { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

declare const agent: DKGAgent;
declare const lifecycle: LifecycleSyncMethods;
// @ts-expect-error The admitted executor is not a public SDK entry point.
void agent.runAdmittedLegacyDurableContextGraph;
// @ts-expect-error Internal lifecycle policy is protected on the mixin as well.
void lifecycle.runAdmittedLegacyDurableContextGraph;
// @ts-expect-error The internal authority executor is not an SDK entry point.
void agent.runDurableSyncWithAuthority;
// @ts-expect-error Snapshot policy execution is not an SDK entry point.
void agent.runExactSyncWithAuthority;
// @ts-expect-error Static internal bridges are not mixed into SDK instances.
void agent.recoverSnapshotExactAssets;
declare const authority: import('../src/durable-recovery-authority.js').DurableRecoveryAuthority;
declare const context: import('@origintrail-official/dkg-core').OperationContext;
// @ts-expect-error Public exact options cannot inject an authentication strategy.
void agent.syncExactKnowledgeAssetsFromPeerDetailed('peer', 'graph', ['ual'], { recoveryAuthority: authority });
// @ts-expect-error Public durable options cannot inject an authentication strategy.
void agent.runLegacyDurableSyncDetailed(context, 'peer', ['graph'], undefined, undefined, undefined, { recoveryAuthority: authority });
// @ts-expect-error Public per-graph options cannot inject an authentication strategy.
void agent.runLegacyDurableSyncForContextGraphDetailed(context, 'peer', 'graph', 1, { recoveryAuthority: authority });
