import { PublicSnapshotProofRuntime } from './public-snapshot-proof-runtime.js';
import { resolveSnapshotSourcePolicies, type SnapshotSourcePolicyName } from './public-snapshot-policy.js';
import { registerCoreChainCacheHandlers } from './core-chain-cache-handler.js';
import { createPublicSnapshotSourcePlan } from './public-snapshot-source-plan.js';
import { recoverPublicSnapshotToCurrent } from './public-snapshot-catch-up.js';
import { createOperationContext } from "@origintrail-official/dkg-core";
import { recoverPublicSnapshotBulk } from './public-snapshot-bulk.js';
import { recoverPublicSnapshotExact } from './public-snapshot-exact.js';
import { createPublicSnapshotHeldAssetCheck } from './public-snapshot-held-assets.js';
import { isContextGraphSubscriptionStoredAgain, contextGraphSubscriptionAdmissionPremisesEqual } from './context-graph-subscription-policy.js';
import { admitAuthenticatedContextGraphSubscription } from './context-graph-subscription-admission.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import { createPublicSnapshotServingRuntime } from './public-snapshot-serving-runtime.js';
import { decodePublicGraphSnapshotRequest, PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES } from './public-snapshot-wire.js';
// SPDX-License-Identifier: Apache-2.0
import {
  PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES, RpcUsageScope,
} from "@origintrail-official/dkg-chain";
import { startRequestAbortLifecycle, buildKnowledgeAssetUalFromOnChainIdV1 } from "@origintrail-official/dkg-core";
import { runGraphScopedPhysicalOperation } from "./sync/requester/graph-scoped-operation-fence.js";
import type { DKGAgent } from "./dkg-agent.js";
import {
  PublicSnapshotEvidence,
  markCoreTrustedGraph,
} from "./public-snapshot-evidence.js";

import { createPublicSnapshotReader, PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from "./public-snapshot-reader.js";
export { PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from "./public-snapshot-reader.js";
const encoder = new TextEncoder();
const jobs = new WeakSet<DKGAgent>();
import { normalizePublicSnapshotSyncOptions, type PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { registerSnapshotSourceHandler } from './public-snapshot-source-handler.js';
export type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
export class PublicSnapshotMethods extends DKGAgentBase {
  getPublicSnapshotSourcePolicies(this: DKGAgent): readonly SnapshotSourcePolicyName[] {
    return resolveSnapshotSourcePolicies(this.chain, this.config.coreChainCacheNetworks).map(policy => policy.name);
  }
  startPublicGraphSnapshots(this: DKGAgent): void {
    if (this.config.nodeRole !== 'core') return;
    const proofRuntime = new PublicSnapshotProofRuntime(this.chain, this.workLifetime);
    const runtime = createPublicSnapshotServingRuntime(this.chain, this.config.coreChainCacheNetworks, this.workLifetime);
    registerCoreChainCacheHandlers({
      nodeRole: this.config.nodeRole, chain: this.chain, peerId: this.peerId, router: this.router,
      proofRuntime, runtime, workLifetime: this.workLifetime, networks: this.config.coreChainCacheNetworks,
    });
    if (!this.chain.readPublicGraphSnapshot) return;
    registerSnapshotSourceHandler({
      nodeRole: this.config.nodeRole, chain: this.chain, router: this.router,
      peerId: this.peerId, proofRuntime,
      isPrivateContextGraph: (id, options) => this.isPrivateContextGraph(id, options),
      captureHosted: (id, onChainId) => {
        const generation = this.contextGraphBindingState.capture(id);
        return () => {
          const sub = this.subscribedContextGraphs.get(id);
          if (!(sub?.subscribed || sub?.coreHosted) || sub.onChainId !== onChainId
            || !this.contextGraphBindingState.isGenerationCurrent(id, generation)) throw new Error('Unavailable');
        };
      },
    });
    this.router.register(
      PUBLIC_GRAPH_SNAPSHOT_PROTOCOL,
      async (data, peer) => {
        try {
          const request = decodePublicGraphSnapshotRequest(data);
          if (
            !(this.subscribedContextGraphs.get(request.contextGraphId)?.subscribed
              || this.subscribedContextGraphs.get(request.contextGraphId)?.coreHosted)
          )
            throw new Error("Unavailable");
          const generation = this.contextGraphBindingState.capture(request.contextGraphId);
          const lifetime = this.workLifetime.generation;
          const snapshot = await runtime.get(
            peer.toString(),
            { deploymentId: this.chain.deploymentId!, contextGraphId: request.contextGraphId, onChainId: request.onChainId },
            request.refresh,
          );
          if (lifetime !== this.workLifetime.generation
            || !this.contextGraphBindingState.isGenerationCurrent(request.contextGraphId, generation)
            || !(this.subscribedContextGraphs.get(request.contextGraphId)?.subscribed
              || this.subscribedContextGraphs.get(request.contextGraphId)?.coreHosted)) throw new Error("Unavailable");
          const response = encoder.encode(JSON.stringify(snapshot));
          if (response.length > PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES)
            throw new Error("Response too large");
          return response;
        } catch {
          // Private, missing, overloaded and RPC-unavailable graphs have one refusal.
          return encoder.encode('{"unavailable":true}');
        }
      },
      { maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES },
    );
  }
  /** Explicit foreground job. The existing background reconciler's trust policy is unchanged. */
  async syncPublicGraphSnapshot(
    this: DKGAgent,
    options: PublicSnapshotSyncOptions,
  ) {
    const normalized = normalizePublicSnapshotSyncOptions(options);
    const { contextGraphId, onChainId, mode, transport } = normalized;
    const rpcScope = new RpcUsageScope();
    if (jobs.has(this)) throw new Error("A snapshot job is already running");
    if (!this.started || this.workLifetime.closed) throw new Error("Node is stopping");
    const lifetime = this.workLifetime.generation;
    jobs.add(this);
    const startedAt = Date.now();
    const lifecycle = startRequestAbortLifecycle(3_600_000, [
      this.workLifetime.signal, options.signal,
    ]);
    const { signal } = lifecycle;
    try {
      // Subscription lifecycle owns provisional state and the abortable wait.
      // Its wait consumes this job's original deadline and issues no RPC.
      try {
        const activation = this.waitForContextGraphSubscriptionActivation(contextGraphId, signal);
        // A committed subscription must capture ownership in this same turn.
        if (activation) await activation;
      }
      catch (cause) { throw new Error('Snapshot job ownership changed', { cause }); }
      const subscription = this.subscribedContextGraphs.get(contextGraphId);
      if (subscription && (!subscription.subscribed && !subscription.coreHosted))
        throw new Error("Graph subscription is inactive");
      if (subscription?.onChainId && subscription.onChainId !== onChainId)
        throw new Error("Graph binding differs from requested snapshot");
      return await rpcScope.run(() => runGraphScopedPhysicalOperation({
        contextGraphId, signal,
        isClosed: () => !this.started || this.workLifetime.closed,
        captureSubscription: () => this.subscribedContextGraphs.get(contextGraphId),
        captureBindingGeneration: () => this.contextGraphBindingState.capture(contextGraphId),
        isBindingGenerationCurrent: generation => this.contextGraphBindingState.isGenerationCurrent(contextGraphId, generation),
        // Before admission, inventory reads depend on selection and binding,
        // not the startup metadata readiness flags. A deleted/recreated row or
        // changed binding generation remains a different owner.
        isEquivalentSubscription: (captured, current) =>
          isContextGraphSubscriptionStoredAgain(captured, current)
          && contextGraphSubscriptionAdmissionPremisesEqual(captured, current),
        assertLifecycleCurrent: () => { if (lifetime !== this.workLifetime.generation) throw new Error("Snapshot job ownership changed"); },
        closedError: () => new Error("Node is stopping"),
        bindingChangedError: () => new Error("Snapshot job ownership changed"),
        asAbortError: reason => new Error("Snapshot job ownership changed", { cause: reason }),
        track: run => { this.workLifetime.track(run); },
        operation: async control => {
          let readingInitialInventory = true;
          const assertCurrent = () => {
            if (readingInitialInventory) control.adoptEquivalentSubscription();
            control.assertCurrent();
          };
          const isCurrent = () => { try { assertCurrent(); return true; } catch { return false; } };
          const sourcePlan = await createPublicSnapshotSourcePlan({
            config: this.config, chain: this.chain, peerId: this.peerId, router: this.router,
            node: this.node, discovery: this.discovery, peerResolver: this.peerResolver,
            networkAdmissionCoordinator: this.networkAdmissionCoordinator,
            ensurePeerConnected: (peer, options) => this.ensurePeerConnected(peer, options),
          }, normalized, signal, rpcScope);
          const peers = sourcePlan.inventoryPeers;
          assertCurrent();
          const expected = {
            chainId: this.chain.chainId,
            deploymentId: this.chain.deploymentId!,
            contextGraphId,
            onChainId,
          };
          const read = createPublicSnapshotReader({ mode, chain:this.chain, request: sourcePlan.request,
            peers, signal, expected, assertCurrent });
          const initial = await read();
          const snapshot = initial.snapshot;
          assertCurrent();
          if (subscription?.onChainHash && subscription.onChainHash.toLowerCase() !== snapshot.nameHash.toLowerCase())
            throw new Error("Graph name binding differs from requested snapshot");
          // From admission onward every captured write premise stays strict.
          readingInitialInventory = false;
          // A validated public snapshot admits this job without scheduling the
          // daemon's separate legacy subscribe/catch-up pipeline.
          control.admitSubscription(() => {
            admitAuthenticatedContextGraphSubscription(this, contextGraphId, { onChainId, onChainHash: snapshot.nameHash });
          });
          assertCurrent();
          if (mode === "core-cache") await markCoreTrustedGraph(this.store, contextGraphId);
          assertCurrent();
          const caughtUp = await recoverPublicSnapshotToCurrent({
            initial, deadline: startedAt + 3_600_000, signal, assertCurrent,
            readFresh: () => read(true),
            recover: async observation => {
              const evidence = new PublicSnapshotEvidence(observation, isCurrent);
              const uals = observation.snapshot.assets.map(a => buildKnowledgeAssetUalFromOnChainIdV1(
                observation.snapshot.chainId, observation.snapshot.assetStorage, BigInt(a.id)));
              const recovery = { contextGraphId, peerBatches: sourcePlan.contentPeerBatches, uals, evidence, signal, assertCurrent };
              if (transport === 'bulk') {
                const { verification, reconcile } = DKGAgentBase.createDurableRecoveryCapabilities(this);
                return recoverPublicSnapshotBulk({
                  store: this.store, router: this.router, verification, reconcile,
                  ensurePeerConnected: (peer, options) => this.ensurePeerConnected(peer, options),
                }, { ...recovery, deadline: startedAt + 3_600_000, dataDir: this.config.dataDir,
                  shouldQuarantineCommitted: () => {
                    const current = this.subscribedContextGraphs.get(contextGraphId);
                    return !current || (!current.subscribed && !current.coreHosted) || current.onChainId !== onChainId;
                  },
                  onCommitted: () => this.invalidateListContextGraphsCache(),
                  log: message => this.log.info(createOperationContext('sync'), message),
                });
              }
              return recoverPublicSnapshotExact(DKGAgentBase.createDurableRecoveryCapabilities(this), {
                ...recovery, deadline: startedAt + 3_600_000, maxLanes: 2,
                canAdmit: () => this.vmRecoverySyncAdmissionAvailable(contextGraphId),
                holds: createPublicSnapshotHeldAssetCheck(this.store, evidence),
              });
            },
          });
          const { committed, alreadyPresent } = caughtUp.recovered;
          const { snapshot: finalSnapshot, sourceCore } = caughtUp.observation;
          const { bulkChunks, fresh } = caughtUp;
          return {
            mode, transport, bulkChunks,
            ...sourcePlan.report(),
            sourceCore,
            coverageSourceCore: fresh.sourceCore,
            snapshotDigest: finalSnapshot.snapshotDigest,
            blockNumber: finalSnapshot.blockNumber,
            blockHash: finalSnapshot.blockHash,
            inventoryDigest: finalSnapshot.inventoryDigest,
            assets: finalSnapshot.assets.length,
            committed: committed.size,
            ...(alreadyPresent === undefined ? {} : { alreadyPresent }),
            completeAsOfSnapshot: true,
            current: true,
            catchUpRounds: caughtUp.rounds,
            startedAt,
            finishedAt: Date.now(),
            elapsedMs: Date.now() - startedAt,
          };
        },
      }));
    } finally {
      lifecycle.release();
      jobs.delete(this);
    }
  }
}
