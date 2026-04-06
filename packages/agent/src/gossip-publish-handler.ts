import {
  decodePublishRequest, SYSTEM_PARANETS, DKG_ONTOLOGY,
  Logger, createOperationContext,
  isSafeIri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { GraphManager, type TripleStore, type Quad } from '@origintrail-official/dkg-storage';
import { type ChainAdapter, type EventFilter } from '@origintrail-official/dkg-chain';
import {
  computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot, autoPartition,
  generateTentativeMetadata, getTentativeStatusQuad, getConfirmedStatusQuad,
  validatePublishRequest, parseSimpleNQuads,
  type KAMetadata,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

export type GossipPhaseCallback = (phase: string, status: 'start' | 'end') => void;

export interface GossipPublishHandlerCallbacks {
  contextGraphExists: (id: string) => Promise<boolean>;
  subscribeToContextGraph: (id: string, options?: { trackSyncScope?: boolean }) => void;
  onPhase?: GossipPhaseCallback;
}

export class GossipPublishHandler {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter | undefined;
  private readonly subscribedContextGraphs: Map<string, any>;
  private readonly callbacks: GossipPublishHandlerCallbacks;
  private readonly log = new Logger('GossipPublishHandler');

  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    subscribedContextGraphs: Map<string, any>,
    callbacks: GossipPublishHandlerCallbacks,
  ) {
    this.store = store;
    this.chain = chain;
    this.subscribedContextGraphs = subscribedContextGraphs;
    this.callbacks = callbacks;
  }

  async handlePublishMessage(data: Uint8Array, contextGraphId: string, onPhase?: GossipPhaseCallback): Promise<void> {
    let ctx = createOperationContext('gossip');
    const phase = onPhase ?? this.callbacks.onPhase;
    try {
      phase?.('decode', 'start');
      let request;
      try {
        request = decodePublishRequest(data);
        if (request.operationId) {
          ctx = createOperationContext('gossip', request.operationId);
        }

        if (!request.paranetId) {
          request.paranetId = contextGraphId;
        } else if (request.paranetId !== contextGraphId) {
          // If the decoded paranetId contains non-printable characters, this is a
          // different message type (e.g. finalization) that was decoded as a publish
          // request. Silently skip to avoid spammy WARN logs.
          if (/[^\x20-\x7E]/.test(request.paranetId)) return;
          this.log.warn(ctx, `Gossip: request contextGraphId "${request.paranetId}" does not match topic "${contextGraphId}", ignoring`);
          return;
        }
      } finally {
        phase?.('decode', 'end');
      }

      const nquadsStr = new TextDecoder().decode(request.nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      if (quads.length === 0 && !request.ual) {
        this.log.warn(ctx, 'Gossip: empty broadcast with no UAL, ignoring');
        return;
      }

      const graphManager = new GraphManager(this.store);
      await graphManager.ensureParanet(request.paranetId);
      const dataGraph = graphManager.dataGraphUri(request.paranetId);
      let normalized = quads.map(q => ({ ...q, graph: dataGraph }));

      // When receiving ontology-topic broadcasts, skip context graph definition
      // triples for context graphs we already have locally. This prevents duplicate
      // creator/timestamp triples when multiple nodes create the same context graph
      // during simultaneous startup.
      // Also auto-subscribe to any newly discovered context graphs.
      if (request.paranetId === SYSTEM_PARANETS.ONTOLOGY) {
        const contextGraphPrefix = 'did:dkg:context-graph:';
        const incomingContextGraphUris = new Set(
          normalized
            .filter(q => q.predicate === DKG_ONTOLOGY.RDF_TYPE && q.object === DKG_ONTOLOGY.DKG_PARANET)
            .map(q => q.subject),
        );
        if (incomingContextGraphUris.size > 0) {
          const duplicateUris = new Set<string>();
          const newContextGraphIds: string[] = [];
          for (const uri of incomingContextGraphUris) {
            const id = uri.startsWith(contextGraphPrefix) ? uri.slice(contextGraphPrefix.length) : null;
            if (!id) continue;
            if (await this.callbacks.contextGraphExists(id)) {
              duplicateUris.add(uri);
            } else if (id !== SYSTEM_PARANETS.AGENTS && id !== SYSTEM_PARANETS.ONTOLOGY) {
              newContextGraphIds.push(id);
            }
          }
          if (duplicateUris.size > 0) {
            const activityUris = new Set(
              normalized
                .filter(q => duplicateUris.has(q.subject) && q.predicate === DKG_ONTOLOGY.PROV_GENERATED_BY)
                .map(q => q.object),
            );
            normalized = normalized.filter(q => !duplicateUris.has(q.subject) && !activityUris.has(q.subject));
          }

          for (const newId of newContextGraphIds) {
            const nameQuad = normalized.find(q =>
              q.subject === `${contextGraphPrefix}${newId}` && q.predicate === DKG_ONTOLOGY.SCHEMA_NAME,
            );
            const name = nameQuad ? stripLiteral(nameQuad.object) : newId;
            this.subscribedContextGraphs.set(newId, {
              name,
              subscribed: true,
              synced: true,
              onChainId: this.subscribedContextGraphs.get(newId)?.onChainId,
            });
            this.callbacks.subscribeToContextGraph(newId, { trackSyncScope: false });
            this.log.info(ctx, `Discovered context graph "${name}" (${newId}) via gossip — auto-subscribed`);
          }
        }
      }

      // Structural validation (I-002): reject malformed gossip before inserting.
      // Only applies to real publishes with a manifest — ontology/context graph
      // broadcasts (no UAL or no KAs) bypass validation.
      phase?.('validate', 'start');
      let isReplay = false;
      if (request.ual && request.kas?.length > 0) {
        const manifest = request.kas.map(ka => ({
          tokenId: 0n,
          rootEntity: ka.rootEntity,
          privateTripleCount: ka.privateTripleCount ?? 0,
        }));

        const rootEntities = manifest.map(m => m.rootEntity).filter(isSafeIri);
        if (rootEntities.length === 0) {
          this.log.warn(ctx, `Gossip structural validation rejected publish ${request.ual}: no valid root entities`);
          return;
        }
        const sparql = `SELECT DISTINCT ?s WHERE { GRAPH <${dataGraph}> { ?s ?p ?o } VALUES ?s { ${rootEntities.map(e => `<${e}>`).join(' ')} } }`;
        const result = await this.store.query(sparql);
        const existingEntities = new Set<string>(
          result.type === 'bindings' ? result.bindings.map(b => b['s']).filter(Boolean) : [],
        );

        const validation = validatePublishRequest(normalized, manifest, request.paranetId, existingEntities);
        if (!validation.valid) {
          const allRule4 = validation.errors.every(e => e.startsWith('Rule 4'));
          if (!allRule4) {
            this.log.warn(ctx, `Gossip structural validation rejected publish ${request.ual}: ${validation.errors.join('; ')}`);
            return;
          }
          this.log.info(ctx, `Gossip replay detected for ${request.ual}, skipping data insert but running verification`);
          isReplay = true;
        }
      }

      phase?.('validate', 'end');

      phase?.('store', 'start');
      if (normalized.length > 0 && !isReplay) {
        await this.store.insert(normalized);
      }

      if (request.ual) {
        const privateRoots = (request.kas ?? [])
          .filter(ka => ka.privateMerkleRoot?.length)
          .map(ka => new Uint8Array(ka.privateMerkleRoot));
        const merkleRoot = computeFlatKCRoot(normalized, privateRoots);

        const partitioned = autoPartition(normalized);
        const kaMetadata: KAMetadata[] = [];

        for (const [rootEntity, entityQuads] of partitioned) {
          const kaEntry = request.kas?.find((ka) => ka.rootEntity === rootEntity);
          const tokenId = kaEntry ? protoToNumber(kaEntry.tokenId) : 0;
          kaMetadata.push({
            rootEntity,
            kcUal: request.ual,
            tokenId: BigInt(tokenId),
            publicTripleCount: entityQuads.length,
            privateTripleCount: kaEntry?.privateTripleCount ?? 0,
            privateMerkleRoot: kaEntry?.privateMerkleRoot?.length
              ? new Uint8Array(kaEntry.privateMerkleRoot) : undefined,
          });
        }

        const kcMeta = {
          ual: request.ual,
          contextGraphId: request.paranetId,
          merkleRoot,
          kaCount: kaMetadata.length,
          publisherPeerId: request.publisherAddress || 'unknown',
          timestamp: new Date(),
        };

        // Always store gossip-received data as tentative first —
        // never trust self-reported on-chain status from gossip messages.
        const metaQuads = generateTentativeMetadata(kcMeta, kaMetadata);
        await this.store.insert(metaQuads);
        phase?.('store', 'end');

        // If the gossip message includes on-chain proof (txHash + blockNumber),
        // attempt targeted verification and promote to confirmed if valid.
        const txHash = request.txHash ?? '';
        const blockNumber = protoToNumber(request.blockNumber ?? 0);
        const startKAId = protoToBigInt(request.startKAId ?? 0);
        const endKAId = protoToBigInt(request.endKAId ?? 0);

        if (txHash && blockNumber > 0 && startKAId > 0n && request.publisherAddress) {
          phase?.('chain-verify', 'start');
          const verified = await this.verifyGossipOnChain(
            txHash, blockNumber, merkleRoot, request.publisherAddress,
            startKAId, endKAId,
            ctx,
          );
          if (verified) {
            await this.promoteGossipToConfirmed(request.ual, request.paranetId, kcMeta, kaMetadata);
            this.log.info(ctx, `Gossip publish ${request.ual} verified on-chain (tx=${txHash.slice(0, 10)}…, block=${blockNumber})`);
          } else {
            this.log.info(ctx, `Gossip publish ${request.ual} stored as tentative (on-chain verification failed or pending)`);
          }
          phase?.('chain-verify', 'end');
        } else {
          this.log.info(ctx, `Gossip publish ${request.ual} stored as tentative (no on-chain proof in message)`);
        }
      } else {
        phase?.('store', 'end');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/wire type|index out of range|offset|unexpected tag/i.test(errMsg)) return;
      this.log.warn(ctx, `Gossip: failed to process publish broadcast: ${errMsg}`);
    }
  }

  /**
   * Verify a gossip-received publish by doing a targeted on-chain lookup
   * at the exact block specified in the gossip message. Uses both fromBlock
   * and toBlock to constrain the scan to a single block, and validates
   * txHash against event data when available.
   */
  private async verifyGossipOnChain(
    txHash: string,
    blockNumber: number,
    expectedMerkleRoot: Uint8Array,
    expectedPublisher: string,
    expectedStartKAId: bigint,
    expectedEndKAId: bigint,
    ctx: OperationContext,
  ): Promise<boolean> {
    if (!this.chain || this.chain.chainId === 'none') return false;

    if (blockNumber <= 0) {
      this.log.warn(ctx, `Gossip verification skipped: invalid blockNumber=${blockNumber}`);
      return false;
    }

    try {
      const filter: EventFilter = {
        eventTypes: ['KnowledgeBatchCreated', 'KCCreated'],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      };
      for await (const event of this.chain.listenForEvents(filter)) {
        if (event.blockNumber !== blockNumber) continue;

        if (txHash) {
          if (!event.data['txHash'] || (event.data['txHash'] as string).toLowerCase() !== txHash.toLowerCase()) {
            continue;
          }
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

        if (merkleMatch && publisherMatch && rangeMatch) {
          return true;
        }
      }
    } catch (err) {
      this.log.warn(ctx, `Gossip on-chain verification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  /**
   * Promote gossip-received tentative data to confirmed via a status-only
   * swap: insert the confirmed quad first, then delete the tentative one,
   * so metadata is never lost even if the second operation fails.
   */
  private async promoteGossipToConfirmed(
    ual: string,
    paranetId: string,
    _kcMeta: { ual: string; contextGraphId: string; merkleRoot: Uint8Array; kaCount: number; publisherPeerId: string; timestamp: Date },
    _kaMetadata: KAMetadata[],
  ): Promise<void> {
    const tentativeStatus = getTentativeStatusQuad(ual, paranetId);
    const confirmedStatus = getConfirmedStatusQuad(ual, paranetId);
    try {
      await this.store.insert([confirmedStatus]);
      await this.store.delete([tentativeStatus]);
    } catch (err) {
      this.log.warn(
        createOperationContext('gossip'),
        `Failed to promote gossip tentative→confirmed for ${ual}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function protoToNumber(val: number | { low: number; high: number; unsigned: boolean }): number {
  if (typeof val === 'number') return val;
  return ((val.high >>> 0) * 0x100000000) + (val.low >>> 0);
}

function protoToBigInt(val: number | bigint | { low: number; high: number; unsigned: boolean }): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  return (BigInt(val.high >>> 0) << 32n) | BigInt(val.low >>> 0);
}


function stripLiteral(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}
