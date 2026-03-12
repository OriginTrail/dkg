import type { TripleStore, Quad } from '@dkg/storage';
import { GraphManager } from '@dkg/storage';
import type { EventBus } from '@dkg/core';
import type { ChainAdapter, KAUpdateVerification } from '@dkg/chain';
import { Logger, createOperationContext, DKGEvent } from '@dkg/core';
import { decodeKAUpdateRequest } from '@dkg/core';
import { parseSimpleNQuads } from './publish-handler.js';
import { autoPartition } from './auto-partition.js';
import { computeTripleHash, computeFlatKCRoot } from './merkle.js';
import { toHex } from './metadata.js';

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
   * Track the highest applied (blockNumber, txIndex) per (paranetId:batchId).
   * Uses canonical chain ordering: accepts if (blockNumber, txIndex) is strictly
   * higher than the last applied update, ensuring deterministic state across nodes.
   */
  private readonly appliedUpdates = new Map<string, AppliedUpdate>();

  /**
   * Batch-to-paranet binding from trusted sources (local publish, metadata store).
   * Shared with the publisher so bindings established at publish time are immediately
   * available, preventing first-message-wins attacks from gossip.
   */
  private readonly knownBatchParanets: Map<string, string>;

  constructor(
    store: TripleStore,
    chain: ChainAdapter,
    eventBus: EventBus,
    options?: { knownBatchParanets?: Map<string, string> },
  ) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.chain = chain;
    this.eventBus = eventBus;
    this.knownBatchParanets = options?.knownBatchParanets ?? new Map();
  }

  async handle(data: Uint8Array, fromPeerId: string): Promise<void> {
    let ctx = createOperationContext('ka-update');
    try {
      const request = decodeKAUpdateRequest(data);
      if (request.operationId) {
        ctx = createOperationContext('ka-update', request.operationId);
      }
      const {
        paranetId,
        batchId,
        nquads,
        manifest,
        publisherAddress,
        txHash,
      } = request;

      this.log.info(
        ctx,
        `KA update from ${fromPeerId} for paranet ${paranetId} batchId=${batchId} tx=${txHash}`,
      );

      // Paranet binding: check trusted sources first (local publish, store metadata).
      const batchKey = String(batchId);
      let knownParanet = this.knownBatchParanets.get(batchKey);

      if (!knownParanet) {
        knownParanet = await this.lookupBatchParanet(BigInt(batchId));
        if (knownParanet) this.knownBatchParanets.set(batchKey, knownParanet);
      }

      if (knownParanet && knownParanet !== paranetId) {
        this.log.warn(ctx, `KA update rejected: batchId=${batchId} is bound to paranet "${knownParanet}", not "${paranetId}"`);
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
        const orderKey = `${paranetId}:${batchId}`;
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

      // Merkle root integrity: recompute from the received payload (flat mode)
      await this.graphManager.ensureParanet(paranetId);
      const dataGraph = this.graphManager.dataGraphUri(paranetId);
      const nquadsStr = new TextDecoder().decode(nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      const computedRoot = computeFlatKCRoot(quads, []);

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

      // Record applied update for ordering + paranet binding
      if (verifiedBlockNumber !== undefined) {
        const orderKey = `${paranetId}:${batchId}`;
        this.appliedUpdates.set(orderKey, {
          blockNumber: verifiedBlockNumber,
          txIndex: verifiedTxIndex ?? 0,
        });
      }
      // Binding was already established from a trusted source (local publish or metadata lookup).
      // Do NOT set from gossip — that would allow first-message-wins paranet spoofing.

      await this.updateMetaMerkleRoot(paranetId, BigInt(batchId), computedRoot);

      this.log.info(ctx, `Applied KA update: ${authenticatedQuads.length} triples for batchId=${batchId}`);

      this.eventBus.emit(DKGEvent.KA_UPDATED, {
        paranetId,
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
   * Look up the paranet a batch was originally published on by querying local
   * KC metadata. Returns undefined if the batch is unknown to this node.
   */
  private async lookupBatchParanet(batchId: bigint): Promise<string | undefined> {
    const DKG = 'http://dkg.io/ontology/';
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    const result = await this.store.query(
      `SELECT ?g WHERE {
        GRAPH ?g { ?ka <${DKG}batchId> "${batchId}"^^<${XSD}integer> }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    const graphUri = result.bindings[0]['g'];
    if (!graphUri) return undefined;
    const metaSuffix = '/_meta';
    if (graphUri.endsWith(metaSuffix)) {
      const base = graphUri.slice(0, -metaSuffix.length);
      const prefix = 'did:dkg:paranet:';
      if (base.startsWith(prefix)) return base.slice(prefix.length);
    }
    return undefined;
  }

  private async updateMetaMerkleRoot(paranetId: string, batchId: bigint, newMerkleRoot: Uint8Array): Promise<void> {
    const DKG = 'http://dkg.io/ontology/';
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    const metaGraph = this.graphManager.metaGraphUri(paranetId);
    const result = await this.store.query(
      `SELECT ?ual WHERE { GRAPH <${metaGraph}> { ?ual <${DKG}batchId> "${batchId}"^^<${XSD}integer> } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return;
    const ual = result.bindings[0]['ual'];
    if (!ual) return;

    await this.store.deleteByPattern({ graph: metaGraph, subject: ual, predicate: `${DKG}merkleRoot` });
    await this.store.insert([{
      subject: ual,
      predicate: `${DKG}merkleRoot`,
      object: `"${toHex(newMerkleRoot)}"`,
      graph: metaGraph,
    }]);
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
