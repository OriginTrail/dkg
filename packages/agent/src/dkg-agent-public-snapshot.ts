import { PublicSnapshotProofRuntime } from './public-snapshot-proof-runtime.js';
import { DKG_CORE_CHAIN_CACHE } from './core-chain-cache-config.js';
import { registerCoreChainCacheHandlers } from './core-chain-cache-handler.js';
import { coreChainCacheSeeds, connectCoreChainCacheSeed, createCoreChainCacheContentPeers } from './core-chain-cache-peers.js';
import type { PublicSnapshotRecoveryResult } from './public-snapshot-recovery.js';
import { createOperationContext } from "@origintrail-official/dkg-core";
import { recoverPublicSnapshotBulk } from './public-snapshot-bulk.js';
import { recoverPublicSnapshotExact } from './public-snapshot-exact.js';
import { createPublicSnapshotHeldAssetCheck } from './public-snapshot-held-assets.js';
import { admitAuthenticatedContextGraphSubscription } from './context-graph-subscription-admission.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import { PublicSnapshotServingRuntime } from './public-snapshot-serving-runtime.js';
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
import { bindSnapshotSourcePolicy } from './public-snapshot-policy.js';
import { ensurePeerConnected as connectSnapshotPeer } from './p2p/peer-connect.js';
import { selectSnapshotSources } from './public-snapshot-sources.js';
export type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
export class PublicSnapshotMethods extends DKGAgentBase {
  getPublicSnapshotSourcePolicies(this: DKGAgent): readonly string[] {
    return [...(this.chain.chainId === 'base:8453' ? ['base-mainnet-registered-cores'] : []), ...(this.config.DKG_Core_chain_cache && this.config.coreChainCacheNetworks?.length ? [DKG_CORE_CHAIN_CACHE] : [])];
  }
  startPublicGraphSnapshots(this: DKGAgent): void {
    const proofRuntime = new PublicSnapshotProofRuntime(this.chain, this.workLifetime);
    const cache = this.config.DKG_Core_chain_cache ? registerCoreChainCacheHandlers({
      nodeRole: this.config.nodeRole ?? "edge", chain: this.chain, peerId: this.peerId, router: this.router,
      proofRuntime, workLifetime: this.workLifetime, networks: this.config.coreChainCacheNetworks ?? [],
    }) : undefined;
    if (this.config.nodeRole !== "core" || !this.chain.readPublicGraphSnapshot)
      return;
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
    const runtime = cache?.runtime ?? new PublicSnapshotServingRuntime(
      ({ contextGraphId, onChainId }, signal) => this.chain.readPublicGraphSnapshot!(contextGraphId, onChainId, { signal }),
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
    const chainCache = normalized.sourcePolicy === DKG_CORE_CHAIN_CACHE;
    const networks = chainCache ? this.config.coreChainCacheNetworks ?? [] : [];
    if (chainCache && (!this.config.DKG_Core_chain_cache || !networks.some(n =>
      n.registry.chainId === this.chain.chainId && n.registry.deploymentId === this.chain.deploymentId)))
      throw new Error('DKG_Core_chain_cache is unavailable for this deployment');
    const seeds = coreChainCacheSeeds(networks);
    const dataSeeds = coreChainCacheSeeds(networks.filter(n => n.registry.deploymentId === this.chain.deploymentId));
    let dataCandidates: string[] = [...dataSeeds.keys()];
    const rpcScope = new RpcUsageScope();
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
      return await rpcScope.run(() => runGraphScopedPhysicalOperation({
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
          const policy = bindSnapshotSourcePolicy({ sourcePolicy: normalized.sourcePolicy, chain: this.chain,
            selfPeerId: this.peerId, networks, send: this.router.send.bind(this.router), scope: { contextGraphId, onChainId } });
          const peers = normalized.sourcePolicy ? await selectSnapshotSources({
            ...policy, selfPeerId: this.peerId,
            candidates: async signal => {
              const connected = this.node.libp2p.getConnections().map(c => c.remotePeer.toString());
              const hints = await this.discovery.findSnapshotCorePeerIds(signal).catch(error => {
                signal.throwIfAborted();
                if (!connected.length && !seeds.size) throw error;
                return [];
              });
              dataCandidates.push(...connected, ...hints);
              return [...connected, ...hints, ...seeds.keys()];
            },
            connect: async (peer, signal) => {
              if (!chainCache) return this.ensurePeerConnected(peer, { signal });
              if (seeds.has(peer)) await connectCoreChainCacheSeed(this.node.libp2p, seeds.get(peer)!, signal);
              else await connectSnapshotPeer(this.peerResolver, peer, { signal });
              if (!await this.networkAdmissionCoordinator.ensureCacheAdmitted(peer, createOperationContext('connect'), { signal }))
                throw new Error('Peer is not admitted for chain-cache authentication');
            },
          }, signal) : Object.freeze([...normalized.trustedCorePeerIds]);
          assertCurrent();
          const expected = {
            chainId: this.chain.chainId,
            deploymentId: this.chain.deploymentId!,
            contextGraphId,
            onChainId,
          };
          const read = createPublicSnapshotReader({ mode, chain:this.chain, request: policy.request,
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
          // Cache suppliers can be foreign-network peers. Content remains on the data network
          // and is verified against the authenticated inventory before it is committed.
          const contentPool = chainCache
            ? createCoreChainCacheContentPeers({ candidates: dataCandidates, self: this.peerId,
              connect: (peer, requestSignal) => dataSeeds.get(peer)
                ? connectCoreChainCacheSeed(this.node.libp2p, dataSeeds.get(peer)!, requestSignal)
                : this.ensurePeerConnected(peer, { signal: requestSignal }),
              admit: (peer, requestSignal) => this.networkAdmissionCoordinator.ensureAdmitted(peer, createOperationContext('sync'), { signal: requestSignal }),
            }, signal)
            : undefined;
          if (uals.length && !contentPool && !peers.length) throw new Error('No data-network peers available for snapshot content');
          const peerBatches = contentPool?.batches ?? (async function* () { yield peers; });
          const recovery = { contextGraphId, peerBatches, uals, evidence, signal, assertCurrent };
          let recovered: PublicSnapshotRecoveryResult;
          if (transport === 'bulk') {
            const { verification, reconcile } = DKGAgentBase.createDurableRecoveryCapabilities(this);
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
          } else recovered = await recoverPublicSnapshotExact(DKGAgentBase.createDurableRecoveryCapabilities(this), {
            ...recovery, deadline: startedAt + 3_600_000,
            canAdmit: () => this.vmRecoverySyncAdmissionAvailable(contextGraphId),
            holds: createPublicSnapshotHeldAssetCheck(this.store, evidence),
          });
          const { committed, bulkChunks, alreadyPresent } = recovered;

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
            ...(normalized.sourcePolicy ? { sourcePolicy: normalized.sourcePolicy, selectedCorePeerIds: peers } : {}),
            ...(chainCache ? { contentPeerIds: [...(contentPool?.selected ?? peers)], chainCacheRpcUsage: networks.map(n => ({
              chainId: n.registry.chainId, methods: n.registry.rpcUsage(rpcScope),
            })) } : {}),
            sourceCore: initial.sourceCore,
            coverageSourceCore: fresh.sourceCore,
            snapshotDigest: snapshot.snapshotDigest,
            blockNumber: snapshot.blockNumber,
            blockHash: snapshot.blockHash,
            inventoryDigest: snapshot.inventoryDigest,
            assets: uals.length,
            committed: committed.size,
            ...(alreadyPresent === undefined ? {} : { alreadyPresent }),
            completeAsOfSnapshot: true,
            current,
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
