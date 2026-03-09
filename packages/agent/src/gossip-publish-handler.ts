import {
  decodePublishRequest, SYSTEM_PARANETS, DKG_ONTOLOGY,
  Logger, createOperationContext,
  type OperationContext,
} from '@dkg/core';
import { GraphManager, type TripleStore, type Quad } from '@dkg/storage';
import { type ChainAdapter, type EventFilter } from '@dkg/chain';
import {
  computePublicRoot, computeKARoot, computeKCRoot, autoPartition,
  generateTentativeMetadata, getTentativeStatusQuad, getConfirmedStatusQuad,
  validatePublishRequest,
  type KAMetadata,
} from '@dkg/publisher';
import { ethers } from 'ethers';

export interface GossipPublishHandlerCallbacks {
  paranetExists: (id: string) => Promise<boolean>;
  subscribeToParanet: (id: string) => void;
}

export class GossipPublishHandler {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter | undefined;
  private readonly subscribedParanets: Map<string, any>;
  private readonly callbacks: GossipPublishHandlerCallbacks;
  private readonly log = new Logger('GossipPublishHandler');

  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    subscribedParanets: Map<string, any>,
    callbacks: GossipPublishHandlerCallbacks,
  ) {
    this.store = store;
    this.chain = chain;
    this.subscribedParanets = subscribedParanets;
    this.callbacks = callbacks;
  }

  async handlePublishMessage(data: Uint8Array, paranetId: string): Promise<void> {
    const ctx = createOperationContext('gossip');
    try {
      const request = decodePublishRequest(data);

      if (request.paranetId && request.paranetId !== paranetId) {
        this.log.warn(ctx, `Gossip: request paranetId "${request.paranetId}" does not match topic paranetId "${paranetId}", ignoring`);
        return;
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

      // When receiving ontology-topic broadcasts, skip paranet definition
      // triples for paranets we already have locally. This prevents duplicate
      // creator/timestamp triples when multiple nodes create the same paranet
      // during simultaneous startup.
      // Also auto-subscribe to any newly discovered paranets.
      if (request.paranetId === SYSTEM_PARANETS.ONTOLOGY) {
        const paranetPrefix = 'did:dkg:paranet:';
        const incomingParanetUris = new Set(
          normalized
            .filter(q => q.predicate === DKG_ONTOLOGY.RDF_TYPE && q.object === DKG_ONTOLOGY.DKG_PARANET)
            .map(q => q.subject),
        );
        if (incomingParanetUris.size > 0) {
          const duplicateUris = new Set<string>();
          const newParanetIds: string[] = [];
          for (const uri of incomingParanetUris) {
            const id = uri.startsWith(paranetPrefix) ? uri.slice(paranetPrefix.length) : null;
            if (!id) continue;
            if (await this.callbacks.paranetExists(id)) {
              duplicateUris.add(uri);
            } else if (id !== SYSTEM_PARANETS.AGENTS && id !== SYSTEM_PARANETS.ONTOLOGY) {
              newParanetIds.push(id);
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

          for (const newId of newParanetIds) {
            const nameQuad = normalized.find(q =>
              q.subject === `${paranetPrefix}${newId}` && q.predicate === DKG_ONTOLOGY.SCHEMA_NAME,
            );
            const name = nameQuad ? stripLiteral(nameQuad.object) : newId;
            this.subscribedParanets.set(newId, {
              name,
              subscribed: true,
              synced: true,
              onChainId: this.subscribedParanets.get(newId)?.onChainId,
            });
            this.callbacks.subscribeToParanet(newId);
            this.log.info(ctx, `Discovered paranet "${name}" (${newId}) via gossip — auto-subscribed`);
          }
        }
      }

      // Structural validation (I-002): reject malformed gossip before inserting.
      // Only applies to real publishes with a manifest — ontology/paranet
      // broadcasts (no UAL or no KAs) bypass validation.
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

      if (normalized.length > 0 && !isReplay) {
        await this.store.insert(normalized);
      }

      if (request.ual) {
        const partitioned = autoPartition(normalized);
        const kaRoots: Uint8Array[] = [];
        const kaMetadata: KAMetadata[] = [];

        for (const [rootEntity, entityQuads] of partitioned) {
          const publicRoot = computePublicRoot(entityQuads);
          const kaEntry = request.kas?.find((ka) => ka.rootEntity === rootEntity);
          const privateRoot = kaEntry?.privateMerkleRoot?.length
            ? new Uint8Array(kaEntry.privateMerkleRoot) : undefined;
          kaRoots.push(computeKARoot(publicRoot, privateRoot));

          const tokenId = kaEntry ? protoToNumber(kaEntry.tokenId) : 0;
          kaMetadata.push({
            rootEntity,
            kcUal: request.ual,
            tokenId: BigInt(tokenId),
            publicTripleCount: entityQuads.length,
            privateTripleCount: kaEntry?.privateTripleCount ?? 0,
            privateMerkleRoot: privateRoot,
          });
        }

        const merkleRoot = computeKCRoot(kaRoots);

        const kcMeta = {
          ual: request.ual,
          paranetId: request.paranetId,
          merkleRoot,
          kaCount: kaMetadata.length,
          publisherPeerId: request.publisherAddress || 'unknown',
          timestamp: new Date(),
        };

        // Always store gossip-received data as tentative first —
        // never trust self-reported on-chain status from gossip messages.
        const metaQuads = generateTentativeMetadata(kcMeta, kaMetadata);
        await this.store.insert(metaQuads);

        // If the gossip message includes on-chain proof (txHash + blockNumber),
        // attempt targeted verification and promote to confirmed if valid.
        const txHash = request.txHash ?? '';
        const blockNumber = protoToNumber(request.blockNumber ?? 0);
        const startKAId = protoToBigInt(request.startKAId ?? 0);
        const endKAId = protoToBigInt(request.endKAId ?? 0);

        if (txHash && blockNumber > 0 && startKAId > 0n && request.publisherAddress) {
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
        } else {
          this.log.info(ctx, `Gossip publish ${request.ual} stored as tentative (no on-chain proof in message)`);
        }
      }
    } catch (err) {
      this.log.warn(ctx, `Gossip: failed to process publish broadcast: ${err instanceof Error ? err.message : String(err)}`);
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
        eventTypes: ['KnowledgeBatchCreated'],
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
    _kcMeta: { ual: string; paranetId: string; merkleRoot: Uint8Array; kaCount: number; publisherPeerId: string; timestamp: Date },
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

function parseSimpleNQuads(text: string): Quad[] {
  const quads: Quad[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.endsWith(' .') ? trimmed.slice(0, -2).trim() : trimmed;
    const parts = splitNQuadLine(body);
    if (parts.length >= 3) {
      quads.push({
        subject: strip(parts[0]),
        predicate: strip(parts[1]),
        object: parts[2].startsWith('"') ? parts[2] : strip(parts[2]),
        graph: parts[3] ? strip(parts[3]) : '',
      });
    }
  }
  return quads;
}

function splitNQuadLine(line: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) break;
    if (line[i] === '<') {
      const end = line.indexOf('>', i);
      if (end === -1) break;
      parts.push(line.slice(i, end + 1));
      i = end + 1;
    } else if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"') {
          j++;
          if (line[j] === '@') { while (j < line.length && line[j] !== ' ') j++; }
          else if (line[j] === '^' && line[j + 1] === '^') {
            j += 2;
            if (line[j] === '<') { const end = line.indexOf('>', j); j = end + 1; }
          }
          break;
        }
        j++;
      }
      parts.push(line.slice(i, j));
      i = j;
    } else if (line[i] === '_') {
      let j = i;
      while (j < line.length && line[j] !== ' ') j++;
      parts.push(line.slice(i, j));
      i = j;
    } else break;
  }
  return parts;
}

function strip(s: string): string {
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  return s;
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

function isSafeIri(value: string): boolean {
  if (!value) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`]*$/.test(value);
}

function stripLiteral(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}
