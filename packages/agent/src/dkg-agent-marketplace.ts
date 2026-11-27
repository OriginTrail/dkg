// SPDX-License-Identifier: Apache-2.0

/**
 * The marketplace facade (OT-RFC-27): the chain adapter's marketplace surface,
 * for the daemon's buyer and seller, as the account facade gives the
 * Conviction Account methods; and the peer protocol's transport:
 * `quote` and `serve`, request and response, over the node's messenger.
 * A marketplace message is sent request-owned: it never goes through the
 * durable outbox, since a request that waited would expire anyway.
 */

import { PROTOCOL_MARKETPLACE_QUOTE, PROTOCOL_MARKETPLACE_SERVE } from '@origintrail-official/dkg-core';
import { marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgentBase } from './dkg-agent-base.js';

export type MarketplaceMessage = 'quote' | 'serve';

/** A handler gets a message's bytes and the sending peer, and returns the answer's bytes. */
export type MarketplaceHandler = (payload: Uint8Array, peerId: string) => Promise<Uint8Array>;

const PROTOCOLS: Record<MarketplaceMessage, string> = {
  quote: PROTOCOL_MARKETPLACE_QUOTE,
  serve: PROTOCOL_MARKETPLACE_SERVE,
};

export class MarketplaceAgentMethods extends DKGAgentBase {
  /** The chain's marketplace, or `null` when the chain has none (no chain configured). */
  marketplaceChain(): MarketplaceChainAdapter | null {
    return marketplaceChainOf(this.chain);
  }

  /**
   * Answer the peer protocol's messages: a seller's handlers, each with the
   * most bytes it takes in. Returns the function that removes them.
   */
  registerMarketplaceHandlers(
    handlers: Record<MarketplaceMessage, MarketplaceHandler>,
    maxWireBytes: Record<MarketplaceMessage, number>,
  ): () => void {
    return this.messenger.registerGroup((Object.keys(PROTOCOLS) as MarketplaceMessage[]).map((kind) => ({
      protocolId: PROTOCOLS[kind],
      handler: handlers[kind],
      options: { maxWireBytes: maxWireBytes[kind] },
    })));
  }

  /**
   * Send one message to a seller and wait for its answer, within `timeoutMs`
   * and reading at most `maxReadBytes`. `messageId` names the request, so a
   * retry of the same request is the same message to both messengers.
   */
  async sendMarketplaceMessage(
    peerId: string,
    kind: MarketplaceMessage,
    payload: Uint8Array,
    opts: { timeoutMs: number; maxReadBytes: number; messageId?: string },
  ): Promise<Uint8Array> {
    const result = await this.messenger.sendRequestOwned(peerId, PROTOCOLS[kind], payload, opts);
    if (!result.delivered) throw new Error(`marketplace ${kind} to ${peerId} was not delivered: ${result.error}`);
    return result.response;
  }
}
