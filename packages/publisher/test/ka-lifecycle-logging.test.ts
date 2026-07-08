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
import { QuorumUnmetError } from '../src/ack-errors.js';
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
        'wm:write',
        'swm_share:prepared',
        'storage_ack:request',
        'storage_ack:success',
        'storage_ack:quorum',
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

    const wmWrite = lifecycleLogs.find((entry) => lifecycleField(entry.message, 'stage') === 'wm');
    expect(wmWrite?.message).toContain('recordCount=2');
    expect(wmWrite?.message).not.toContain('PublisherLogBot');

    const swmPrepared = lifecycleLogs.find((entry) => lifecycleField(entry.message, 'stage') === 'swm_share');
    expect(swmPrepared?.message).toContain('source=inline');

    const ackQuorum = lifecycleLogs.find((entry) => lifecycleField(entry.message, 'event') === 'quorum');
    expect(ackQuorum?.message).toContain('outcome=success');
    expect(ackQuorum?.message).toContain('quorumCollected=1');

    const chainConfirm = lifecycleLogs.find((entry) => lifecycleField(entry.message, 'event') === 'confirm');
    expect(chainConfirm?.message).toContain(`kaId=${result.kaId}`);
    expect(chainConfirm?.message).toContain('txHash=0x');
  });

  it('logs ACK declines and quorum failure under the allocated assetUal', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.seedIdentity(wallet.address, 1n);
    chain.minimumRequiredSignatures = 2;
    const store = new OxigraphStore();
    const logEntries: LogRecord[] = [];
    Logger.setSink((entry) => logEntries.push(entry));
    const quorumError = new QuorumUnmetError({
      collected: 0,
      required: 2,
      dialled: 2,
      peerOutcomes: [
        {
          peerId: 'peer-decline-1',
          dialOk: true,
          protocolSupported: true,
          swmHostModeAdvertised: true,
          reason: 'STORAGE_ACK_DECLINE:NO_DATA_IN_SWM',
        },
      ],
      legacyMessage: 'storage_ack_insufficient',
    });

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
    });

    await expect(publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      publisherPeerId: PUBLISHER_PEER_ID,
      quads: [
        q('urn:ka-log:ack-failure-root', 'http://schema.org/name', '"AckFailureBot"'),
      ],
      v10ACKProvider: async () => {
        throw quorumError;
      },
    })).rejects.toBe(quorumError);

    const lifecycleLogs = logEntries.filter((entry) => entry.message.startsWith('ka_lifecycle '));
    const assetUal = lifecycleField(lifecycleLogs[0]!.message, 'assetUal');
    const scopedLogs = lifecycleLogs.filter((entry) => entry.message.includes(`assetUal=${assetUal}`));

    expect(scopedLogs.map((entry) => `${lifecycleField(entry.message, 'stage')}:${lifecycleField(entry.message, 'event')}`))
      .toEqual([
        'identity:asset_ual_allocated',
        'wm:write',
        'swm_share:prepared',
        'storage_ack:request',
        'storage_ack:decline',
        'storage_ack:quorum',
        'storage_ack:failure',
      ]);

    const decline = scopedLogs.find((entry) => lifecycleField(entry.message, 'event') === 'decline');
    expect(decline?.message).toContain('peer=peer-decline-1');
    expect(decline?.message).toContain('outcome=decline');
    expect(decline?.message).toContain('reason=STORAGE_ACK_DECLINE:NO_DATA_IN_SWM');

    const quorum = scopedLogs.find((entry) => lifecycleField(entry.message, 'event') === 'quorum');
    expect(quorum?.message).toContain('outcome=failure');
    expect(quorum?.message).toContain('quorumCollected=0');
    expect(quorum?.message).toContain('quorumRequired=2');
    expect(quorum?.message).toContain('peerDialled=2');

    const failure = scopedLogs.find((entry) => lifecycleField(entry.message, 'event') === 'failure');
    expect(failure?.message).toContain('errorClass=QuorumUnmetError');
  });

  it('logs chain submit failure under the allocated assetUal', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.seedIdentity(wallet.address, 1n);
    chain.minimumRequiredSignatures = 1;
    const chainFailure = Object.assign(new Error('simulated-chain-revert'), {
      name: 'MockChainRevertError',
    });
    (chain as unknown as { createKnowledgeAssets: (...args: unknown[]) => Promise<never> }).createKnowledgeAssets =
      async () => {
        throw chainFailure;
      };
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

    await expect(publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      publisherPeerId: PUBLISHER_PEER_ID,
      quads: [
        q('urn:ka-log:chain-failure-root', 'http://schema.org/name', '"ChainFailureBot"'),
      ],
    })).rejects.toBe(chainFailure);

    const lifecycleLogs = logEntries.filter((entry) => entry.message.startsWith('ka_lifecycle '));
    const assetUal = lifecycleField(lifecycleLogs[0]!.message, 'assetUal');
    const scopedLogs = lifecycleLogs.filter((entry) => entry.message.includes(`assetUal=${assetUal}`));

    expect(scopedLogs.map((entry) => `${lifecycleField(entry.message, 'stage')}:${lifecycleField(entry.message, 'event')}`))
      .toEqual([
        'identity:asset_ual_allocated',
        'wm:write',
        'swm_share:prepared',
        'storage_ack:request',
        'storage_ack:success',
        'storage_ack:quorum',
        'chain:submit',
        'chain:failure',
      ]);

    const failure = scopedLogs.find((entry) => lifecycleField(entry.message, 'event') === 'failure');
    expect(failure?.level).toBe('error');
    expect(failure?.message).toContain('errorClass=MockChainRevertError');
    expect(failure?.message).toContain('reason=simulated-chain-revert');
  });
});
