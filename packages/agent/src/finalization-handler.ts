import {
  decodeFinalizationMessage,
  paranetWorkspaceGraphUri, paranetWorkspaceMetaGraphUri,
  contextGraphDataUri, contextGraphMetaUri,
  Logger, createOperationContext,
  type OperationContext,
} from '@dkg/core';
import { GraphManager, type TripleStore, type Quad } from '@dkg/storage';
import { type ChainAdapter, type EventFilter } from '@dkg/chain';
import {
  computeTripleHash, autoPartition,
  generateConfirmedFullMetadata,
  type KCMetadata, type KAMetadata, type OnChainProvenance,
} from '@dkg/publisher';
import { MerkleTree } from '@dkg/core';
import { ethers } from 'ethers';

export class FinalizationHandler {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter | undefined;
  private readonly log = new Logger('FinalizationHandler');

  constructor(store: TripleStore, chain: ChainAdapter | undefined) {
    this.store = store;
    this.chain = chain;
  }

  async handleFinalizationMessage(data: Uint8Array, paranetId: string): Promise<void> {
    let ctx = createOperationContext('gossip');
    try {
      const msg = decodeFinalizationMessage(data);
      if (msg.operationId) {
        ctx = createOperationContext('gossip', msg.operationId);
      }

      if (msg.paranetId && msg.paranetId !== paranetId) {
        this.log.warn(ctx, `Finalization: paranetId "${msg.paranetId}" does not match topic "${paranetId}", ignoring`);
        return;
      }

      if (!msg.ual || !msg.txHash || msg.rootEntities.length === 0) {
        this.log.warn(ctx, `Finalization: incomplete message (ual=${msg.ual}, txHash=${msg.txHash}, roots=${msg.rootEntities.length}), ignoring`);
        return;
      }

      const blockNumber = protoToNumber(msg.blockNumber);
      const startKAId = protoToBigInt(msg.startKAId);
      const endKAId = protoToBigInt(msg.endKAId);

      const ctxGraphId = msg.contextGraphId || undefined;

      // Dedup guard: skip if this batch was already promoted (e.g. by ChainEventPoller)
      const targetMetaGraph = ctxGraphId
        ? contextGraphMetaUri(paranetId, ctxGraphId)
        : `did:dkg:paranet:${paranetId}/_meta`;
      const alreadyPromoted = await this.isAlreadyConfirmed(msg.ual, targetMetaGraph);
      if (alreadyPromoted) {
        this.log.info(ctx, `Finalization: ${msg.ual} already confirmed in ${ctxGraphId ? `context graph ${ctxGraphId}` : 'paranet'}, skipping`);
        return;
      }

      const workspaceQuads = await this.getWorkspaceQuadsForRoots(paranetId, msg.rootEntities);

      if (workspaceQuads.length > 0) {
        const merkleMatch = this.verifyMerkleMatch(workspaceQuads, paranetId, msg.kcMerkleRoot, ctxGraphId);

        if (merkleMatch) {
          const batchId = protoToBigInt(msg.batchId);
          const verified = await this.verifyOnChain(
            msg.txHash, blockNumber, msg.kcMerkleRoot,
            msg.publisherAddress, startKAId, endKAId, ctx, ctxGraphId, batchId,
          );

          if (verified) {
            await this.promoteWorkspaceToCanonical(
              paranetId, workspaceQuads, msg.ual, msg.rootEntities,
              msg.publisherAddress, msg.txHash, blockNumber, startKAId, endKAId,
              protoToBigInt(msg.batchId), ctx, ctxGraphId,
            );
            this.log.info(ctx, `Finalization: promoted workspace snapshot to ${ctxGraphId ? `context graph ${ctxGraphId}` : 'canonical'} for ${msg.ual} (tx=${msg.txHash.slice(0, 10)}…)`);
            return;
          }
          this.log.info(ctx, `Finalization: on-chain verification failed for ${msg.ual}, will retry via ChainEventPoller`);
          return;
        }
        this.log.info(ctx, `Finalization: merkle mismatch for ${msg.ual}, workspace data differs from published`);
      } else {
        this.log.info(ctx, `Finalization: no workspace data for ${msg.ual}, peer missed workspace sharing`);
      }

      // Fallback: no matching workspace data. The data will arrive via
      // the regular publish topic broadcast or ChainEventPoller sync.
      this.log.info(ctx, `Finalization: ${msg.ual} requires full payload sync (no matching workspace snapshot)`);
    } catch (err) {
      this.log.warn(ctx, `Finalization: failed to process message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async isAlreadyConfirmed(ual: string, metaGraph: string): Promise<boolean> {
    try {
      const result = await this.store.query(
        `ASK { GRAPH <${metaGraph}> { <${ual}> <http://dkg.io/ontology/status> "confirmed" } }`,
      );
      return result.type === 'boolean' && result.value === true;
    } catch {
      return false;
    }
  }

  private async getWorkspaceQuadsForRoots(paranetId: string, rootEntities: string[]): Promise<Quad[]> {
    const workspaceGraph = paranetWorkspaceGraphUri(paranetId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return [];

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
      GRAPH <${workspaceGraph}> {
        VALUES ?root { ${values} }
        ?s ?p ?o .
        FILTER(
          ?s = ?root
          || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
        )
      }
    }`;

    const result = await this.store.query(sparql);
    return result.type === 'quads' ? result.quads : [];
  }

  private verifyMerkleMatch(workspaceQuads: Quad[], _paranetId: string, expectedMerkleRoot: Uint8Array, _ctxGraphId?: string): boolean {
    const allHashes = workspaceQuads.map(computeTripleHash);
    const computedRoot = new MerkleTree(allHashes).root;
    return ethers.hexlify(computedRoot) === ethers.hexlify(expectedMerkleRoot);
  }

  private async verifyOnChain(
    txHash: string,
    blockNumber: number,
    expectedMerkleRoot: Uint8Array,
    expectedPublisher: string,
    expectedStartKAId: bigint,
    expectedEndKAId: bigint,
    ctx: OperationContext,
    ctxGraphId?: string,
    expectedBatchId?: bigint,
  ): Promise<boolean> {
    if (!this.chain || this.chain.chainId === 'none') return false;
    if (blockNumber <= 0) return false;

    try {
      // Verify KnowledgeBatchCreated at the specific block
      const batchFilter: EventFilter = {
        eventTypes: ['KnowledgeBatchCreated'],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      };

      let batchVerified = false;
      for await (const event of this.chain.listenForEvents(batchFilter)) {
        if (event.blockNumber !== blockNumber) continue;
        if (txHash && (!event.data['txHash'] || (event.data['txHash'] as string).toLowerCase() !== txHash.toLowerCase())) {
          continue;
        }

        const eventMerkle = typeof event.data['merkleRoot'] === 'string'
          ? ethers.getBytes(event.data['merkleRoot'] as string)
          : event.data['merkleRoot'] as Uint8Array;
        const eventPublisher = (event.data['publisherAddress'] as string) ?? '';
        const eventStartKAId = BigInt(event.data['startKAId'] as string ?? '0');
        const eventEndKAId = BigInt(event.data['endKAId'] as string ?? '0');

        const merkleMatch = ethers.hexlify(eventMerkle) === ethers.hexlify(expectedMerkleRoot);
        const publisherMatch = eventPublisher.toLowerCase() === expectedPublisher.toLowerCase();
        const rangeMatch = eventStartKAId === expectedStartKAId && eventEndKAId === expectedEndKAId;

        if (merkleMatch && publisherMatch && rangeMatch) { batchVerified = true; break; }
      }

      if (!batchVerified) return false;

      // For context graph finalizations, also verify ContextGraphExpanded
      // (may be at a later block since addBatchToContextGraph is a separate tx)
      if (ctxGraphId) {
        const scanWindow = 256;
        const headBlock = typeof this.chain.getBlockNumber === 'function'
          ? await this.chain.getBlockNumber()
          : blockNumber + scanWindow;
        const cgFilter: EventFilter = {
          eventTypes: ['ContextGraphExpanded'],
          fromBlock: blockNumber,
          toBlock: Math.min(blockNumber + scanWindow, headBlock),
        };
        for await (const event of this.chain.listenForEvents(cgFilter)) {
          const eventCGId = String(event.data['contextGraphId'] ?? '');
          const eventBatchId = BigInt(event.data['batchId'] as string ?? '0');
          if (eventCGId === ctxGraphId && (expectedBatchId === undefined || eventBatchId === expectedBatchId)) return true;
        }
        return false;
      }

      return true;
    } catch (err) {
      this.log.info(ctx, `Finalization on-chain verification pending (RPC may be lagging): ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  private async promoteWorkspaceToCanonical(
    paranetId: string,
    workspaceQuads: Quad[],
    ual: string,
    msgRootEntities: string[],
    publisherAddress: string,
    txHash: string,
    blockNumber: number,
    startKAId: bigint,
    endKAId: bigint,
    batchId: bigint,
    ctx: OperationContext,
    ctxGraphId?: string,
  ): Promise<void> {
    const graphManager = new GraphManager(this.store);
    await graphManager.ensureParanet(paranetId);
    const dataGraph = ctxGraphId
      ? contextGraphDataUri(paranetId, ctxGraphId)
      : graphManager.dataGraphUri(paranetId);

    const canonicalQuads = workspaceQuads.map(q => ({ ...q, graph: dataGraph }));
    await this.store.insert(canonicalQuads);

    const allHashes = canonicalQuads.map(computeTripleHash);
    const merkleRoot = new MerkleTree(allHashes).root;

    const partitioned = autoPartition(canonicalQuads);
    // Use the root entity order from the finalization message (matches publisher's
    // tokenId assignment) instead of re-sorting, which could remap tokenId -> rootEntity.
    const rootEntities = msgRootEntities.length > 0
      ? msgRootEntities
      : [...partitioned.keys()];
    const kaMetadata: KAMetadata[] = [];

    for (let tokenIdx = 0; tokenIdx < rootEntities.length; tokenIdx++) {
      const rootEntity = rootEntities[tokenIdx];
      const entityQuads = partitioned.get(rootEntity) ?? [];
      if (entityQuads.length === 0) continue;
      kaMetadata.push({
        rootEntity,
        kcUal: ual,
        tokenId: startKAId + BigInt(tokenIdx),
        publicTripleCount: entityQuads.length,
        privateTripleCount: 0,
        privateMerkleRoot: undefined,
      });
    }

    const kcMeta: KCMetadata = {
      ual,
      paranetId,
      merkleRoot,
      kaCount: kaMetadata.length,
      publisherPeerId: publisherAddress,
      timestamp: new Date(),
    };

    let blockTimestamp = Math.floor(Date.now() / 1000);
    if (this.chain && typeof (this.chain as any).getBlockTimestamp === 'function') {
      try {
        blockTimestamp = await (this.chain as any).getBlockTimestamp(blockNumber);
      } catch {
        this.log.info(ctx, `Could not fetch block timestamp for block ${blockNumber}, using local time`);
      }
    }

    const provenance: OnChainProvenance = {
      txHash,
      blockNumber,
      blockTimestamp,
      publisherAddress,
      batchId,
      chainId: this.chain?.chainId ?? 'unknown',
    };

    let metaQuads = generateConfirmedFullMetadata(kcMeta, kaMetadata, provenance);
    if (ctxGraphId) {
      const defaultMeta = `did:dkg:paranet:${paranetId}/_meta`;
      const targetMeta = contextGraphMetaUri(paranetId, ctxGraphId);
      metaQuads = metaQuads.map((q) =>
        q.graph === defaultMeta ? { ...q, graph: targetMeta } : q,
      );
    }
    await this.store.insert(metaQuads);

    // Clean up promoted workspace entries
    const workspaceGraph = paranetWorkspaceGraphUri(paranetId);
    const wsMetaGraph = paranetWorkspaceMetaGraphUri(paranetId);
    for (const rootEntity of rootEntities) {
      await this.store.deleteByPattern({ graph: workspaceGraph, subject: rootEntity });
      await this.store.deleteBySubjectPrefix(workspaceGraph, rootEntity + '/.well-known/genid/');
      await this.store.deleteByPattern({
        graph: wsMetaGraph, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
      });
      await this.deleteMetaForRoot(wsMetaGraph, rootEntity);
    }

    this.log.info(ctx, `Promoted ${canonicalQuads.length} quads from workspace to canonical for ${ual}`);
  }

  private async deleteMetaForRoot(metaGraph: string, rootEntity: string): Promise<void> {
    const DKG = 'http://dkg.io/ontology/';
    const result = await this.store.query(
      `SELECT ?op WHERE { GRAPH <${metaGraph}> { ?op <${DKG}rootEntity> <${rootEntity}> } }`,
    );
    if (result.type !== 'bindings') return;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;
      await this.store.delete([{
        subject: op, predicate: `${DKG}rootEntity`, object: rootEntity, graph: metaGraph,
      }]);
      const remaining = await this.store.query(
        `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${metaGraph}> { <${op}> <${DKG}rootEntity> ?r } }`,
      );
      const rawCount = remaining.type === 'bindings' && remaining.bindings[0]?.['c'];
      const countVal = typeof rawCount === 'string'
        ? Number(rawCount.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, ''))
        : NaN;
      if (countVal === 0) {
        await this.store.deleteByPattern({ graph: metaGraph, subject: op });
      }
    }
  }
}

function protoToNumber(val: number | bigint | { low: number; high: number; unsigned: boolean }): number {
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'number') return val;
  return ((val.high >>> 0) * 0x100000000) + (val.low >>> 0);
}

function protoToBigInt(val: number | bigint | { low: number; high: number; unsigned: boolean }): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  return (BigInt(val.high >>> 0) << 32n) | BigInt(val.low >>> 0);
}

function isSafeIri(value: string): boolean {
  if (!value) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`]*$/.test(value);
}
