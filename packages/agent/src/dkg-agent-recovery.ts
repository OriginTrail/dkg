// SPDX-License-Identifier: Apache-2.0
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { DurableRecoveryHost, RecoveryAdmissionRequest } from './durable-recovery-host.js';
import { createRecoveryAuthority } from './durable-recovery-authority.js';
import { RecoveryMaterializationOwner } from './durable-recovery-materialization.js';
import { reconcileAfterMaterialization } from './sync/requester/post-materialization.js';
import { deleteSyncPageCheckpoint } from './sync/requester/page-fetch.js';

/** Agent access boundary. Consumers receive operations; mutable fields remain agent-owned. */
export class RecoveryHostMethods extends DKGAgentBase {
  static create(agent: DKGAgent): DurableRecoveryHost {
    return RecoveryHostMethods.prototype.createDurableRecoveryCapabilities.call(agent);
  }

  protected createDurableRecoveryCapabilities(this: DKGAgent): DurableRecoveryHost {
    const cleanup: Parameters<typeof reconcileAfterMaterialization>[0] = {
      store: this.store, writeLocks: this.writeLocks, log: this.log,
      invalidateListContextGraphsCache: () => this.invalidateListContextGraphsCache(),
      retireFinalizedSwmTwinCandidate: (candidate, ctx) => this.retireFinalizedSwmTwinCandidate(candidate, ctx),
      retireLegacySwmAfterVerifiedVmTwin: params => this.retireLegacySwmAfterVerifiedVmTwin(params),
    };
    const reconcile: DurableRecoveryHost['reconcile'] = (asset, ctx) =>
      reconcileAfterMaterialization(cleanup, asset, ctx);
    const materialization = new RecoveryMaterializationOwner({
      chain: () => this.chain,
      store: () => this.store,
      isClosed: () => this.graphScopedStoreClosed,
      subscription: id => this.subscribedContextGraphs.get(id),
      bindingGeneration: id => this.contextGraphBindingState.capture(id),
      isBindingGenerationCurrent: (id, generation) => this.contextGraphBindingState.isGenerationCurrent(id, generation),
      track: run => { this.workLifetime.track(run); },
      verifyBinding: (id, onChainId, ctx, signal) => this.requireLocalCgMatchesOnChainSlot(id, onChainId, ctx, { signal }),
      persistSubscription: (id, subscription, reason, isCurrent) => this.persistContextGraphSyncStateStrict(id, subscription, reason, isCurrent),
      bindSubscription: (id, subscription, onChainId) => this.bindSubscriptionOnChainId(id, subscription, onChainId),
      recordDrops: (drops, seam) => this.oversizeTombstoneLog.record(drops, seam),
      reconcile,
    });
    return {
      owner: this,
      reconcile,
      policy: () => ({
        syncAgentsMeta: this.config.syncAgentsMeta,
        syncContextGraphPriorities: this.config.syncContextGraphPriorities,
      }),
      admission: {
        run: <T>({ ctx, contextGraphId, lane, label, work, ...admission }: RecoveryAdmissionRequest<T>): Promise<T> =>
          this.runContextGraphSyncWithBackpressure(ctx, contextGraphId, lane, label, work, admission),
      },
      transport: {
        fetchPages: (request, options) => {
          const { ctx, remotePeerId, contextGraphId, phase, graphUri, fetchContext } = request;
          return this.fetchSyncPages(ctx, remotePeerId, contextGraphId, false, phase, graphUri, fetchContext.deadline, {
            snapshotRef: request.snapshotRef, sinceBatchId: request.sinceBatchId,
            signal: fetchContext.signal,
            manifestDigest: request.manifestDigest,
            manifestPrefixDigestAtOffset: request.manifestPrefixDigestAtOffset,
            shouldStopAfterPage: request.shouldStopAfterPage,
            returnAcceptedPrefixOnRetryableTransportFailure: request.returnAcceptedPrefixOnRetryableTransportFailure,
            requesterScope: request.requesterScope,
            ephemeralRequesterState: request.ephemeralRequesterState,
            forceFreshSession: request.forceFreshSession || options.forceFreshSession,
            assetUals: options.assetUals,
            checkpointStore: options.checkpointStore,
          });
        },
        stream: (ctx, remotePeerId, contextGraphId) => ({
          router: this.router, capabilityOwner: this,
          captureConnectionKey: () => this.getSyncReconcilerConnectionKey(remotePeerId),
          captureRefusalScope: () => this.captureExperimentalExactBatchRefusalScope(contextGraphId),
          isChainEnabled: () => this.chain.chainId !== 'none',
          getPeerProtocols: () => this.getPeerProtocols(remotePeerId),
          requestIdentity: () => ({
            requesterPeerId: this.peerId,
            computeSyncDigest: (...args) => this.computeSyncDigest(...args),
            getIdentityId: () => this.chain.getIdentityId(),
            signMessage: typeof this.chain.signMessage === 'function' ? this.chain.signMessage.bind(this.chain) : undefined,
          }),
          reconnect: async signal => {
            try { await this.ensurePeerConnected(remotePeerId, { signal }); }
            catch { return false; }
            return this.node.libp2p.getConnections().some(connection => connection.remotePeer.toString() === remotePeerId);
          },
          logInfo: message => this.log.info(ctx, message),
        }),
      },
      verification: {
        processBatch: (...args) => this.processDurableBatchInWorker(...args),
        parseAndFilter: (...args) => this.getOrCreateSyncVerifyWorker().parseAndFilter(...args),
      },
      storeInsert: ({ quads, signal }) => this.insertSyncedQuadsAndInvalidateListCache(quads, {
        priority: 'background', source: 'agent.durableSync.storeInsert', signal,
      }),
      materialization: scope => materialization.forOperation(scope),
      checkpoints: {
        deleteCheckpoint: key => deleteSyncPageCheckpoint(this.syncCheckpoints, key),
        setCheckpoint: (key, checkpoint) => {
          if (checkpoint.binding) {
            this.syncCheckpoints.setManifestBoundOffset(key, checkpoint.offset, checkpoint.binding.manifestDigest,
              Date.now(), checkpoint.binding.manifestPrefixDigest, checkpoint.binding.terminal, checkpoint.responderSessionOffset);
          } else {
            this.syncCheckpoints.set(key, checkpoint.offset, Date.now(), checkpoint.responderSessionOffset);
          }
        },
      },
      log: {
        info: (ctx, message) => this.log.info(ctx, message),
        warn: (ctx, message) => this.log.warn(ctx, message),
        debug: (ctx, message) => this.log.debug(ctx, message),
      },
      resolveOrdinaryAuthority: (ctx, input) => createRecoveryAuthority({
        chain: this.chain,
        verifyContextGraphBinding: (id, onChainId, signal) => this.requireLocalCgMatchesOnChainSlot(id, onChainId, ctx, { signal }),
        resolveAuthority: (id, signal) => this.resolveRegisteredContextGraphAuthority(id, { authorityReadMode: 'finalized-index-or-live', signal }),
        warn: message => this.log.warn(ctx, message),
      }, input),
    };
  }
}

/** Also supports existing method-level fixtures with an explicit composed-agent receiver. */
export function createDurableRecoveryHost(agent: DKGAgent): DurableRecoveryHost {
  return RecoveryHostMethods.create(agent);
}
