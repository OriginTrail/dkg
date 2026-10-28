// SPDX-License-Identifier: Apache-2.0
import { RpcUsageScope } from '@origintrail-official/dkg-chain';
import { startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import { buildNativeSnapshotCheckpoint } from './snapshot-native-build.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { createPublicSnapshotSourcePlan } from './public-snapshot-source-plan.js';
import { createPublicSnapshotReader } from './public-snapshot-reader.js';
import { normalizePublicSnapshotSyncOptions, type PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { preparePublicSnapshotCheckpoint, assertCheckpointInventoryUnchanged } from './public-snapshot-checkpoint.js';
import { runGraphScopedPhysicalOperation } from './sync/requester/graph-scoped-operation-fence.js';
import { isContextGraphSubscriptionStoredAgain, contextGraphSubscriptionAdmissionPremisesEqual } from './context-graph-subscription-policy.js';

/** Shared exclusion with ordinary foreground snapshot recovery. */
export const publicSnapshotJobs = new WeakSet<DKGAgent>();

export class PublicCheckpointMethods extends DKGAgentBase {
/** Drain startup discovery before taking a foreground graph-ownership snapshot. */
async waitForPublicCheckpointStartup(this: DKGAgent, contextGraphId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await this.chainPoller?.waitForCurrentPoll();
  signal.throwIfAborted();
  const activation = this.waitForContextGraphSubscriptionActivation(contextGraphId, signal);
  if (activation) (await activation).assertCurrent();
  signal.throwIfAborted();
}
async preparePublicGraphCheckpoint(this: DKGAgent, options: PublicSnapshotSyncOptions, nativeBuild = false) {
  const runtime = nativeBuild ? { java: process.env.DKG_PUBLIC_CHECKPOINT_JAVA ?? '',
    jar: process.env.DKG_PUBLIC_CHECKPOINT_JAR ?? '', jarSha256: process.env.DKG_PUBLIC_CHECKPOINT_JAR_SHA256 ?? '' } : undefined;
  if (runtime && (!runtime.java || !runtime.jar || !/^[a-f0-9]{64}$/.test(runtime.jarSha256)))
    throw new Error('Native checkpoint runtime is not configured');
  const normalized = normalizePublicSnapshotSyncOptions(options);
  const { contextGraphId, onChainId, mode } = normalized;
  if (!this.config.dataDir) throw new Error('Checkpoint requires a persistent data directory');
  if (!this.started || this.workLifetime.closed) throw new Error('Node is stopping');
  if (publicSnapshotJobs.has(this)) throw new Error('A snapshot job is already running');
  publicSnapshotJobs.add(this);
  const lifetime = this.workLifetime.generation;
  const lifecycle = startRequestAbortLifecycle(3_600_000, [this.workLifetime.signal, options.signal]);
  const { signal } = lifecycle;
  const deadline = Date.now() + 3_600_000;
  const rpcScope = new RpcUsageScope();
  try {
    const activation = this.waitForContextGraphSubscriptionActivation(contextGraphId, signal);
    if (activation) (await activation).assertCurrent();
    const subscription = this.subscribedContextGraphs.get(contextGraphId);
    if (subscription && (!subscription.subscribed && !subscription.coreHosted)) throw new Error('Graph subscription is inactive');
    if (subscription?.onChainId && subscription.onChainId !== onChainId) throw new Error('Graph binding differs from requested checkpoint');
    return await rpcScope.run(() => runGraphScopedPhysicalOperation({
      contextGraphId, signal,
      isClosed: () => !this.started || this.workLifetime.closed,
      captureSubscription: () => this.subscribedContextGraphs.get(contextGraphId),
      captureBindingGeneration: () => this.contextGraphBindingState.capture(contextGraphId),
      isBindingGenerationCurrent: generation => this.contextGraphBindingState.isGenerationCurrent(contextGraphId, generation),
      isEquivalentSubscription: (captured, current) => isContextGraphSubscriptionStoredAgain(captured, current)
        && contextGraphSubscriptionAdmissionPremisesEqual(captured, current),
      assertLifecycleCurrent: () => { if (lifetime !== this.workLifetime.generation) throw new Error('Checkpoint ownership changed'); },
      closedError: () => new Error('Node is stopping'), bindingChangedError: () => new Error('Checkpoint ownership changed'),
      asAbortError: reason => new Error('Checkpoint ownership changed', { cause: reason }),
      track: run => { this.workLifetime.track(run); },
      operation: async control => {
        const assertCurrent = () => { control.adoptEquivalentSubscription(); control.assertCurrent(); };
        assertCurrent();
        const plan = await createPublicSnapshotSourcePlan({ config: this.config, chain: this.chain,
          peerId: this.peerId, router: this.router, node: this.node, discovery: this.discovery,
          peerResolver: this.peerResolver, networkAdmissionCoordinator: this.networkAdmissionCoordinator,
          ensurePeerConnected: (peer, opts) => this.ensurePeerConnected(peer, opts),
        }, normalized, signal, rpcScope);
        const read = createPublicSnapshotReader({ mode, chain: this.chain, request: plan.request,
          peers: plan.inventoryPeers, signal, assertCurrent, expected: { contextGraphId, onChainId,
            chainId: this.chain.chainId, deploymentId: this.chain.deploymentId! } });
        const initial = await read();
        assertCurrent();
        if (subscription?.onChainHash && subscription.onChainHash.toLowerCase() !== initial.snapshot.nameHash.toLowerCase())
          throw new Error('Graph name binding differs from requested checkpoint');
        // No subscription admission, metadata writes, reconciliation, or active-store mutation.
        const prepared = await preparePublicSnapshotCheckpoint({ router: this.router,
          ensurePeerConnected: (peer, opts) => this.ensurePeerConnected(peer, opts) }, {
          initial, readFresh: () => read(true), peerBatches: plan.contentPeerBatches,
          dataDir: this.config.dataDir!, signal, deadline, assertCurrent,
        });
        const native = runtime ? await buildNativeSnapshotCheckpoint(prepared, { ...runtime, signal,
          assertInventoryCurrent: async () => { const fresh = await read(true); assertCurrent(); assertCheckpointInventoryUnchanged(initial, fresh); },
        }) : undefined;
        return { directory: prepared.directory, assets: prepared.manifest.assets.length,
          inventoryDigest: initial.snapshot.inventoryDigest, mode, committed: 0, current: false,
          activeStoreChanged: false, state: 'verified-unpublished', ...(native ? { native } : {}) };
      },
    }));
  } finally { lifecycle.release(); publicSnapshotJobs.delete(this); }
}
}
