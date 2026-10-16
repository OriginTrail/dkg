import { createDurableRecoveryHost } from './dkg-agent-recovery.js';
import type { PublicSnapshotRecoveryResult } from './public-snapshot-recovery.js';
import { createOperationContext } from "@origintrail-official/dkg-core";
import { recoverPublicSnapshotBulk } from './public-snapshot-bulk.js';
import { recoverPublicSnapshotExact } from './public-snapshot-exact.js';
import { admitAuthenticatedContextGraphSubscription } from './context-graph-subscription-admission.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import { PublicSnapshotServingRuntime } from './public-snapshot-serving-runtime.js';
import { decodePublicGraphSnapshotRequest, PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES } from './public-snapshot-wire.js';
// SPDX-License-Identifier: Apache-2.0
import {
  PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES,
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
export type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
export class PublicSnapshotMethods extends DKGAgentBase {
  startPublicGraphSnapshots(this: DKGAgent): void {
    if (this.config.nodeRole !== "core" || !this.chain.readPublicGraphSnapshot)
      return;
    const runtime = new PublicSnapshotServingRuntime(
      (id, onChainId, signal) => this.chain.readPublicGraphSnapshot!(id, onChainId, { signal }),
      this.workLifetime,
    );
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
            request.contextGraphId,
            request.onChainId,
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
    const { contextGraphId, onChainId, mode, transport, trustedCorePeerIds: peers } = normalized;
    if (jobs.has(this)) throw new Error("A snapshot job is already running");
    if (!this.started || this.workLifetime.closed) throw new Error("Node is stopping");
    const subscription = this.subscribedContextGraphs.get(contextGraphId);
    if (subscription && (!subscription.subscribed && !subscription.coreHosted))
      throw new Error("Graph subscription is inactive");
    if (subscription?.onChainId && subscription.onChainId !== onChainId)
      throw new Error("Graph binding differs from requested snapshot");
    const lifetime = this.workLifetime.generation;
    jobs.add(this);
    const startedAt = Date.now();
    const lifecycle = startRequestAbortLifecycle(3_600_000, [
      this.workLifetime.signal, options.signal,
    ]);
    const { signal } = lifecycle;
    try {
      return await runGraphScopedPhysicalOperation({
        contextGraphId, signal,
        isClosed: () => !this.started || this.workLifetime.closed,
        captureSubscription: () => this.subscribedContextGraphs.get(contextGraphId),
        captureBindingGeneration: () => this.contextGraphBindingState.capture(contextGraphId),
        isBindingGenerationCurrent: generation => this.contextGraphBindingState.isGenerationCurrent(contextGraphId, generation),
        assertLifecycleCurrent: () => { if (lifetime !== this.workLifetime.generation) throw new Error("Snapshot job ownership changed"); },
        closedError: () => new Error("Node is stopping"),
        bindingChangedError: () => new Error("Snapshot job ownership changed"),
        asAbortError: reason => new Error("Snapshot job ownership changed", { cause: reason }),
        track: run => { this.workLifetime.track(run); },
        operation: async control => {
          const assertCurrent = control.assertCurrent;
          const isCurrent = () => { try { assertCurrent(); return true; } catch { return false; } };
          const expected = {
            chainId: this.chain.chainId,
            deploymentId: this.chain.deploymentId!,
            contextGraphId,
            onChainId,
          };
          const read = createPublicSnapshotReader({ mode, chain:this.chain, router:this.router,
            peers, signal, expected, assertCurrent });
          const initial = await read();
          const snapshot = initial.snapshot;
          assertCurrent();
          if (subscription?.onChainHash && subscription.onChainHash.toLowerCase() !== snapshot.nameHash.toLowerCase())
            throw new Error("Graph name binding differs from requested snapshot");
          const evidence = new PublicSnapshotEvidence(initial, isCurrent);
          // A validated public snapshot admits this job without scheduling the
          // daemon's separate legacy subscribe/catch-up pipeline.
          control.admitSubscription(() => {
            admitAuthenticatedContextGraphSubscription(this, contextGraphId, { onChainId, onChainHash: snapshot.nameHash });
          });
          assertCurrent();
          if (mode === "core-cache") await markCoreTrustedGraph(this.store, contextGraphId);
          assertCurrent();
          const uals = snapshot.assets.map((a) => buildKnowledgeAssetUalFromOnChainIdV1(snapshot.chainId, snapshot.assetStorage, BigInt(a.id)));
          const recovery = { contextGraphId, peers, uals, evidence, signal, assertCurrent };
          let recovered: PublicSnapshotRecoveryResult;
          if (transport === 'bulk') {
            const { verification, reconcile } = createDurableRecoveryHost(this);
            recovered = await recoverPublicSnapshotBulk({
              store: this.store, router: this.router, verification, reconcile,
              ensurePeerConnected: (peer, options) => this.ensurePeerConnected(peer, options),
            }, { ...recovery,
              deadline: startedAt + 3_600_000, dataDir: this.config.dataDir,
              shouldQuarantineCommitted: () => {
                const current = this.subscribedContextGraphs.get(contextGraphId);
                return !current || (!current.subscribed && !current.coreHosted) || current.onChainId !== onChainId;
              },
              onCommitted: () => this.invalidateListContextGraphsCache(),
              log: message => this.log.info(createOperationContext('sync'), message),
            });
          } else recovered = await recoverPublicSnapshotExact(this, recovery);
          const { committed, bulkChunks } = recovered;

          // A new inventory/root comparison is required before claiming current coverage.
          const fresh = await read(true);
          assertCurrent();
          const current =
            fresh.snapshot.inventoryDigest === snapshot.inventoryDigest &&
            fresh.snapshot.assetStorage === snapshot.assetStorage &&
            fresh.snapshot.contextGraphStorage === snapshot.contextGraphStorage &&
            BigInt(fresh.snapshot.blockNumber) >= BigInt(snapshot.blockNumber);
          return {
            mode, transport, bulkChunks,
            sourceCore: initial.sourceCore,
            coverageSourceCore: fresh.sourceCore,
            snapshotDigest: snapshot.snapshotDigest,
            blockNumber: snapshot.blockNumber,
            blockHash: snapshot.blockHash,
            inventoryDigest: snapshot.inventoryDigest,
            assets: uals.length,
            committed: committed.size,
            completeAsOfSnapshot: true,
            current,
            startedAt,
            finishedAt: Date.now(),
            elapsedMs: Date.now() - startedAt,
          };
        },
      });
    } finally {
      lifecycle.release();
      jobs.delete(this);
    }
  }
}
