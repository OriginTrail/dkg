// SPDX-License-Identifier: Apache-2.0
import {
  decodePublicGraphSnapshot,
  PublicGraphSnapshotCache,
  PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES,
  type PublicGraphSnapshot,
} from "@origintrail-official/dkg-chain";
import { buildKnowledgeAssetUalFromOnChainIdV1, validateContextGraphId } from "@origintrail-official/dkg-core";
import type { DKGAgent } from "./dkg-agent.js";
import {
  PublicSnapshotEvidence,
  markCoreTrustedGraph,
  type PublicSnapshotMode,
} from "./public-snapshot-evidence.js";

export const PUBLIC_GRAPH_SNAPSHOT_PROTOCOL =
  "/dkg/10.0.0/public-graph-snapshot/1";
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
    let subscription = this.subscribedContextGraphs.get(contextGraphId);
    if (subscription && (!subscription.subscribed && !subscription.coreHosted))
      throw new Error("Graph subscription is inactive");
    if (subscription?.onChainId && subscription.onChainId !== onChainId)
      throw new Error("Graph binding differs from requested snapshot");
    let bindingGeneration = this.contextGraphBindingState.capture(contextGraphId);
    const lifetime = this.vmReconcileLifecycleGeneration;
    jobs.add(this);
    let retire!: () => void;
    const physical = new Promise<void>(resolve => { retire = resolve; });
    this.vmReconcilePhysicalRuns.add(physical);
    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(3_600_000);
    const signal = AbortSignal.any([
      this.vmReconcileLifecycleController.signal, timeout,
      ...(options.signal ? [options.signal] : []),
    ]);
    let active = true;
    const isCurrent = () => active && !signal.aborted
      && lifetime === this.vmReconcileLifecycleGeneration
      && subscription === this.subscribedContextGraphs.get(contextGraphId)
      && this.contextGraphBindingState.isGenerationCurrent(contextGraphId, bindingGeneration);
    const assertCurrent = () => {
      if (!isCurrent()) throw new Error("Snapshot job ownership changed");
    };
    const expected = {
      chainId: this.chain.chainId,
      deploymentId: this.chain.deploymentId!,
      contextGraphId,
      onChainId,
    };
    let sourceCore: string | null = null;
    const read = async (refresh = false): Promise<PublicGraphSnapshot> => {
      assertCurrent();
      if (mode === "rpc-only") {
        if (!this.chain.readPublicGraphSnapshot)
          throw new Error(
            "Independent snapshots are unsupported by this chain adapter",
          );
        const raw = await this.chain.readPublicGraphSnapshot(
          contextGraphId,
          onChainId,
          { signal },
        );
        return decodePublicGraphSnapshot(
          encoder.encode(JSON.stringify(raw)),
          expected,
        );
      }
      // Authenticated libp2p channel identity is the signer-equivalent trust boundary.
      let failure: unknown;
      for (const peer of peers) {
        try {
          const bytes = await this.router.send(
            peer,
            PUBLIC_GRAPH_SNAPSHOT_PROTOCOL,
            encoder.encode(
              JSON.stringify({
                version: 1,
                contextGraphId,
                onChainId,
                refresh,
              }),
            ),
            {
              timeoutMs: 115_000,
              signal,
              maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES,
            },
          );
          const snapshot = decodePublicGraphSnapshot(bytes, expected);
          assertCurrent();
          sourceCore = peer;
          return snapshot;
        } catch (error) {
          failure = error;
          signal.throwIfAborted();
        }
      }
      throw new Error("No configured core supplied a valid public snapshot", {
        cause: failure,
      });
    };
    try {
      const snapshot = await read();
      assertCurrent();
      const initialSourceCore = sourceCore;
      const evidence = new PublicSnapshotEvidence(
        snapshot,
        mode,
        sourceCore,
        isCurrent,
      );
      // A validated public snapshot admits this job without scheduling the
      // daemon's separate legacy subscribe/catch-up pipeline.
      if (!subscription?.subscribed || !subscription.onChainId) {
        this.subscribeToContextGraph(contextGraphId, {
          onChainId,
          syncMode: "on-demand",
          trackSyncScope: false,
          deferSharedMemoryGossipSubscribe: true,
        });
      }
      subscription = this.subscribedContextGraphs.get(contextGraphId);
      bindingGeneration = this.contextGraphBindingState.capture(contextGraphId);
      assertCurrent();
      if (mode === "core-cache") await markCoreTrustedGraph(this.store, contextGraphId);
      assertCurrent();
      const uals = snapshot.assets.map((a) => buildKnowledgeAssetUalFromOnChainIdV1(snapshot.chainId, snapshot.assetStorage, BigInt(a.id)));
      const committed = new Set<string>();
      for (let offset = 0; offset < uals.length; offset += 10) {
        assertCurrent();
        const batch = uals.slice(offset, offset + 10);
        let remaining = batch;
        for (const peer of peers) {
          if (!remaining.length) break;
          const result = await this.syncExactKnowledgeAssetsFromPeerDetailed(
            peer,
            contextGraphId,
            remaining,
            {
              signal,
              isCurrent: evidence.isCurrent,
              forceFreshExactSession: true,
              exactRecoveryTransportMode: "stream-preferred",
              authenticateGraphScopedAsset: (asset) => evidence.authenticate(asset),
              totalTimeoutMs: 120_000,
              registeredPublicEvidence: {
                usableFor: (id, s) =>
                  id === contextGraphId && evidence.isCurrent() && !s?.aborted,
                revoke: () => {},
              },
            },
          );
          for (const ual of result.committedExactAssetUals ?? [])
            committed.add(ual);
          remaining = batch.filter((ual) => !committed.has(ual));
        }
        // The stream profile excludes private commitments. Retry only missing
        // assets through the established bounded singleton wire; content and
        // snapshot authentication still feed the same atomic commit boundary.
        for (const ual of remaining) {
          for (const peer of peers) {
            assertCurrent();
            const result = await this.syncExactKnowledgeAssetsFromPeerDetailed(peer, contextGraphId, [ual], {
              signal, isCurrent, forceFreshExactSession: true, exactRecoveryTransportMode: "legacy",
              authenticateGraphScopedAsset: asset => evidence.authenticate(asset), totalTimeoutMs: 120_000,
            });
            for (const applied of result.committedExactAssetUals ?? []) committed.add(applied);
            if (committed.has(ual)) break;
          }
        }
        remaining = batch.filter(ual => !committed.has(ual));
        if (remaining.length)
          throw new Error(
            `Snapshot recovery incomplete: ${committed.size}/${uals.length} committed`,
          );
      }
      // A new inventory/root comparison is required before claiming current coverage.
      const fresh = await read(true);
      assertCurrent();
      const current =
        fresh.inventoryDigest === snapshot.inventoryDigest &&
        fresh.assetStorage === snapshot.assetStorage &&
        fresh.contextGraphStorage === snapshot.contextGraphStorage &&
        BigInt(fresh.blockNumber) >= BigInt(snapshot.blockNumber);
      return {
        mode,
        sourceCore: initialSourceCore,
        coverageSourceCore: sourceCore,
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
    } finally {
      active = false;
      jobs.delete(this);
      retire();
      this.vmReconcilePhysicalRuns.delete(physical);
    }
  }
}
