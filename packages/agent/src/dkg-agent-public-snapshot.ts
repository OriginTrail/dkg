import { checkpointObservationAcceptor } from './snapshot-checkpoint-inventory.js';
export { PublicCheckpointMethods } from './dkg-agent-public-checkpoint.js';
import { PublicSnapshotProofRuntime } from './public-snapshot-proof-runtime.js';
import { resolveSnapshotSourcePolicies, type SnapshotSourcePolicyName } from './public-snapshot-policy.js';
import { registerCoreChainCacheHandlers } from './core-chain-cache-handler.js';
import { recoverPublicSnapshotToCurrent } from './public-snapshot-catch-up.js';
import { createOperationContext } from "@origintrail-official/dkg-core";
import { recoverPublicSnapshotBulk } from './public-snapshot-bulk.js';
import { recoverPublicSnapshotExact } from './public-snapshot-exact.js';
import { createPublicSnapshotHeldAssetCheck } from './public-snapshot-held-assets.js';
import { admitAuthenticatedContextGraphSubscription } from './context-graph-subscription-admission.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import { PublicSnapshotSessionMethods } from './public-snapshot-session.js';
import { createPublicSnapshotServingRuntime } from './public-snapshot-serving-runtime.js';
import { decodePublicGraphSnapshotRequest, PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES } from './public-snapshot-wire.js';
// SPDX-License-Identifier: Apache-2.0
import {
  PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES,
} from "@origintrail-official/dkg-chain";
import { buildKnowledgeAssetUalFromOnChainIdV1 } from "@origintrail-official/dkg-core";
import type { DKGAgent } from "./dkg-agent.js";
import {
  PublicSnapshotEvidence,
  markCoreTrustedGraph,
} from "./public-snapshot-evidence.js";

import { PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from "./public-snapshot-reader.js";
export { PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from "./public-snapshot-reader.js";
const encoder = new TextEncoder();
import { type PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { registerSnapshotSourceHandler } from './public-snapshot-source-handler.js';
export type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
export class PublicSnapshotMethods extends PublicSnapshotSessionMethods {
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
    return this.withPublicSnapshotSession(options, async session => {
      const { normalized: { contextGraphId, onChainId, mode, transport }, initial, sourcePlan,
        signal, deadline, startedAt, admitSubscription, assertCurrent, isCurrent, readFresh } = session;
      const snapshot = initial.snapshot;
      session.assertInitialInventoryCurrent();
      // From admission onward every captured write premise stays strict.
      // A validated public snapshot admits this job without scheduling the
      // daemon's separate legacy subscribe/catch-up pipeline.
      admitSubscription(() => {
        admitAuthenticatedContextGraphSubscription(this, contextGraphId, { onChainId, onChainHash: snapshot.nameHash });
      });
      assertCurrent();
      if (mode === "core-cache") await markCoreTrustedGraph(this.store, contextGraphId);
      assertCurrent();
      const caughtUp = await recoverPublicSnapshotToCurrent({
        initial, deadline, signal, assertCurrent,
        readFresh: () => readFresh(true),
        recover: async observation => {
          assertCurrent();
          const evidence = new PublicSnapshotEvidence(observation, isCurrent);
          const uals = observation.snapshot.assets.map(a => buildKnowledgeAssetUalFromOnChainIdV1(
            observation.snapshot.chainId, observation.snapshot.assetStorage, BigInt(a.id)));
          const recovery = { contextGraphId, peerBatches: sourcePlan.contentPeerBatches, uals, evidence, signal, assertCurrent };
          if (transport === 'bulk') {
            const { verification, reconcile } = DKGAgentBase.createDurableRecoveryCapabilities(this);
            return recoverPublicSnapshotBulk({
              store: this.store, router: this.router, verification, reconcile,
              ensurePeerConnected: (peer, options) => this.ensurePeerConnected(peer, options),
            }, { ...recovery, deadline, dataDir: this.config.dataDir,
              shouldQuarantineCommitted: () => {
                const current = this.subscribedContextGraphs.get(contextGraphId);
                return !current || (!current.subscribed && !current.coreHosted) || current.onChainId !== onChainId;
              },
              onCommitted: () => this.invalidateListContextGraphsCache(),
              log: message => this.log.info(createOperationContext('sync'), message),
            });
          }
          return recoverPublicSnapshotExact(DKGAgentBase.createDurableRecoveryCapabilities(this), {
            ...recovery, deadline, maxLanes: 2,
            canAdmit: () => this.vmRecoverySyncAdmissionAvailable(contextGraphId),
            holds: createPublicSnapshotHeldAssetCheck(this.store, evidence),
          });
        },
      });
      assertCurrent();
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
    }, { observationAcceptor: checkpointObservationAcceptor(this) });
  }
}
