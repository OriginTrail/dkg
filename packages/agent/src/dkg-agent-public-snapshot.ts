// SPDX-License-Identifier: Apache-2.0
import {
  decodePublicGraphSnapshot,
  PublicGraphSnapshotCache,
  PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES,
  type PublicGraphSnapshot,
} from "@origintrail-official/dkg-chain";
import { validateContextGraphId } from "@origintrail-official/dkg-core";
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
    const cache = new PublicGraphSnapshotCache((id, onChainId, signal) =>
      this.chain.readPublicGraphSnapshot!(id, onChainId, { signal }),
    );
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
              "contextGraphId,minObservedAt,onChainId,version" ||
            request.version !== 1 ||
            !Number.isSafeInteger(request.minObservedAt) ||
            request.minObservedAt < 0 ||
            request.minObservedAt > Date.now() ||
            typeof request.contextGraphId !== "string" ||
            !validateContextGraphId(request.contextGraphId).valid ||
            typeof request.onChainId !== "string" ||
            !/^[1-9][0-9]{0,77}$/.test(request.onChainId) ||
            !this.subscribedContextGraphs.has(request.contextGraphId)
          )
            throw new Error("Unavailable");
          const snapshot = await cache.get(
            request.contextGraphId,
            request.onChainId,
            request.minObservedAt,
          );
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
    jobs.add(this);
    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(3_600_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let active = true;
    const expected = {
      chainId: this.chain.chainId,
      deploymentId: this.chain.deploymentId!,
      contextGraphId,
      onChainId,
    };
    let sourceCore: string | null = null;
    const read = async (minObservedAt = 0): Promise<PublicGraphSnapshot> => {
      signal.throwIfAborted();
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
                minObservedAt,
              }),
            ),
            {
              timeoutMs: 115_000,
              signal,
              maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES,
            },
          );
          const snapshot = decodePublicGraphSnapshot(bytes, expected);
          if (snapshot.observedAt < minObservedAt)
            throw new Error(
              "Core snapshot predates the requested coverage check",
            );
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
      const initialSourceCore = sourceCore;
      const evidence = new PublicSnapshotEvidence(
        snapshot,
        mode,
        sourceCore,
        () => active && !signal.aborted,
      );
      if (mode === "core-cache")
        await markCoreTrustedGraph(this.store, contextGraphId);
      // A validated public snapshot admits this job without scheduling the
      // daemon's separate legacy subscribe/catch-up pipeline.
      if (!this.subscribedContextGraphs.get(contextGraphId)?.subscribed) {
        this.subscribeToContextGraph(contextGraphId, {
          onChainId,
          syncMode: "on-demand",
          trackSyncScope: false,
          deferSharedMemoryGossipSubscribe: true,
        });
      }
      const uals = snapshot.assets.map((a) => {
        const id = BigInt(a.id),
          address = `0x${(id >> 96n).toString(16).padStart(40, "0")}`;
        return `did:dkg:${snapshot.chainId}/${address}/${id & (2n ** 96n - 1n)}`;
      });
      const committed = new Set<string>();
      for (let offset = 0; offset < uals.length; offset += 10) {
        signal.throwIfAborted();
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
              exactRecoveryTransportMode: "stream-required",
              publicSnapshotEvidence: evidence,
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
        if (remaining.length)
          throw new Error(
            `Snapshot recovery incomplete: ${committed.size}/${uals.length} committed`,
          );
      }
      // A new inventory/root comparison is required before claiming current coverage.
      const fresh = await read(Date.now());
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
    }
  }
}
