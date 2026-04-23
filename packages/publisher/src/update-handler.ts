import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { EventBus } from '@origintrail-official/dkg-core';
import type { ChainAdapter, KAUpdateVerification } from '@origintrail-official/dkg-chain';
import { Logger, createOperationContext, DKGEvent, sparqlInt } from '@origintrail-official/dkg-core';
import { decodeKAUpdateRequest } from '@origintrail-official/dkg-core';
import { parseSimpleNQuads } from './publish-handler.js';
import { autoPartition } from './auto-partition.js';
import { computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot } from './merkle.js';
import { updateMetaMerkleRoot } from './metadata.js';

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

  constructor(
    store: TripleStore,
    chain: ChainAdapter,
    eventBus: EventBus,
    options?: { knownBatchContextGraphs?: Map<string, string> },
  ) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.chain = chain;
    this.eventBus = eventBus;
    this.knownBatchContextGraphs = options?.knownBatchContextGraphs ?? new Map();
  }

  async handle(
    data: Uint8Array,
    fromPeerId: string,
    /**
     * r23-4 (PR #229 bot review round 23): EVM address recovered from
     * the outer GossipEnvelope signature, if ingress came via a signed
     * envelope. Must equal the inner `publisherAddress`; otherwise a
     * peer with a legitimate wallet could wrap a forged KA update
     * claiming another operator's publisher address. The chain-layer
     * `verifyKAUpdate` ultimately catches forged tx attribution, but
     * cross-checking here rejects earlier (before RPC round-trips)
     * and closes the hole when chainId='none'. Undefined means no
     * envelope was present (rolling-upgrade path) and the check is
     * skipped — the envelope-layer warning already covers that risk.
     */
    envelopeSigner?: string,
  ): Promise<void> {
    let ctx = createOperationContext('ka-update');
    try {
      const request = decodeKAUpdateRequest(data);
      if (request.operationId) {
        ctx = createOperationContext('ka-update', request.operationId);
      }
      const {
        paranetId: contextGraphId,
        batchId,
        nquads,
        manifest,
        publisherAddress,
        txHash,
      } = request;

      // r23-4: reject forged-attribution updates before chain RPC.
      if (envelopeSigner && publisherAddress) {
        const claimed = publisherAddress.toLowerCase();
        const recovered = envelopeSigner.toLowerCase();
        if (claimed !== recovered) {
          this.log.warn(
            ctx,
            `KA update rejected: envelope signer ${envelopeSigner} ` +
              `does not match claimed publisherAddress ${publisherAddress} ` +
              `(forged-attribution defence, r23-4)`,
          );
          return;
        }
      } else if (envelopeSigner && !publisherAddress) {
        this.log.warn(
          ctx,
          `KA update rejected: envelope is signed by ${envelopeSigner} ` +
            `but KAUpdateRequest.publisherAddress is empty (r23-4)`,
        );
        return;
      }

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
      const dataGraph = this.graphManager.dataGraphUri(contextGraphId);
      const nquadsStr = new TextDecoder().decode(nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      const privateRoots = manifest
        .map((m) => m.privateMerkleRoot)
        .filter((r): r is Uint8Array => r != null && r.length > 0)
        .map((r) => new Uint8Array(r));
      const computedRoot = computeFlatKCRoot(quads, privateRoots);

      const partitioned = autoPartition(quads);
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

      // Apply: delete exact root + skolemized children, then insert only manifest roots' quads
      for (const m of manifest) {
        await this.deleteEntityTriples(dataGraph, m.rootEntity);
      }

      const authenticatedQuads: Quad[] = [];
      for (const root of manifestRoots) {
        for (const q of partitioned.get(root) ?? []) {
          authenticatedQuads.push({ ...q, graph: dataGraph });
        }
      }
      await this.store.insert(authenticatedQuads);

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

      try {
        await updateMetaMerkleRoot(this.store, this.graphManager, contextGraphId, BigInt(batchId), computedRoot);
      } catch (err) {
        this.log.warn(
          ctx,
          `Failed to update _meta merkleRoot for batchId=${batchId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      this.log.info(ctx, `Applied KA update: ${authenticatedQuads.length} triples for batchId=${batchId}`);

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
