import {
  decodeFinalizationMessage,
  paranetWorkspaceGraphUri, paranetWorkspaceMetaGraphUri,
  contextGraphDataUri, contextGraphMetaUri,
  contextGraphSubGraphUri, validateSubGraphName,
  Logger, createOperationContext,
  assertSafeIri, isSafeIri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { GraphManager, type TripleStore, type Quad } from '@origintrail-official/dkg-storage';
import { type ChainAdapter, type EventFilter } from '@origintrail-official/dkg-chain';
import {
  computeFlatKCRootV10 as computeFlatKCRoot, autoPartition,
  generateConfirmedFullMetadata, getTentativeStatusQuad,
  generateSubGraphRegistration,
  type KCMetadata, type KAMetadata, type OnChainProvenance,
} from '@origintrail-official/dkg-publisher';
const DKG_NS = 'http://dkg.io/ontology/';
import { ethers } from 'ethers';

export class FinalizationHandler {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter | undefined;
  private readonly log = new Logger('FinalizationHandler');
  private readonly processedUals = new Set<string>();

  constructor(store: TripleStore, chain: ChainAdapter | undefined) {
    this.store = store;
    this.chain = chain;
  }

  async handleFinalizationMessage(
    data: Uint8Array,
    contextGraphId: string,
    /**
     * r23-4: EVM address recovered from
     * the outer GossipEnvelope signature. When present, MUST equal the
     * inner `msg.publisherAddress`; otherwise a peer with a legitimate
     * wallet could wrap a forged finalization claiming another
     * operator's publisher address. The subsequent `verifyOnChain`
     * catches forged tx attribution, but cross-checking here rejects
     * before doing RPC.
     */
    envelopeSigner?: string,
  ): Promise<void> {
    let ctx = createOperationContext('gossip');
    try {
      const msg = decodeFinalizationMessage(data);
      if (msg.operationId) {
        ctx = createOperationContext('gossip', msg.operationId);
      }

      if (msg.paranetId && msg.paranetId !== contextGraphId) {
        this.log.warn(ctx, `Finalization: contextGraphId "${msg.paranetId}" does not match topic "${contextGraphId}", ignoring`);
        return;
      }

      // reject forged-attribution finalizations before chain RPC.
      if (envelopeSigner && msg.publisherAddress) {
        const claimed = msg.publisherAddress.toLowerCase();
        const recovered = envelopeSigner.toLowerCase();
        if (claimed !== recovered) {
          this.log.warn(
            ctx,
            `Finalization rejected: envelope signer ${envelopeSigner} ` +
              `does not match claimed publisherAddress ${msg.publisherAddress} ` +
              `(forged-attribution defence, r23-4)`,
          );
          return;
        }
      } else if (envelopeSigner && !msg.publisherAddress) {
        this.log.warn(
          ctx,
          `Finalization rejected: envelope is signed by ${envelopeSigner} ` +
            `but FinalizationMessage.publisherAddress is empty (r23-4)`,
        );
        return;
      }

      // Deduplicate: skip if we already successfully processed this UAL
      const dedupeKey = `${msg.ual}:${msg.txHash}`;
      if (this.processedUals.has(dedupeKey)) {
        this.log.info(ctx, `Finalization: already processed ${msg.ual}, skipping duplicate`);
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

      // Validate sub-graph name from gossip — reject invalid names entirely
      let subGraphName: string | undefined;
      if (msg.subGraphName) {
        const sgVal = validateSubGraphName(msg.subGraphName);
        if (sgVal.valid) {
          subGraphName = msg.subGraphName;
        } else {
          this.log.warn(ctx, `Finalization: rejected message with invalid subGraphName "${msg.subGraphName}": ${sgVal.reason}`);
          return;
        }
      }

      // Dedup guard: skip if this batch was already promoted (e.g. by ChainEventPoller)
      const targetMetaGraph = ctxGraphId
        ? contextGraphMetaUri(contextGraphId, ctxGraphId)
        : `did:dkg:context-graph:${contextGraphId}/_meta`;
      const alreadyPromoted = await this.isAlreadyConfirmed(msg.ual, targetMetaGraph);
      if (alreadyPromoted) {
        this.markProcessed(dedupeKey);
        this.log.info(ctx, `Finalization: ${msg.ual} already confirmed in ${ctxGraphId ? `context graph ${ctxGraphId}` : 'context graph'}, skipping`);
        return;
      }

      const sharedMemoryQuads = await this.getSharedMemoryQuadsForRoots(contextGraphId, msg.rootEntities, subGraphName);

      if (sharedMemoryQuads.length > 0) {
        const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, msg.rootEntities, subGraphName);
        const merkleMatch = this.verifyMerkleMatch(sharedMemoryQuads, privateRoots, msg.kcMerkleRoot);

        if (merkleMatch) {
          const batchId = protoToBigInt(msg.batchId);
          const verified = await this.verifyOnChain(
            msg.txHash, blockNumber, msg.kcMerkleRoot,
            msg.publisherAddress, startKAId, endKAId, ctx, ctxGraphId, batchId,
          );

          if (verified) {
            await this.promoteSharedMemoryToCanonical(
              contextGraphId, sharedMemoryQuads, msg.ual, msg.rootEntities,
              msg.publisherAddress, msg.txHash, blockNumber, startKAId, endKAId,
              protoToBigInt(msg.batchId), ctx, ctxGraphId, subGraphName,
            );
            this.markProcessed(dedupeKey);
            this.log.info(ctx, `Finalization: promoted SWM snapshot to ${ctxGraphId ? `context graph ${ctxGraphId}` : 'canonical'} for ${msg.ual} (tx=${msg.txHash.slice(0, 10)}…)`);
            return;
          }
          this.log.info(ctx, `Finalization: on-chain verification failed for ${msg.ual}, will retry via ChainEventPoller`);
          return;
        }
        this.log.info(ctx, `Finalization: merkle mismatch for ${msg.ual}, shared memory data differs from published`);
      } else {
        this.log.info(ctx, `Finalization: no shared memory data for ${msg.ual}, peer missed SWM sharing`);
      }

      // Fallback: no matching shared memory data. The data will arrive via
      // the regular publish topic broadcast or ChainEventPoller sync.
      this.log.info(ctx, `Finalization: ${msg.ual} requires full payload sync (no matching SWM snapshot)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Protobuf decode errors (wire type / index out of range) happen when receiving
      // a non-finalization message on this topic. Silently skip — not worth logging as WARN.
      if (/wire type|index out of range|offset|unexpected tag/i.test(msg)) return;
      this.log.warn(ctx, `Finalization: failed to process message: ${msg}`);
    }
  }

  private markProcessed(dedupeKey: string): void {
    this.processedUals.add(dedupeKey);
    if (this.processedUals.size > 10_000) {
      const first = this.processedUals.values().next().value;
      if (first) this.processedUals.delete(first);
    }
  }

  private async isAlreadyConfirmed(ual: string, metaGraph: string): Promise<boolean> {
    try {
      const result = await this.store.query(
        `ASK { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(ual)}> <http://dkg.io/ontology/status> "confirmed" } }`,
      );
      return result.type === 'boolean' && result.value === true;
    } catch {
      return false;
    }
  }

  private async getSharedMemoryQuadsForRoots(contextGraphId: string, rootEntities: string[], subGraphName?: string): Promise<Quad[]> {
    const graphManager = new GraphManager(this.store);
    const sharedMemoryGraph = subGraphName
      ? graphManager.sharedMemoryUri(contextGraphId, subGraphName)
      : paranetWorkspaceGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return [];

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
      GRAPH <${sharedMemoryGraph}> {
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

  private verifyMerkleMatch(sharedMemoryQuads: Quad[], privateRoots: Uint8Array[], expectedMerkleRoot: Uint8Array): boolean {
    const computedRoot = computeFlatKCRoot(sharedMemoryQuads, privateRoots);
    return ethers.hexlify(computedRoot) === ethers.hexlify(expectedMerkleRoot);
  }

  private async getPrivateRootsFromMeta(contextGraphId: string, rootEntities: string[], subGraphName?: string): Promise<Uint8Array[]> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : paranetWorkspaceMetaGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return [];

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const sparql = `SELECT ?entity ?root WHERE {
      GRAPH <${wsMetaGraph}> {
        VALUES ?entity { ${values} }
        ?entity <${DKG_NS}privateMerkleRoot> ?root .
      }
    }`;

    const roots: Uint8Array[] = [];
    try {
      const result = await this.store.query(sparql);
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const hex = (row['root'] as string).replace(/^"(.*)".*$/, '$1').replace(/^0x/, '');
          if (hex.length === 64) {
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            roots.push(bytes);
          }
        }
      }
    } catch { /* metadata may not exist */ }
    return roots;
  }

  private async getPublisherPeerIdFromMeta(contextGraphId: string, rootEntities: string[], subGraphName?: string): Promise<string | undefined> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : paranetWorkspaceMetaGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return undefined;

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const PROV = 'http://www.w3.org/ns/prov#';
    const sparql = `SELECT ?peerId WHERE {
      GRAPH <${wsMetaGraph}> {
        VALUES ?root { ${values} }
        ?op <${DKG_NS}rootEntity> ?root .
        ?op <${PROV}wasAttributedTo> ?peerId .
      }
    } LIMIT 1`;

    try {
      const result = await this.store.query(sparql);
      if (result.type === 'bindings' && result.bindings.length > 0) {
        const raw = result.bindings[0]['peerId'] as string;
        const peerId = raw.replace(/^"(.*)".*$/, '$1');
        if (peerId && peerId !== 'unknown') return peerId;
      }
    } catch { /* shared memory metadata may not exist */ }
    return undefined;
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
      // Verify KnowledgeBatchCreated or KCCreated (V10) at the specific block
      const batchFilter: EventFilter = {
        eventTypes: ['KnowledgeBatchCreated', 'KCCreated'],
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

      // V10 publishDirect registers the KC to the context graph internally
      // (no separate addBatchToContextGraph tx / ContextGraphExpanded event).
      // Skip the legacy ContextGraphExpanded check — the batch verification
      // above is sufficient for V10.
      if (ctxGraphId) {
        if (typeof this.chain.isV10Ready === 'function' && this.chain.isV10Ready()) {
          return true;
        }
        try {
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
        } catch {
          return true;
        }
      }

      return true;
    } catch (err) {
      this.log.info(ctx, `Finalization on-chain verification pending (RPC may be lagging): ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  private async promoteSharedMemoryToCanonical(
    contextGraphId: string,
    sharedMemoryQuads: Quad[],
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
    subGraphName?: string,
  ): Promise<void> {
    const graphManager = new GraphManager(this.store);
    await graphManager.ensureParanet(contextGraphId);
    if (subGraphName) {
      await graphManager.ensureSubGraph(contextGraphId, subGraphName);
      const sgUri = contextGraphSubGraphUri(contextGraphId, subGraphName);
      const metaGraph = `did:dkg:context-graph:${assertSafeIri(contextGraphId)}/_meta`;
      const alreadyRegistered = await this.store.query(
        `ASK { GRAPH <${metaGraph}> {
          <${assertSafeIri(sgUri)}> a <http://dkg.io/ontology/SubGraph> ;
            <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
            <http://dkg.io/ontology/createdBy> ?createdBy .
        } }`,
      );
      if (alreadyRegistered.type !== 'boolean' || !alreadyRegistered.value) {
        await this.store.insert(generateSubGraphRegistration({
          contextGraphId,
          subGraphName,
          createdBy: publisherAddress || 'finalization-discovery',
          timestamp: new Date(),
        }));
        this.log.info(ctx, `Finalization: auto-registered sub-graph "${subGraphName}" in context graph "${contextGraphId}"`);
      }
    }
    const dataGraph = subGraphName
      ? contextGraphSubGraphUri(contextGraphId, subGraphName)
      : ctxGraphId
        ? contextGraphDataUri(contextGraphId, ctxGraphId)
        : graphManager.dataGraphUri(contextGraphId);

    // Compute canonical quads now, but defer the `store.insert` until AFTER
    // the confirmed-meta write and SWM cleanup (see bottom of this method).
    //
    // Rationale: on a replica the three store mutations (canonical insert,
    // confirmed-meta insert, SWM cleanup) happen as three sequential awaits.
    // Readers polling the canonical graph (e.g. downstream consumers waiting
    // for "KC landed") can observe the canonical insert before the meta flip
    // to `confirmed` or before SWM has been drained, producing a visible
    // "data-without-confirmed-meta" intermediate state that is wrong from a
    // causal-consistency standpoint (the whole point of the finalization
    // gossip is that by the time data is canonical on a replica, the chain
    // proof is durable too). On fast dev machines the window is sub-
    // millisecond and invisible; on slower CI runners it widens to ~70 ms
    // and a poll that happens to land there sees `tentative` instead of
    // `confirmed` (flipped the `Tornado EVM integration: agent`
    // e2e-finalization suite red on every PR-224 run since the
    // sync-refactor merge at `bc65c3ae`).
    //
    // Ordering meta+cleanup BEFORE canonical insert makes the public state
    // transition single-stepped from an observer's point of view: either
    // you don't see the data yet, or you see data + confirmed meta + empty
    // SWM. The only user-visible partial state that remains (confirmed
    // meta + no data) is naturally recovered by `isAlreadyConfirmed` on the
    // next retry path, and it's strictly less broken than the converse.
    const canonicalQuads = sharedMemoryQuads.map(q => ({ ...q, graph: dataGraph }));

    const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, msgRootEntities, subGraphName);
    const merkleRoot = computeFlatKCRoot(canonicalQuads, privateRoots);

    const partitioned = autoPartition(canonicalQuads);
    const localRootSet = new Set(partitioned.keys());

    const rootEntities = msgRootEntities.length > 0
      ? msgRootEntities
      : [...partitioned.keys()];

    if (msgRootEntities.length > 0) {
      const msgSet = new Set(msgRootEntities);
      const extraInMsg = msgRootEntities.filter(r => !localRootSet.has(r));
      const missingInMsg = [...localRootSet].filter(r => !msgSet.has(r));
      if (extraInMsg.length > 0 || missingInMsg.length > 0) {
        this.log.warn(ctx, `Finalization: root entity set mismatch — extra in msg: [${extraInMsg.join(', ')}], missing: [${missingInMsg.join(', ')}]`);
      }
    }
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

    const wsPeerId = await this.getPublisherPeerIdFromMeta(contextGraphId, msgRootEntities, subGraphName);
    const kcMeta: KCMetadata = {
      ual,
      contextGraphId,
      merkleRoot,
      kaCount: kaMetadata.length,
      publisherPeerId: wsPeerId || publisherAddress,
      timestamp: new Date(),
      subGraphName,
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

    // Remove any existing tentative status for this UAL before inserting confirmed metadata.
    // For context-graph KCs, tentative status lives in the context-graph meta graph.
    const tentativeQuad = getTentativeStatusQuad(ual, contextGraphId);
    if (ctxGraphId) {
      tentativeQuad.graph = contextGraphMetaUri(contextGraphId, ctxGraphId);
    }
    try {
      await this.store.delete([tentativeQuad]);
    } catch { /* tentative status may not exist */ }

    let metaQuads = generateConfirmedFullMetadata(kcMeta, kaMetadata, provenance);
    if (ctxGraphId) {
      const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
      const targetMeta = contextGraphMetaUri(contextGraphId, ctxGraphId);
      metaQuads = metaQuads.map((q) =>
        q.graph === defaultMeta ? { ...q, graph: targetMeta } : q,
      );
    }
    await this.store.insert(metaQuads);

    // Clean up promoted shared memory entries
    const sharedMemoryGraph = subGraphName
      ? graphManager.sharedMemoryUri(contextGraphId, subGraphName)
      : paranetWorkspaceGraphUri(contextGraphId);
    const swmMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : paranetWorkspaceMetaGraphUri(contextGraphId);
    for (const rootEntity of rootEntities) {
      await this.store.deleteByPattern({ graph: sharedMemoryGraph, subject: rootEntity });
      await this.store.deleteBySubjectPrefix(sharedMemoryGraph, rootEntity + '/.well-known/genid/');
      await this.store.deleteByPattern({
        graph: swmMetaGraph, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
      });
      await this.deleteMetaForRoot(swmMetaGraph, rootEntity);
    }

    // Canonical insert LAST — see the comment above `const canonicalQuads`.
    // By the time any reader observes these quads in the canonical graph,
    // `_meta` already carries `confirmed` status + chain provenance and the
    // matching SWM entries have been drained.
    await this.store.insert(canonicalQuads);

    this.log.info(ctx, `Promoted ${canonicalQuads.length} quads from shared memory to canonical for ${ual}`);
  }

  private async deleteMetaForRoot(metaGraph: string, rootEntity: string): Promise<void> {
    const DKG = 'http://dkg.io/ontology/';
    const result = await this.store.query(
      `SELECT ?op WHERE { GRAPH <${assertSafeIri(metaGraph)}> { ?op <${DKG}rootEntity> <${assertSafeIri(rootEntity)}> } }`,
    );
    if (result.type !== 'bindings') return;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;
      await this.store.delete([{
        subject: op, predicate: `${DKG}rootEntity`, object: rootEntity, graph: metaGraph,
      }]);
      const remaining = await this.store.query(
        `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(op)}> <${DKG}rootEntity> ?r } }`,
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

