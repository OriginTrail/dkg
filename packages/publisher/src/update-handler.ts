import type { TripleStore, Quad } from '@dkg/storage';
import { GraphManager } from '@dkg/storage';
import type { EventBus } from '@dkg/core';
import type { ChainAdapter } from '@dkg/chain';
import { Logger, createOperationContext, DKGEvent } from '@dkg/core';
import { decodeKAUpdateRequest } from '@dkg/core';
import { parseSimpleNQuads } from './publish-handler.js';

/**
 * Handles incoming KA update gossip messages.
 * Verifies the on-chain transaction, then replaces local triples
 * so that the receiving node's data graph stays in sync with the
 * publisher's update.
 */
export class UpdateHandler {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  private readonly chain: ChainAdapter;
  private readonly eventBus: EventBus;
  private readonly log = new Logger('UpdateHandler');

  constructor(store: TripleStore, chain: ChainAdapter, eventBus: EventBus) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.chain = chain;
    this.eventBus = eventBus;
  }

  async handle(data: Uint8Array, fromPeerId: string): Promise<void> {
    const ctx = createOperationContext('ka-update');
    try {
      const request = decodeKAUpdateRequest(data);
      const {
        paranetId,
        batchId,
        nquads,
        manifest,
        publisherPeerId,
        publisherAddress,
        txHash,
        newMerkleRoot,
      } = request;

      this.log.info(
        ctx,
        `KA update from ${fromPeerId} for paranet ${paranetId} batchId=${batchId} tx=${txHash}`,
      );

      if (this.chain.verifyKAUpdate) {
        const verified = await this.chain.verifyKAUpdate(
          txHash,
          BigInt(batchId),
          publisherAddress,
        );
        if (!verified) {
          this.log.warn(
            ctx,
            `KA update rejected: tx ${txHash} not verified for batchId=${batchId} publisher=${publisherAddress}`,
          );
          return;
        }
      }

      await this.graphManager.ensureParanet(paranetId);
      const dataGraph = this.graphManager.dataGraphUri(paranetId);
      const nquadsStr = new TextDecoder().decode(nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      for (const m of manifest) {
        await this.store.deleteBySubjectPrefix(dataGraph, m.rootEntity);
      }

      const normalized: Quad[] = quads.map((q) => ({ ...q, graph: dataGraph }));
      await this.store.insert(normalized);

      this.log.info(
        ctx,
        `Applied KA update: ${quads.length} triples for batchId=${batchId}`,
      );

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
}
