// SPDX-License-Identifier: Apache-2.0
import { RpcUsageScope } from '@origintrail-official/dkg-chain';
import { startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { PublicSnapshotObservation } from './public-snapshot-evidence.js';
import { normalizePublicSnapshotSyncOptions, type PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { createPublicSnapshotSourcePlan } from './public-snapshot-source-plan.js';
import { createPublicSnapshotReader } from './public-snapshot-reader.js';
import { runGraphScopedPhysicalOperation } from './sync/requester/graph-scoped-operation-fence.js';
import { isContextGraphSubscriptionStoredAgain, contextGraphSubscriptionAdmissionPremisesEqual } from './context-graph-subscription-policy.js';

const jobs = new WeakSet<DKGAgent>();
export interface PublicSnapshotObservationAcceptor {
  accept(observation: PublicSnapshotObservation): Promise<void>;
}
interface PublicSnapshotSession {
  normalized: ReturnType<typeof normalizePublicSnapshotSyncOptions>;
  sourcePlan: Awaited<ReturnType<typeof createPublicSnapshotSourcePlan>>;
  initial: PublicSnapshotObservation;
  startedAt: number; deadline: number; signal: AbortSignal;
  assertInitialInventoryCurrent(): void;
  assertCurrent(): void;
  isCurrent(): boolean;
  admitSubscription(admit: () => void): void;
  readBeforeAdmission(refresh?: boolean): Promise<PublicSnapshotObservation>;
  readFresh(refresh?: boolean): Promise<PublicSnapshotObservation>;
}

/** One foreground owner and lifetime, with explicit caller-owned observation acceptance. */
export class PublicSnapshotSessionMethods extends DKGAgentBase {
  protected async withPublicSnapshotSession<T>(this: DKGAgent, options: PublicSnapshotSyncOptions,
    run: (session: PublicSnapshotSession) => Promise<T>, controls: {
      ownershipError?: string; observationAcceptor?: PublicSnapshotObservationAcceptor;
    } = {}): Promise<T> {
    const ownershipError = controls.ownershipError ?? 'Snapshot job ownership changed';
    const normalized = normalizePublicSnapshotSyncOptions(options);
    const { contextGraphId, onChainId, mode } = normalized;
    if (jobs.has(this)) throw new Error('A snapshot job is already running');
    if (!this.started || this.workLifetime.closed) throw new Error('Node is stopping');
    jobs.add(this);
    const lifetime = this.workLifetime.generation, startedAt = Date.now(), deadline = startedAt + 3_600_000;
    const lifecycle = startRequestAbortLifecycle(3_600_000, [this.workLifetime.signal, options.signal]);
    const { signal } = lifecycle;
    const rpcScope = new RpcUsageScope();
    try {
      try {
        const activation = this.waitForContextGraphSubscriptionActivation(contextGraphId, signal);
        if (activation) (await activation).assertCurrent();
      } catch (cause) { throw new Error(ownershipError, { cause }); }
      const subscription = this.subscribedContextGraphs.get(contextGraphId);
      if (subscription && !subscription.subscribed && !subscription.coreHosted) throw new Error('Graph subscription is inactive');
      if (subscription?.onChainId && subscription.onChainId !== onChainId) throw new Error('Graph binding differs from requested snapshot');
      return await rpcScope.run(() => runGraphScopedPhysicalOperation({
        contextGraphId, signal,
        isClosed: () => !this.started || this.workLifetime.closed,
        captureSubscription: () => this.subscribedContextGraphs.get(contextGraphId),
        captureBindingGeneration: () => this.contextGraphBindingState.capture(contextGraphId),
        isBindingGenerationCurrent: generation => this.contextGraphBindingState.isGenerationCurrent(contextGraphId, generation),
        // Readiness-only changes may be adopted before admission; replacement and rebinding may not.
        isEquivalentSubscription: (captured, current) => isContextGraphSubscriptionStoredAgain(captured, current)
          && contextGraphSubscriptionAdmissionPremisesEqual(captured, current),
        assertLifecycleCurrent: () => { if (lifetime !== this.workLifetime.generation) throw new Error(ownershipError); },
        closedError: () => new Error('Node is stopping'), bindingChangedError: () => new Error(ownershipError),
        asAbortError: reason => new Error(ownershipError, { cause: reason }),
        track: physical => { this.workLifetime.track(physical); },
        operation: async control => {
          const assertInitialInventoryCurrent = () => { control.adoptEquivalentSubscription(); control.assertCurrent(); };
          const assertCurrent = () => control.assertCurrent();
          const isCurrent = () => { try { assertCurrent(); return true; } catch { return false; } };
          const sourcePlan = await createPublicSnapshotSourcePlan({ config: this.config, chain: this.chain,
            peerId: this.peerId, router: this.router, node: this.node, discovery: this.discovery,
            peerResolver: this.peerResolver, networkAdmissionCoordinator: this.networkAdmissionCoordinator,
            ensurePeerConnected: (peer, opts) => this.ensurePeerConnected(peer, opts),
          }, normalized, signal, rpcScope);
          assertInitialInventoryCurrent();
          const readerOptions = { mode, chain: this.chain, request: sourcePlan.request, peers: sourcePlan.inventoryPeers,
            signal, expected: { chainId: this.chain.chainId, deploymentId: this.chain.deploymentId!, contextGraphId, onChainId } };
          // Every accepted authority observation crosses this one boundary before
          // admission, recovery, or freshness completion can consume it. Preparation
          // supplies no persistence capability and remains non-mutating.
          const observe = (assertObservationCurrent: () => void) => {
            const read = createPublicSnapshotReader({ ...readerOptions, assertCurrent: assertObservationCurrent });
            return async (refresh?: boolean) => {
              const observation = await read(refresh); assertObservationCurrent();
              if (subscription?.onChainHash && subscription.onChainHash.toLowerCase() !== observation.snapshot.nameHash.toLowerCase())
                throw new Error('Graph name binding differs from requested snapshot');
              await controls.observationAcceptor?.accept(observation);
              assertObservationCurrent();
              return observation;
            };
          };
          const readBeforeAdmission = observe(assertInitialInventoryCurrent);
          const initial = await readBeforeAdmission();
          return run({ normalized, sourcePlan, initial, startedAt, deadline, signal, assertInitialInventoryCurrent,
            assertCurrent, isCurrent, admitSubscription: admit => control.admitSubscription(admit), readBeforeAdmission,
            readFresh: observe(assertCurrent) });
        },
      }));
    } finally { lifecycle.release(); jobs.delete(this); }
  }
}
