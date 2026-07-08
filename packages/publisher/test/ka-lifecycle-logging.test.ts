import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  Logger,
  TypedEventBus,
  generateEd25519Keypair,
  type LogRecord,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';
import { mockSealCtx, wrapPublisherForTest } from './_helpers/seal.js';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CONTEXT_GRAPH = '42';
const PUBLISHER_PEER_ID = 'publisher-peer-1';

function q(subject: string, predicate: string, object: string): Quad {
  return {
    subject,
    predicate,
    object,
    graph: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
  };
}

function lifecycleField(message: string, key: string): string | undefined {
  return new RegExp(`(?:^| )${key}=([^ ]+)`).exec(message)?.[1];
}

describe('KA lifecycle logging - publisher publish', () => {
  afterEach(() => {
    Logger.setSink(null);
  });

  it('emits a connected publisher-side publish sequence that can be filtered by assetUal', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.seedIdentity(wallet.address, 1n);
    chain.minimumRequiredSignatures = 1;
    const store = new OxigraphStore();
    const logEntries: LogRecord[] = [];
    Logger.setSink((entry) => logEntries.push(entry));

    const publisher = wrapPublisherForTest(new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: TEST_KEY,
      publisherNodeIdentityId: 7n,
      kaAllocator: makeTestKaAllocator(),
    }), {
      author: wallet,
      ctx: mockSealCtx({
        chainId: await chain.getEvmChainId(),
        kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
      }),
      v10ACKProvider: mockChainStubACKProvider({ identityId: 1n }),
    });

    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      publisherPeerId: PUBLISHER_PEER_ID,
      quads: [
        q('urn:ka-log:publisher-root', 'http://schema.org/name', '"PublisherLogBot"'),
        q('urn:ka-log:publisher-root', 'http://schema.org/version', '"1"'),
      ],
    });

    expect(result.status).toBe('confirmed');
    const lifecycleLogs = logEntries.filter(
      (entry) =>
        entry.message.startsWith('ka_lifecycle ') &&
        entry.message.includes(`assetUal=${result.ual}`),
    );
    expect(lifecycleLogs.map((entry) => `${lifecycleField(entry.message, 'stage')}:${lifecycleField(entry.message, 'event')}`))
      .toEqual([
        'identity:asset_ual_allocated',
        'storage_ack:request',
        'storage_ack:success',
        'chain:submit',
        'chain:confirm',
        'vm:promote',
        'finalization:complete',
      ]);
    expect(lifecycleLogs.every((entry) => entry.message.includes(`localPeerId=${PUBLISHER_PEER_ID}`))).toBe(true);
    expect(lifecycleLogs.every((entry) => entry.message.includes('localNodeIdentityId=7'))).toBe(true);

    const ackSuccess = lifecycleLogs.find((entry) => lifecycleField(entry.message, 'event') === 'success');
    expect(ackSuccess?.message).toContain('peer=mock-chain-stub');
    expect(ackSuccess?.message).toContain('peerNodeIdentityId=1');
    expect(ackSuccess?.message).toContain('outcome=success');
    expect(ackSuccess?.message).toContain('quorumCollected=1');

    const chainConfirm = lifecycleLogs.find((entry) => lifecycleField(entry.message, 'event') === 'confirm');
    expect(chainConfirm?.message).toContain(`kaId=${result.kaId}`);
    expect(chainConfirm?.message).toContain('txHash=0x');
  });
});
