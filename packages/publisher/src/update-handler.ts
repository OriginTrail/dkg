import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { EventBus } from '@origintrail-official/dkg-core';
import type { ChainAdapter, KAUpdateVerification } from '@origintrail-official/dkg-chain';
import { Logger, createOperationContext, DKGEvent, sparqlInt, contextGraphMetaUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { decodeKAUpdateRequest } from '@origintrail-official/dkg-core';
import { parseSimpleNQuads } from './publish-handler.js';
import { skolemizeByEntity } from './auto-partition.js';
import { computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot } from './merkle.js';
import {
  promoteUpdatedKaToPerCgId,
  resolveUalByBatchId,
  restateLabelGraphForUpdate,
  type MaterializedVersion,
} from './metadata.js';

/**
 * Resolve a context-graph label/name to its on-chain id. Injected by the agent
 * (`DKGAgent#getContextGraphOnChainId`) so the gossip receiver can promote an
 * applied update into the per-cgId partition the RS prover reads (GH #842).
 */
export type ResolveOnChainCgId = (cgName: string) => Promise<string | null>;

const SKOLEM_INFIX = '/.well-known/genid/';
const EXPECTED_MERKLE_ROOT_LEN = 32;

interface AppliedUpdate {
  blockNumber: number;
  txIndex: number;
}

/**
 * Handles incoming KA update gossip messages.
 * Verifies the on-chain transaction and merkle root integrity,
 * then replaces local triples so the receiving node's data graph
 * stays in sync with the publisher's update.
 */
export class UpdateHandler {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  private readonly chain: ChainAdapter;
  private readonly eventBus: EventBus;
  private readonly log = new Logger('UpdateHandler');

  /**
   * Track the highest applied (blockNumber, txIndex) per (contextGraphId:batchId).
   * Uses canonical chain ordering: accepts if (blockNumber, txIndex) is strictly
   * higher than the last applied update, ensuring deterministic state across nodes.
   */
  private readonly appliedUpdates = new Map<string, AppliedUpdate>();

  /**
   * Batch-to-context-graph binding from trusted sources (local publish, metadata store).
   * Shared with the publisher so bindings established at publish time are immediately
   * available, preventing first-message-wins attacks from gossip.
   */
  private readonly knownBatchContextGraphs: Map<string, string>;

  /**
   * Resolve a CG name to its on-chain id for GH #842 per-cgId promotion.
   * Optional: when absent, applied updates are not promoted (RS stays
   * `kc-not-synced` for them, exactly as before this fix).
   */
  private readonly resolveOnChainCgId?: ResolveOnChainCgId;

  constructor(
    store: TripleStore,
    chain: ChainAdapter,
    eventBus: EventBus,
    options?: {
      knownBatchContextGraphs?: Map<string, string>;
      resolveOnChainCgId?: ResolveOnChainCgId;
    },
  ) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.chain = chain;
    this.eventBus = eventBus;
    this.knownBatchContextGraphs = options?.knownBatchContextGraphs ?? new Map();
    this.resolveOnChainCgId = options?.resolveOnChainCgId;
  }

  async handle(data: Uint8Array, fromPeerId: string): Promise<void> {
    let ctx = createOperationContext('ka-update');
    try {
      const request = decodeKAUpdateRequest(data);
      if (request.operationId) {
        ctx = createOperationContext('ka-update', request.operationId);
      }
      const {
        contextGraphId: contextGraphId,
        batchId,
        nquads,
        manifest,
        publisherAddress,
        txHash,
      } = request;

      this.log.info(
        ctx,
        `KA update from ${fromPeerId} for context graph ${contextGraphId} batchId=${batchId} tx=${txHash}`,
      );

      // Context graph binding: check trusted sources first (local publish, store metadata).
      const batchKey = String(batchId);
      let knownContextGraph = this.knownBatchContextGraphs.get(batchKey);

      if (!knownContextGraph) {
        knownContextGraph = await this.lookupBatchContextGraph(BigInt(batchId));
        if (knownContextGraph) this.knownBatchContextGraphs.set(batchKey, knownContextGraph);
      }

      if (knownContextGraph && knownContextGraph !== contextGraphId) {
        this.log.warn(ctx, `KA update rejected: batchId=${batchId} is bound to context graph "${knownContextGraph}", not "${contextGraphId}"`);
        return;
      }

      // --- Chain verification (returns chain-sourced merkle root + block number + txIndex) ---
      let verifiedMerkleRoot: Uint8Array | undefined;
      let verifiedBlockNumber: number | undefined;
      let verifiedTxIndex: number | undefined;

      if (!this.chain.verifyKAUpdate) {
        if (this.chain.chainId !== 'none') {
          this.log.warn(ctx, `KA update rejected: chain adapter does not implement verifyKAUpdate (chainId=${this.chain.chainId})`);
          return;
        }
      } else {
        const verification: KAUpdateVerification = await this.chain.verifyKAUpdate(txHash, BigInt(batchId), publisherAddress);
        if (!verification.verified) {
          this.log.warn(ctx, `KA update rejected: tx ${txHash} not verified for batchId=${batchId} publisher=${publisherAddress}`);
          return;
        }
        verifiedMerkleRoot = verification.onChainMerkleRoot;
        verifiedBlockNumber = verification.blockNumber;
        verifiedTxIndex = verification.txIndex ?? 0;
      }

      // Ordering: use canonical (blockNumber, txIndex) for deterministic state across nodes.
      if (verifiedBlockNumber !== undefined) {
        const txIdx = verifiedTxIndex ?? 0;
        const orderKey = `${contextGraphId}:${batchId}`;
        const last = this.appliedUpdates.get(orderKey);
        if (last) {
          if (verifiedBlockNumber < last.blockNumber) {
            this.log.info(ctx, `KA update skipped: chain block ${verifiedBlockNumber} < last applied ${last.blockNumber} for batchId=${batchId}`);
            return;
          }
          if (verifiedBlockNumber === last.blockNumber && txIdx <= last.txIndex) {
            this.log.info(ctx, `KA update skipped: (block=${verifiedBlockNumber}, txIndex=${txIdx}) <= last applied (block=${last.blockNumber}, txIndex=${last.txIndex}) for batchId=${batchId}`);
            return;
          }
        }
      }

      // Merkle root integrity: recompute from the received payload (flat mode).
      //
      // Issue #31: the KC root on-chain is computed over public triple hashes
      // *plus* each KA's privateMerkleRoot as a synthetic leaf (matches
      // publisher/dkg-publisher.ts#computeUpdateAndPublish and publish-handler
      // on ingest). Passing `[]` here would only match updates that carry zero
      // private quads — any legitimate update with private commitments would be
      // silently rejected for "merkle root mismatch". The manifest carries each
      // root's privateMerkleRoot in the same order the publisher used to build
      // the KC root, so we just forward them.
      await this.graphManager.ensureContextGraph(contextGraphId);
      // Uniform layout: a KA update replaces the published data in the SAME per-KA
      // verifiable-memory graph the original publish wrote (…/_verifiable_memory/{author}/{number}),
      // keyed by the on-chain batchId (= the packed kaId). restate/delete/write all target it.
      const vmBatch = BigInt(batchId);
      const dataGraph = contextGraphLayerUri(
        contextGraphId,
        MemoryLayer.VerifiableMemory,
        '0x' + (vmBatch >> 96n).toString(16).padStart(40, '0'),
        vmBatch & ((1n << 96n) - 1n),
      );
      const nquadsStr = new TextDecoder().decode(nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      const privateRoots = manifest
        .map((m) => m.privateMerkleRoot)
        .filter((r): r is Uint8Array => r != null && r.length > 0)
        .map((r) => new Uint8Array(r));
      const computedRoot = computeFlatKCRoot(quads, privateRoots);

      const partitioned = skolemizeByEntity(quads);
      const manifestRoots = new Set(manifest.map((m) => m.rootEntity));
      for (const payloadRoot of partitioned.keys()) {
        if (!manifestRoots.has(payloadRoot)) {
          this.log.warn(ctx, `KA update rejected: payload contains unauthenticated root "${payloadRoot}" not in manifest`);
          return;
        }
      }

      const referenceRoot = verifiedMerkleRoot ?? request.newMerkleRoot;
      if (!referenceRoot || referenceRoot.length !== EXPECTED_MERKLE_ROOT_LEN) {
        this.log.warn(ctx, `KA update rejected: merkle root missing or wrong length (got ${referenceRoot?.length ?? 0}, expected ${EXPECTED_MERKLE_ROOT_LEN})`);
        return;
      }

      if (!buffersEqual(computedRoot, new Uint8Array(referenceRoot))) {
        this.log.warn(ctx, `KA update rejected: merkle root mismatch for batchId=${batchId} (tampered payload)`);
        return;
      }

      // Resolve the KA's UAL once — used for BOTH the label restatement and the
      // per-cgId promotion. Prefer the meta-recorded UAL; fall back to the
      // deterministic canonical UAL (`did:dkg:<chainId>/<kasAddress>/<batchId>`)
      // so a receiver that hasn't yet materialised the `dkg:batchId` edge still
      // restates/promotes instead of silently skipping (GH#842 §7.3 — the
      // "skipped per-cgId promotion (UAL unresolved)" failure mode).
      const labelMeta = this.graphManager.metaGraphUri(contextGraphId);
      // Best-effort: the per-cgId promotion is RS-only sugar. A transient
      // ontology/store error in the resolver must NOT abort the verified
      // label-graph restatement — that's the same failure mode the agent-
      // side `update()` already guards. We fall back to `null` (skip
      // per-cgId promotion) and continue applying the update.
      let cgId: string | null = null;
      if (this.resolveOnChainCgId) {
        try {
          cgId = await this.resolveOnChainCgId(contextGraphId);
        } catch (err) {
          this.log.warn(
            ctx,
            `Per-cgId resolver threw for cg=${contextGraphId} — skipping per-cgId promotion: ${err instanceof Error ? err.message : String(err)}`,
          );
          cgId = null;
        }
      }
      let ual = await resolveUalByBatchId(this.store, labelMeta, BigInt(batchId));
      if (!ual && cgId) {
        ual = await resolveUalByBatchId(this.store, contextGraphMetaUri(contextGraphId, cgId), BigInt(batchId));
      }
      if (!ual) {
        ual = await this.deterministicUal(BigInt(batchId));
      }

      const updateVersion: MaterializedVersion = {
        blockNumber: verifiedBlockNumber ?? 0,
        txIndex: verifiedTxIndex ?? 0,
      };

      const payloadByRoot = new Map<string, Quad[]>();
      for (const root of manifestRoots) {
        payloadByRoot.set(root, partitioned.get(root) ?? []);
      }
      const privateRootByRoot = new Map<string, Uint8Array>();
      for (const m of manifest) {
        if (m.privateMerkleRoot && m.privateMerkleRoot.length > 0) {
          privateRootByRoot.set(m.rootEntity, new Uint8Array(m.privateMerkleRoot));
        }
      }
      const authenticatedCount = [...payloadByRoot.values()].reduce((n, qs) => n + qs.length, 0);

      // Apply to the label graph with FULL restatement (GH#842 §7.1): purge the
      // prior root entities' data (the old delete touched only the new manifest
      // roots, leaving stale pre-update triples behind), repoint `rootEntity`,
      // and refresh `merkleRoot`. The version guard makes a late stale
      // re-materialisation a no-op.
      if (ual) {
        await restateLabelGraphForUpdate({
          store: this.store,
          dataGraph,
          metaGraph: labelMeta,
          ual,
          merkleRoot: computedRoot,
          payloadByRoot,
          privateRootByRoot,
          version: updateVersion,
        });
      } else {
        // No chain address to mint a UAL: fall back to legacy apply (no
        // prior-root purge). Should not happen on a configured chain.
        for (const m of manifest) await this.deleteEntityTriples(dataGraph, m.rootEntity);
        const flat: Quad[] = [];
        for (const qs of payloadByRoot.values()) for (const q of qs) flat.push({ ...q, graph: dataGraph });
        await this.store.insert(flat);
      }

      // #1099: drain this replica's SWM copy of the updated roots — same
      // contract as the finalization path. The publisher cleans its own SWM
      // after a confirmed update, but replicas that mirrored the edit-loop
      // share kept the stale copy forever and re-served it to late
      // subscribers via the PROTOCOL_SYNC SWM responder.
      try {
        const swmBucket = this.graphManager.sharedMemoryUri(contextGraphId);
        const swmMeta = this.graphManager.sharedMemoryMetaUri(contextGraphId);
        const allGraphs = await this.store.listGraphs();
        const swmGraphs = allGraphs.filter((g) => g === swmBucket || g.startsWith(`${swmBucket}/`));
        for (const m of manifest) {
          for (const g of swmGraphs) {
            await this.deleteEntityTriples(g, m.rootEntity);
          }
          await this.store.deleteByPattern({ graph: swmMeta, subject: m.rootEntity });
          // Detach the root from its WorkspaceOperation rows (and drop ops
          // that reference nothing else) so the PROTOCOL_SYNC TTL branch
          // stops serving the drained content to late subscribers.
          const ops = await this.store.query(
            `SELECT DISTINCT ?op WHERE { GRAPH <${swmMeta}> { ?op (<http://dkg.io/ontology/rootEntity>|<http://dkg.io/ontology/entity>) <${m.rootEntity}> } }`,
          );
          if (ops.type === 'bindings') {
            for (const row of ops.bindings) {
              const op = row['op'];
              if (!op) continue;
              await this.store.delete([
                { subject: op, predicate: 'http://dkg.io/ontology/rootEntity', object: m.rootEntity, graph: swmMeta },
                { subject: op, predicate: 'http://dkg.io/ontology/entity', object: m.rootEntity, graph: swmMeta },
              ]);
              const remaining = await this.store.query(
                `ASK { GRAPH <${swmMeta}> { <${op}> (<http://dkg.io/ontology/rootEntity>|<http://dkg.io/ontology/entity>) ?r } }`,
              );
              if (remaining.type === 'boolean' && remaining.value === false) {
                await this.store.deleteByPattern({ graph: swmMeta, subject: op });
              }
            }
          }
        }
      } catch (err) {
        this.log.warn(
          ctx,
          `SWM drain after applied update failed for batchId=${batchId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Record applied update for ordering + context graph binding
      if (verifiedBlockNumber !== undefined) {
        const orderKey = `${contextGraphId}:${batchId}`;
        this.appliedUpdates.set(orderKey, {
          blockNumber: verifiedBlockNumber,
          txIndex: verifiedTxIndex ?? 0,
        });
      }
      // Binding was already established from a trusted source (local publish or metadata lookup).
      // Do NOT set from gossip — that would allow first-message-wins context graph spoofing.

      // GH #842: promote the applied payload into the per-cgId partition the RS
      // prover reads, mirroring the publisher side, so receivers can also prove
      // updated KAs. Best-effort — skip if the on-chain cgId can't be resolved
      // (RS then stays `kc-not-synced` for this KA, no regression).
      if (cgId && ual) {
        try {
          await promoteUpdatedKaToPerCgId({
            store: this.store,
            contextGraphId,
            cgId,
            ual,
            kaId: BigInt(batchId),
            merkleRoot: computedRoot,
            payloadByRoot,
            privateRootByRoot,
            version: updateVersion,
          });
        } catch (err) {
          this.log.warn(
            ctx,
            `GH#842 per-cgId update promotion failed for batchId=${batchId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (!cgId) {
        this.log.info(ctx, `GH#842: per-cgId promotion skipped (cgId unresolved) for batchId=${batchId}`);
      }

      this.log.info(ctx, `Applied KA update: ${authenticatedCount} triples for batchId=${batchId}`);

      this.eventBus.emit(DKGEvent.KA_UPDATED, {
        contextGraphId,
        batchId: BigInt(batchId),
        rootEntities: manifest.map((m) => m.rootEntity),
        txHash,
        fromPeerId,
      });
    } catch (err) {
      this.log.error(
        ctx,
        `KA update handle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Look up the context graph a batch was originally published on by querying local
   * KC metadata. Returns undefined if the batch is unknown to this node.
   */
  private async lookupBatchContextGraph(batchId: bigint): Promise<string | undefined> {
    const DKG = 'http://dkg.io/ontology/';
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    const result = await this.store.query(
      `SELECT ?g WHERE {
        GRAPH ?g { ?ka <${DKG}batchId> "${sparqlInt(batchId)}"^^<${XSD}integer> }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    const graphUri = result.bindings[0]['g'];
    if (!graphUri) return undefined;
    const metaSuffix = '/_meta';
    if (graphUri.endsWith(metaSuffix)) {
      const base = graphUri.slice(0, -metaSuffix.length);
      const prefix = 'did:dkg:context-graph:';
      if (base.startsWith(prefix)) return base.slice(prefix.length);
    }
    return undefined;
  }

  /**
   * Deterministic canonical UAL for a batch, matching the publisher's scheme
   * (`did:dkg:<chainId>/<kasAddress>/<batchId>`). Used as a last-resort UAL when
   * the `dkg:batchId` resolution edge isn't materialised yet on a receiver, so
   * the GH#842 promotion never silently skips. Returns undefined when no chain
   * KnowledgeAssets address is available.
   */
  private async deterministicUal(batchId: bigint): Promise<string | undefined> {
    try {
      const addr = this.chain.getDKGKnowledgeAssetsAddress
        ? await this.chain.getDKGKnowledgeAssetsAddress()
        : undefined;
      if (!addr) return undefined;
      return `did:dkg:${this.chain.chainId}/${addr.toLowerCase()}/${batchId.toString()}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Delete exact root entity triples + its skolemized descendants only.
   * Avoids prefix collision (e.g. "urn:x:foo" must not delete "urn:x:foobar").
   */
  private async deleteEntityTriples(graph: string, rootEntity: string): Promise<void> {
    await this.store.deleteByPattern({ graph, subject: rootEntity });
    const skolemPrefix = rootEntity + SKOLEM_INFIX;
    await this.store.deleteBySubjectPrefix(graph, skolemPrefix);
  }
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
