/**
 * The chain adapter replaces a stuck publish/update transaction at its own nonce only for a caller
 * that passes `onBeforeReplacementBroadcast`. `DKGPublisher` passes it only when no durable
 * `onBeforeBroadcast` is attached: that record (the async publisher's) holds one hash per
 * transaction and its recovery recognizes no other, so a replacement mined in its place would leave
 * the job holding its wallet. A synchronous publish has no such record and takes whichever hash is
 * mined.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  type OnChainPublishResult,
  type ReplacementBroadcastSignal,
  type TxResult,
  type V10PublishParams,
  type V10UpdateKAParams,
} from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { buildUpdateSeal, mockSealCtx, withSeal } from './_helpers/seal.js';

const PRODUCER = new ethers.Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const AUTHOR = PRODUCER.address;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const CG_ID = '42';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const REPLACEMENT_HASH = `0x${'cd'.repeat(32)}`;
const NONCE = 6722;
const REPLACEMENT: ReplacementBroadcastSignal = { txHash: REPLACEMENT_HASH, nonce: NONCE, replacesTxHashes: [TX_HASH] };

/** Records which replacement hook each write offered, and plays a replacement through it. */
class ReplacementRecordingChain extends MockChainAdapter {
  readonly offered: Array<{ write: 'create' | 'update'; hook: V10PublishParams['onBeforeReplacementBroadcast'] }> = [];

  constructor() {
    super('mock:31337', AUTHOR);
    this.minimumRequiredSignatures = 0;
  }

  override async getKnowledgeAssetOwner(kaId: bigint): Promise<string> {
    if (kaId === KA_ID) return ethers.getAddress(AUTHOR);
    return super.getKnowledgeAssetOwner(kaId);
  }

  override async createKnowledgeAssets(params: V10PublishParams): Promise<OnChainPublishResult> {
    await params.onBroadcast?.({ txHash: TX_HASH, nonce: NONCE });
    this.offered.push({ write: 'create', hook: params.onBeforeReplacementBroadcast });
    await params.onBeforeReplacementBroadcast?.(REPLACEMENT);
    return super.createKnowledgeAssets(params);
  }

  override async updateKnowledgeCollectionV10(params: V10UpdateKAParams): Promise<TxResult> {
    await params.onBroadcast?.({ txHash: TX_HASH, nonce: NONCE });
    this.offered.push({ write: 'update', hook: params.onBeforeReplacementBroadcast });
    await params.onBeforeReplacementBroadcast?.(REPLACEMENT);
    return { success: true, hash: REPLACEMENT_HASH, blockNumber: 1 } as TxResult;
  }
}

async function publisherOver(chain: ReplacementRecordingChain): Promise<DKGPublisher> {
  return new DKGPublisher({
    store: new OxigraphStore(),
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherPrivateKey: PRODUCER.privateKey,
    publisherNodeIdentityId: 1n,
  });
}

async function publishArgs() {
  return withSeal({
    contextGraphId: CG_ID,
    quads: [
      { subject: 'urn:atomic', predicate: 'http://schema.org/name', object: '"v1"', graph: '' },
    ] as Quad[],
    publisherPeerId: 'peer-1',
    v10ACKProvider: async () => [{
      peerId: 'peer-core-1',
      signatureR: new Uint8Array(32),
      signatureVS: new Uint8Array(32),
      nodeIdentityId: 1n,
    }],
  }, PRODUCER, mockSealCtx());
}

async function updateArgs() {
  const quads: Quad[] = [
    { subject: 'urn:atomic', predicate: 'http://schema.org/name', object: '"v2"', graph: `did:dkg:context-graph:${CG_ID}` },
  ];
  return {
    contextGraphId: CG_ID,
    quads,
    precomputedUpdateAttestation: await buildUpdateSeal({ kaId: KA_ID, quads, author: PRODUCER, ctx: mockSealCtx() }),
  };
}

function replacedPhases(phases: Array<[string, string]>): Array<[string, string]> {
  return phases.filter(([phase]) => phase.startsWith('chain:txreplaced:'));
}

describe('DKGPublisher stuck-transaction speed-up opt-in', () => {
  it('lets the chain replace a synchronous publish, leaving the replacement hash as a breadcrumb', async () => {
    const chain = new ReplacementRecordingChain();
    const publisher = await publisherOver(chain);
    const phases: Array<[string, string]> = [];

    const result = await publisher.publish({
      ...(await publishArgs()),
      onPhase: (phase, status) => { phases.push([phase, status]); },
    });

    expect(result.status).not.toBe('failed');
    expect(chain.offered).toHaveLength(1);
    expect(chain.offered[0].hook).toBeTypeOf('function');
    expect(replacedPhases(phases)).toEqual([
      [`chain:txreplaced:tx-${REPLACEMENT_HASH}`, 'start'],
      [`chain:txreplaced:tx-${REPLACEMENT_HASH}`, 'end'],
    ]);
  });

  it('lets the chain replace a synchronous update', async () => {
    const chain = new ReplacementRecordingChain();
    const publisher = await publisherOver(chain);
    const phases: Array<[string, string]> = [];

    await publisher.update(KA_ID, {
      ...(await updateArgs()),
      onPhase: (phase, status) => { phases.push([phase, status]); },
    });

    expect(chain.offered.map(({ write, hook }) => [write, typeof hook])).toEqual([['update', 'function']]);
    expect(replacedPhases(phases)).toHaveLength(2);
  });

  it('never lets the chain replace a write whose durable record holds one hash', async () => {
    const chain = new ReplacementRecordingChain();
    const publisher = await publisherOver(chain);
    const phases: Array<[string, string]> = [];
    const recorded: string[] = [];

    const result = await publisher.publish({
      ...(await publishArgs()),
      onBeforeBroadcast: (record) => { recorded.push(record.txHash); },
      onPhase: (phase, status) => { phases.push([phase, status]); },
    });
    await publisher.update(KA_ID, {
      ...(await updateArgs()),
      onBeforeBroadcast: (record) => { recorded.push(record.txHash); },
    });

    expect(result.status).not.toBe('failed');
    expect(recorded).toEqual([TX_HASH, TX_HASH]);
    expect(chain.offered.map(({ write, hook }) => [write, hook])).toEqual([
      ['create', undefined],
      ['update', undefined],
    ]);
    expect(replacedPhases(phases)).toEqual([]);
  });
});
