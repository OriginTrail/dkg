// SPDX-License-Identifier: Apache-2.0
import {
  PublicGraphSnapshotCache,
  PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES,
} from "@origintrail-official/dkg-chain";
import { buildKnowledgeAssetUalFromOnChainIdV1, validateContextGraphId } from "@origintrail-official/dkg-core";
import { runGraphScopedPhysicalOperation } from "./sync/requester/graph-scoped-operation-fence.js";
import type { DKGAgent } from "./dkg-agent.js";
import {
  PublicSnapshotEvidence,
  markCoreTrustedGraph,
  type PublicSnapshotMode,
} from "./public-snapshot-evidence.js";

import { createPublicSnapshotReader, PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from "./public-snapshot-reader.js";
export { PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from "./public-snapshot-reader.js";
const encoder = new TextEncoder();
const jobs = new WeakSet<DKGAgent>();
export interface PublicSnapshotSyncOptions {
  contextGraphId: string;
  onChainId: string;
  /** Operator-configured peer identities, never populated from self-advertised roles. */
  trustedCorePeerIds: readonly string[];
  mode?: PublicSnapshotMode;
  signal?: AbortSignal;
}
export class PublicSnapshotMethods {
  startPublicGraphSnapshots(this: DKGAgent): void {
    if (this.config.nodeRole !== "core" || !this.chain.readPublicGraphSnapshot)
      return;
    const cache = new PublicGraphSnapshotCache((id, onChainId, signal) => {
      const operation = this.chain.readPublicGraphSnapshot!(id, onChainId, {
        signal: AbortSignal.any([signal, this.vmReconcileLifecycleController.signal]),
      });
      this.vmReconcilePhysicalRuns.add(operation);
      void operation.finally(() => this.vmReconcilePhysicalRuns.delete(operation)).catch(() => {});
      return operation;
    });
    this.router.register(
      PUBLIC_GRAPH_SNAPSHOT_PROTOCOL,
      async (data) => {
        try {
          if (data.byteLength > 1024) throw new Error("Request too large");
          const request = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(data),
          );
          if (
            Object.keys(request).sort().join(",") !==
              "contextGraphId,onChainId,refresh,version" ||
            request.version !== 1 ||
            typeof request.refresh !== "boolean" ||
            typeof request.contextGraphId !== "string" ||
            !validateContextGraphId(request.contextGraphId).valid ||
            typeof request.onChainId !== "string" ||
            !/^[1-9][0-9]{0,77}$/.test(request.onChainId) ||
            !(this.subscribedContextGraphs.get(request.contextGraphId)?.subscribed
              || this.subscribedContextGraphs.get(request.contextGraphId)?.coreHosted)
          )
            throw new Error("Unavailable");
          const generation = this.contextGraphBindingState.capture(request.contextGraphId);
          const lifetime = this.vmReconcileLifecycleGeneration;
          const snapshot = await cache.get(
            request.contextGraphId,
            request.onChainId,
            request.refresh,
          );
          if (lifetime !== this.vmReconcileLifecycleGeneration
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
      { maxReadBytes: 1024 },
    );
  }
  /** Explicit foreground job. The existing background reconciler's trust policy is unchanged. */
  async syncPublicGraphSnapshot(
    this: DKGAgent,
    options: PublicSnapshotSyncOptions,
  ) {
    const { contextGraphId, onChainId } = options;
    const mode = options.mode ?? "core-cache";
    if (
      !validateContextGraphId(contextGraphId).valid ||
      !/^[1-9][0-9]{0,77}$/.test(onChainId) ||
      !["core-cache", "rpc-only"].includes(mode)
    )
      throw new Error("Invalid snapshot job");
    const peers = [...new Set(options.trustedCorePeerIds)];
    if (
      !peers.length ||
      peers.length > 4 ||
      peers.some((p) => typeof p !== "string" || p.length > 256 || !p.length)
    )
      throw new Error("Configure one to four trusted core peer identities");
    if (jobs.has(this)) throw new Error("A snapshot job is already running");
    if (!this.started || this.vmReconcileRotationClosed) throw new Error("Node is stopping");
    const subscription = this.subscribedContextGraphs.get(contextGraphId);
    if (subscription && (!subscription.subscribed && !subscription.coreHosted))
      throw new Error("Graph subscription is inactive");
    if (subscription?.onChainId && subscription.onChainId !== onChainId)
      throw new Error("Graph binding differs from requested snapshot");
    const lifetime = this.vmReconcileLifecycleGeneration;
    jobs.add(this);
    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(3_600_000);
    const signal = AbortSignal.any([
      this.vmReconcileLifecycleController.signal, timeout,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      return await runGraphScopedPhysicalOperation({
        contextGraphId, signal,
        isClosed: () => !this.started || this.vmReconcileRotationClosed,
        captureSubscription: () => this.subscribedContextGraphs.get(contextGraphId),
        captureBindingGeneration: () => this.contextGraphBindingState.capture(contextGraphId),
        isBindingGenerationCurrent: generation => this.contextGraphBindingState.isGenerationCurrent(contextGraphId, generation),
        assertLifecycleCurrent: () => { if (lifetime !== this.vmReconcileLifecycleGeneration) throw new Error("Snapshot job ownership changed"); },
        closedError: () => new Error("Node is stopping"),
        bindingChangedError: () => new Error("Snapshot job ownership changed"),
        asAbortError: reason => new Error("Snapshot job ownership changed", { cause: reason }),
        track: run => { this.vmReconcilePhysicalRuns.add(run); },
        untrack: run => { this.vmReconcilePhysicalRuns.delete(run); },
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
          const evidence = new PublicSnapshotEvidence(initial, isCurrent);
          // A validated public snapshot admits this job without scheduling the
          // daemon's separate legacy subscribe/catch-up pipeline.
          if (!subscription?.subscribed || !subscription.onChainId) {
            control.admitSubscription(() => this.subscribeToContextGraph(contextGraphId, {
              onChainId,
              syncMode: "on-demand",
              trackSyncScope: false,
              deferSharedMemoryGossipSubscribe: true,
            }));
          }
          assertCurrent();
          if (mode === "core-cache") await markCoreTrustedGraph(this.store, contextGraphId);
          assertCurrent();
          const uals = snapshot.assets.map((a) => buildKnowledgeAssetUalFromOnChainIdV1(snapshot.chainId, snapshot.assetStorage, BigInt(a.id)));
          const committed = new Set<string>();
          const recover = async (batch: string[], transport: "stream-preferred" | "legacy") => {
            for (const peer of peers) {
              assertCurrent();
              const remaining = batch.filter(ual => !committed.has(ual));
              if (!remaining.length) break;
              const result = await this.syncExactKnowledgeAssetsFromPeerDetailed(peer, contextGraphId, remaining, {
                signal, isCurrent, forceFreshExactSession: true,
                exactRecoveryTransportMode: transport,
                authenticateGraphScopedAsset: asset => evidence.authenticate(asset),
                totalTimeoutMs: 120_000,
                registeredPublicEvidence: {
                  usableFor: (id, s) => id === contextGraphId && isCurrent() && !s?.aborted,
                  revoke: () => {},
                },
              });
              for (const ual of result.committedExactAssetUals ?? []) committed.add(ual);
            }
            return batch.filter(ual => !committed.has(ual));
          };
          for (let offset = 0; offset < uals.length; offset += 10) {
            const batch = uals.slice(offset, offset + 10);
            const remaining = await recover(batch, "stream-preferred");
            // The stream profile excludes private commitments. Only missing assets
            // use the bounded singleton transport, with identical authentication.
            for (const ual of remaining) await recover([ual], "legacy");
            if (batch.some(ual => !committed.has(ual)))
              throw new Error(`Snapshot recovery incomplete: ${committed.size}/${uals.length} committed`);
          }
          // A new inventory/root comparison is required before claiming current coverage.
          const fresh = await read(true);
          assertCurrent();
          const current =
            fresh.snapshot.inventoryDigest === snapshot.inventoryDigest &&
            fresh.snapshot.assetStorage === snapshot.assetStorage &&
            fresh.snapshot.contextGraphStorage === snapshot.contextGraphStorage &&
            BigInt(fresh.snapshot.blockNumber) >= BigInt(snapshot.blockNumber);
          return {
            mode,
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
      jobs.delete(this);
    }
  }
}
