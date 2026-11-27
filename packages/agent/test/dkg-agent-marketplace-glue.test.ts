// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's marketplace methods (`dkg-agent-marketplace.ts`, OT-RFC-27):
 * the chain's marketplace surface for the daemon's buyer and seller, and the
 * peer protocol's `quote` and `serve` over the node's messenger. Each method
 * runs against a stub chain or a stub messenger, so no node starts.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';
import { PROTOCOL_MARKETPLACE_QUOTE, PROTOCOL_MARKETPLACE_SERVE } from '@origintrail-official/dkg-core';
import {
  MarketplaceAgentMethods,
  type MarketplaceHandler,
  type MarketplaceMessage,
} from '../src/dkg-agent-marketplace.js';

const methods = MarketplaceAgentMethods.prototype;
const SELLER = '12D3KooWMarketplaceSellerPeer';
const PROTOCOL: Record<MarketplaceMessage, string> = {
  quote: PROTOCOL_MARKETPLACE_QUOTE,
  serve: PROTOCOL_MARKETPLACE_SERVE,
};

interface GroupEntry {
  protocolId: string;
  handler: MarketplaceHandler;
  options?: { maxWireBytes?: number };
}

interface SendOpts {
  timeoutMs: number;
  maxReadBytes: number;
  messageId?: string;
}

describe("an agent's chain marketplace", () => {
  it("is what the chain's marketplaceChain() hands out", () => {
    const marketplace = { getMarketplaceContracts: vi.fn(), getPublishingConvictionAccountInfo: vi.fn() };
    const chain = { chainId: 'evm:31337', marketplaceChain: vi.fn(() => marketplace) };
    expect(methods.marketplaceChain.call({ chain } as never)).toBe(marketplace);
    // Asking for the marketplace reads nothing from the chain.
    expect(marketplace.getMarketplaceContracts).not.toHaveBeenCalled();
    expect(marketplace.getPublishingConvictionAccountInfo).not.toHaveBeenCalled();
  });

  it('is the mock chain itself, as the daemon and its tests are handed it', () => {
    const chain = new MockChainAdapter('mock:31337', '0x0000000000000000000000000000000000000002');
    expect(methods.marketplaceChain.call({ chain } as never)).toBe(chain);
  });

  it('is null with no chain configured', () => {
    expect(methods.marketplaceChain.call({ chain: new NoChainAdapter() } as never)).toBeNull();
  });

  it('is null for a chain without marketplaceChain(), whatever methods it has', () => {
    const chain = { chainId: 'evm:31337', getMarketplaceContracts: vi.fn(), getPublishingConvictionAccountInfo: vi.fn() };
    expect(methods.marketplaceChain.call({ chain } as never)).toBeNull();
  });
});

describe('the handlers a seller registers', () => {
  it('registers quote and serve as one group, each with its handler and byte limit, and returns its removal', () => {
    const remove = vi.fn();
    const registerGroup = vi.fn((_entries: readonly GroupEntry[]) => remove);
    const quote: MarketplaceHandler = async () => new Uint8Array([1]);
    const serve: MarketplaceHandler = async () => new Uint8Array([2]);

    const returned = methods.registerMarketplaceHandlers.call(
      { messenger: { registerGroup } } as never,
      { quote, serve },
      { quote: 4_096, serve: 1_048_576 },
    );

    expect(returned).toBe(remove);
    expect(remove).not.toHaveBeenCalled();
    expect(registerGroup).toHaveBeenCalledOnce();
    const entries = registerGroup.mock.calls[0]?.[0];
    expect(entries?.map(({ protocolId, options }) => ({ protocolId, options }))).toEqual([
      { protocolId: PROTOCOL_MARKETPLACE_QUOTE, options: { maxWireBytes: 4_096 } },
      { protocolId: PROTOCOL_MARKETPLACE_SERVE, options: { maxWireBytes: 1_048_576 } },
    ]);
    expect(entries?.[0]?.handler).toBe(quote);
    expect(entries?.[1]?.handler).toBe(serve);
  });
});

describe('a marketplace message to a seller', () => {
  it.each(['quote', 'serve'] as const)(
    "sends a %s request-owned on its own protocol and answers with the seller's response",
    async (kind) => {
      const response = new Uint8Array([9, 9]);
      const sendRequestOwned = vi.fn(async (_peerId: string, _protocolId: string, _payload: Uint8Array, _opts: SendOpts) => ({
        delivered: true as const,
        response,
        attempts: 1,
        messageId: `${kind}-1`,
      }));
      const payload = new Uint8Array([7]);
      const opts: SendOpts = { timeoutMs: 5_000, maxReadBytes: 65_536, messageId: `${kind}-1` };

      await expect(methods.sendMarketplaceMessage.call(
        { messenger: { sendRequestOwned } } as never, SELLER, kind, payload, opts,
      )).resolves.toBe(response);

      expect(sendRequestOwned).toHaveBeenCalledOnce();
      const [peerId, protocolId, sent, sentOpts] = sendRequestOwned.mock.calls[0] ?? [];
      expect(peerId).toBe(SELLER);
      expect(protocolId).toBe(PROTOCOL[kind]);
      // The payload and the options, with the request's messageId, go to the messenger as given.
      expect(sent).toBe(payload);
      expect(sentOpts).toBe(opts);
    },
  );

  it("fails with the kind, the seller and the messenger's error when the message is not delivered", async () => {
    const error = 'send already in flight for this messageId';
    // The one undelivered result a request-owned send returns: it never queues.
    const sendRequestOwned = vi.fn(async (_peerId: string, _protocolId: string, _payload: Uint8Array, _opts: SendOpts) => ({
      delivered: false as const,
      queued: false as const,
      inFlight: true as const,
      attempts: 0 as const,
      messageId: 'quote-1',
      error,
    }));

    await expect(methods.sendMarketplaceMessage.call(
      { messenger: { sendRequestOwned } } as never,
      SELLER,
      'quote',
      new Uint8Array([1]),
      { timeoutMs: 1_000, maxReadBytes: 4_096, messageId: 'quote-1' },
    )).rejects.toThrow(new Error(`marketplace quote to ${SELLER} was not delivered: ${error}`));

    expect(sendRequestOwned).toHaveBeenCalledOnce();
    expect(sendRequestOwned.mock.calls[0]?.[1]).toBe(PROTOCOL_MARKETPLACE_QUOTE);
  });
});
