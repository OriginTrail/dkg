import { describe, expect, it, vi } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { PhaseCallback, PublishResult } from '@origintrail-official/dkg-publisher';
import { PublishMethods } from '../src/dkg-agent-publish.js';

const CONTEXT_GRAPH_ID = 'broadcast-phase-cg';
const PUBLIC_QUADS: Quad[] = [
  {
    subject: 'http://example.org/resource',
    predicate: 'http://example.org/name',
    object: '"resource"',
    graph: 'http://example.org/graph',
  },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function publishResult(overrides: Partial<PublishResult> = {}): PublishResult {
  return {
    kaId: 1n,
    ual: 'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/1',
    merkleRoot: new Uint8Array(32),
    kaManifest: [],
    status: 'confirmed',
    publicQuads: PUBLIC_QUADS,
    ...overrides,
  };
}

function makePublishHarness() {
  const broadcastPublish = vi.fn(async () => undefined);
  const agent = {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    chain: { chainId: 'mock:31337' },
    subscribedContextGraphs: new Set([CONTEXT_GRAPH_ID]),
    peerId: 'publisher-peer',
    publisher: {
      publish: vi.fn(async () => publishResult()),
    },
    createV10ACKProvider: vi.fn(() => undefined),
    getContextGraphOnChainId: vi.fn(async () => null),
    _resolveEncryptInlinePayload: vi.fn(async () => undefined),
    _resolveEncryptInlineChunked: vi.fn(async () => undefined),
    broadcastPublish,
    emitPublicProjectionAfterPublish: vi.fn(async () => undefined),
  };

  return { agent, broadcastPublish };
}

function makeUpdateHarness() {
  const gossipPublish = vi.fn(async () => undefined);
  const agent = {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    node: { peerId: { toString: () => 'publisher-peer' } },
    publisher: {
      update: vi.fn(async () => publishResult({
        onChainResult: {
          batchId: 1n,
          startKAId: 1n,
          endKAId: 1n,
          txHash: `0x${'ab'.repeat(32)}`,
          blockNumber: 10,
          blockTimestamp: 1_700_000_000,
          publisherAddress: '0x1111111111111111111111111111111111111111',
        },
      })),
    },
    gossip: { publish: gossipPublish },
    getContextGraphOnChainId: vi.fn(async () => null),
    createV10UpdateACKProvider: vi.fn(() => undefined),
    _resolveEncryptInlinePayload: vi.fn(async () => undefined),
  };

  return { agent, gossipPublish };
}

describe('agent broadcast phase callbacks', () => {
  it('awaits publish broadcast:start before broadcasting to peers', async () => {
    const { agent, broadcastPublish } = makePublishHarness();
    const entered = deferred();
    const gate = deferred();
    const onPhase: PhaseCallback = async (phase, status) => {
      if (phase === 'broadcast' && status === 'start') {
        entered.resolve();
        await gate.promise;
      }
    };

    const pending = PublishMethods.prototype._publish.call(
      agent as never,
      CONTEXT_GRAPH_ID,
      PUBLIC_QUADS,
      undefined,
      { onPhase },
    );

    await entered.promise;
    expect(broadcastPublish).not.toHaveBeenCalled();

    gate.resolve();
    await pending;
    expect(broadcastPublish).toHaveBeenCalledOnce();
  });

  it('propagates publish broadcast:start rejection without broadcasting to peers', async () => {
    const { agent, broadcastPublish } = makePublishHarness();
    const rejection = new Error('publish phase journal unavailable');
    const onPhase: PhaseCallback = async (phase, status) => {
      if (phase === 'broadcast' && status === 'start') throw rejection;
    };

    await expect(PublishMethods.prototype._publish.call(
      agent as never,
      CONTEXT_GRAPH_ID,
      PUBLIC_QUADS,
      undefined,
      { onPhase },
    )).rejects.toBe(rejection);

    expect(broadcastPublish).not.toHaveBeenCalled();
  });

  it('awaits update broadcast:start before publishing update gossip', async () => {
    const { agent, gossipPublish } = makeUpdateHarness();
    const entered = deferred();
    const gate = deferred();
    const onPhase: PhaseCallback = async (phase, status) => {
      if (phase === 'broadcast' && status === 'start') {
        entered.resolve();
        await gate.promise;
      }
    };

    const pending = PublishMethods.prototype.update.call(
      agent as never,
      1n,
      CONTEXT_GRAPH_ID,
      PUBLIC_QUADS,
      undefined,
      { onPhase },
    );

    await entered.promise;
    expect(gossipPublish).not.toHaveBeenCalled();

    gate.resolve();
    await pending;
    expect(gossipPublish).toHaveBeenCalledOnce();
  });

  it('propagates update broadcast:start rejection without publishing update gossip', async () => {
    const { agent, gossipPublish } = makeUpdateHarness();
    const rejection = new Error('update phase journal unavailable');
    const onPhase: PhaseCallback = async (phase, status) => {
      if (phase === 'broadcast' && status === 'start') throw rejection;
    };

    await expect(PublishMethods.prototype.update.call(
      agent as never,
      1n,
      CONTEXT_GRAPH_ID,
      PUBLIC_QUADS,
      undefined,
      { onPhase },
    )).rejects.toBe(rejection);

    expect(gossipPublish).not.toHaveBeenCalled();
  });
});
