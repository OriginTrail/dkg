/**
 * GH#2270 PR-3 r2 — `DKGPublisher` must AWAIT `onBeforeBroadcast` before the transaction is sent.
 *
 * The recovery lane's whole safety argument is that the write-ahead is durable before anything can
 * be on the wire. The adapter awaits its `onBroadcast` hook, and its own row pins that — but the
 * publisher sits between the two, and if it merely fires the callback and moves on, the hook the
 * adapter awaits resolves immediately and the guarantee is gone with no visible symptom: the happy
 * path still passes, the record still usually lands, and only a crash in the widened window loses
 * a transaction.
 *
 * These drive the REAL publisher over a mock chain that reports when the send actually happened,
 * because that ordering is the only observable that distinguishes an awaited callback from a
 * fired-and-forgotten one.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  type PreBroadcastSignal,
  type OnChainPublishResult,
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
const DATA_GRAPH = `did:dkg:context-graph:${CG_ID}`;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const NONCE = 19;

/**
 * A chain that fires the pre-broadcast hook with a known signal and records whether the "send"
 * happened afterwards. `sent` is the observable: it can only be false after the hook threw if the
 * publisher actually awaited it.
 */
class SignalRecordingChain extends MockChainAdapter {
  sent = false;
  hookSettled = false;

  constructor() {
    super('mock:31337', AUTHOR);
  }

  override async getKnowledgeAssetOwner(kaId: bigint): Promise<string> {
    if (kaId === KA_ID) return ethers.getAddress(AUTHOR);
    return super.getKnowledgeAssetOwner(kaId);
  }

  override async updateKnowledgeCollectionV10(params: V10UpdateKAParams): Promise<TxResult> {
    await params.onBroadcast?.({ txHash: TX_HASH, nonce: NONCE });
    await params.onBroadcastAccepted?.({ txHash: TX_HASH, nonce: NONCE });
    this.hookSettled = true;
    this.sent = true;
    return { success: true, hash: TX_HASH, blockNumber: 1 } as TxResult;
  }
}

async function publisherOver(chain: SignalRecordingChain): Promise<{
  publisher: DKGPublisher;
  quads: Quad[];
  precomputedUpdateAttestation: Awaited<ReturnType<typeof buildUpdateSeal>>;
}> {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherPrivateKey: PRODUCER.privateKey,
    publisherNodeIdentityId: 1n,
  });
  const quads: Quad[] = [
    { subject: 'urn:atomic', predicate: 'http://schema.org/name', object: '"v2"', graph: DATA_GRAPH },
  ];
  const precomputedUpdateAttestation = await buildUpdateSeal({
    kaId: KA_ID,
    quads,
    author: PRODUCER,
    ctx: mockSealCtx(),
  });
  return { publisher, quads, precomputedUpdateAttestation };
}

describe('DKGPublisher awaits the pre-broadcast signal [GH#2270]', () => {
  it('forwards RPC acceptance for an update with its operation kind', async () => {
    const chain = new SignalRecordingChain();
    const { publisher, quads, precomputedUpdateAttestation } = await publisherOver(chain);
    const received: PreBroadcastSignal[] = [];

    await publisher.update(KA_ID, {
      contextGraphId: CG_ID,
      quads,
      precomputedUpdateAttestation,
      onBroadcastAccepted: (signal) => { received.push(signal); },
    });

    expect(received).toEqual([{ txHash: TX_HASH, nonce: NONCE, operationKind: 'update' }]);
  });

  it('delivers the adapter signal verbatim, before the send', async () => {
    const chain = new SignalRecordingChain();
    const { publisher, quads, precomputedUpdateAttestation } = await publisherOver(chain);
    const received: PreBroadcastSignal[] = [];
    let sentWhenSignalled = true;

    await publisher.update(KA_ID, {
      contextGraphId: CG_ID,
      quads,
      precomputedUpdateAttestation,
      onBeforeBroadcast: (signal) => {
        received.push(signal);
        sentWhenSignalled = chain.sent;
      },
    });

    expect(received).toEqual([{ txHash: TX_HASH, nonce: NONCE, operationKind: 'update' }]);
    // The signal arrived while the transaction was still unsent — that is what "write-ahead" means.
    expect(sentWhenSignalled).toBe(false);
    expect(chain.sent).toBe(true);
  });

  it('does not send when the signal handler REJECTS', async () => {
    // The mutation this row exists for: dropping the `await` turns the rejection into an unhandled
    // one and the publish sails past it, so `sent` flips to true and the transaction goes out with
    // nothing durable recording it.
    const chain = new SignalRecordingChain();
    const { publisher, quads, precomputedUpdateAttestation } = await publisherOver(chain);

    // This mock invokes the hook directly, so the rejection escapes as a throw; the real EVM
    // adapter rewraps it as `chain:writeahead hook failed before ... broadcast`. Either way the
    // load-bearing assertion is the same one: nothing was sent.
    await expect(publisher.update(KA_ID, {
      contextGraphId: CG_ID,
      quads,
      precomputedUpdateAttestation,
      onBeforeBroadcast: async () => {
        await Promise.resolve();
        throw new Error('could not persist the write-ahead');
      },
    })).rejects.toThrow(/could not persist the write-ahead/);

    expect(chain.sent).toBe(false);
  });

  it('runs no fallible instrumentation between the durable record and the send', async () => {
    // GH#2270 PR-3 r4 — the UPDATE-branch mirror of the publish-path row below. Both signing
    // paths now consume the ONE `createWriteAheadHook`, and this row is what fails if the update
    // branch ever regrows its own copy with the durable callback ahead of the phases: a rejecting
    // `onPhase` listener must abort the broadcast with NEITHER the durable record written NOR the
    // send attempted, so the record and the wire always agree.
    const chain = new SignalRecordingChain();
    const { publisher, quads, precomputedUpdateAttestation } = await publisherOver(chain);
    let recorded = false;

    await publisher.update(KA_ID, {
      contextGraphId: CG_ID,
      quads,
      precomputedUpdateAttestation,
      onBeforeBroadcast: () => { recorded = true; },
      onPhase: (phase, status) => {
        // PR #2300 r3 (3811569451) — reject on the LAST fallible phase before the durable
        // boundary, not on the first hash-bearing one. Throwing at `chain:txsigned:` aborted so
        // early that the row passed under ANY ordering, including the unsafe one this claims to
        // forbid (durable callback moved ahead of `chain:writeahead:start`). Letting the hash
        // phases through and rejecting exactly here is what makes the row discriminate.
        if (phase === 'chain:writeahead' && status === 'start') throw new Error('a listener blew up');
      },
    }).catch(() => undefined);

    // Neither happened: the throw came before anything durable was written.
    expect(recorded).toBe(false);
    expect(chain.sent).toBe(false);
    // The load-bearing invariant, stated as the pair that must never disagree.
    expect(recorded).toBe(chain.sent);
  });

  it('does not send when the handler is still in flight', async () => {
    // A handler that never settles must block the send outright rather than let it race ahead.
    const chain = new SignalRecordingChain();
    const { publisher, quads, precomputedUpdateAttestation } = await publisherOver(chain);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const running = publisher.update(KA_ID, {
      contextGraphId: CG_ID,
      quads,
      precomputedUpdateAttestation,
      onBeforeBroadcast: () => gate,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chain.sent).toBe(false);

    release();
    await running;
    expect(chain.sent).toBe(true);
  });
});

/**
 * The PUBLISH bridge, not the update one. Both signing paths carry the same write-ahead ordering,
 * and until now only `update` was covered — a regression on the publish side would have shipped
 * green.
 */
class PublishSignalRecordingChain extends MockChainAdapter {
  sent = false;

  constructor() {
    super('mock:31337', AUTHOR);
  }

  override async createKnowledgeAssets(params: V10PublishParams): Promise<OnChainPublishResult> {
    await params.onBroadcast?.({ txHash: TX_HASH, nonce: NONCE });
    await params.onBroadcastAccepted?.({ txHash: TX_HASH, nonce: NONCE });
    this.sent = true;
    return super.createKnowledgeAssets(params);
  }
}

async function publishOver(chain: PublishSignalRecordingChain): Promise<DKGPublisher> {
  const store = new OxigraphStore();
  chain.minimumRequiredSignatures = 0;
  return new DKGPublisher({
    store,
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
    // The publisher refuses an on-chain publish with no ACKs collected, and the mock accepts any
    // signature (minimumRequiredSignatures = 0). One stub ACK is what carries the publish far
    // enough to reach the chain at all — the POSITIVE CONTROL row below is what proves it does.
    v10ACKProvider: async () => [{
      peerId: 'peer-core-1',
      signatureR: new Uint8Array(32),
      signatureVS: new Uint8Array(32),
      nodeIdentityId: 1n,
    }],
  }, PRODUCER, mockSealCtx());
}

describe('DKGPublisher.publish awaits the pre-broadcast signal [GH#2270]', () => {
  it('forwards RPC acceptance for a create with its operation kind', async () => {
    const chain = new PublishSignalRecordingChain();
    const publisher = await publishOver(chain);
    const received: PreBroadcastSignal[] = [];

    await publisher.publish({
      ...(await publishArgs()),
      onBroadcastAccepted: (signal) => { received.push(signal); },
    });

    expect(received).toEqual([{ txHash: TX_HASH, nonce: NONCE, operationKind: 'create' }]);
  });

  it('fires onPublishConfirmed once with the receipt hash the chain returned [GH#2359]', async () => {
    // The receipt-confirmed scheduling hint: exactly one firing, carrying the on-chain
    // result's transaction hash — the hash a reconciler must validate against persisted
    // write-ahead evidence before proving the transaction itself.
    const chain = new PublishSignalRecordingChain();
    const publisher = await publishOver(chain);
    const confirmations: Array<{ txHash: string }> = [];

    const result = await publisher.publish({
      ...(await publishArgs()),
      onPublishConfirmed: (confirmation) => { confirmations.push(confirmation); },
    });

    expect(result.status).not.toBe('failed');
    expect(confirmations).toEqual([{ txHash: result.onChainResult?.txHash }]);
  });

  it('a throwing onPublishConfirmed listener does not fail the publish [GH#2359]', async () => {
    // Scheduling-only and non-fail-closed: by the time the hint fires the transaction is
    // already mined — a listener failure must never surface into the publish outcome.
    const chain = new PublishSignalRecordingChain();
    const publisher = await publishOver(chain);

    const result = await publisher.publish({
      ...(await publishArgs()),
      onPublishConfirmed: () => { throw new Error('listener exploded'); },
    });

    expect(result.status).not.toBe('failed');
    expect(chain.sent).toBe(true);
  });

  it('POSITIVE CONTROL: a plain publish reaches the chain and fires the signal', async () => {
    // Without this, every row below could pass vacuously by never reaching the adapter at all.
    const chain = new PublishSignalRecordingChain();
    const publisher = await publishOver(chain);
    const received: PreBroadcastSignal[] = [];

    const result = await publisher.publish({ ...(await publishArgs()), onBeforeBroadcast: (sig) => { received.push(sig); } });

    expect(result.status).not.toBe('failed');
    expect(chain.sent).toBe(true);
    expect(received).toEqual([{ txHash: TX_HASH, nonce: NONCE, operationKind: 'create' }]);
  });

  it('does not send when the signal handler is still in flight', async () => {
    const chain = new PublishSignalRecordingChain();
    const publisher = await publishOver(chain);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const running = publisher.publish({
      ...(await publishArgs()),
      onBeforeBroadcast: () => gate,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chain.sent).toBe(false);

    release();
    await running;
    expect(chain.sent).toBe(true);
  });

  it('does not send when the signal handler REJECTS', async () => {
    const chain = new PublishSignalRecordingChain();
    const publisher = await publishOver(chain);

    await publisher.publish({
      ...(await publishArgs()),
      onBeforeBroadcast: async () => {
        await Promise.resolve();
        throw new Error('could not persist the write-ahead');
      },
    }).catch(() => undefined);

    expect(chain.sent).toBe(false);
  });

  it('runs no fallible instrumentation between the durable record and the send', async () => {
    // The ordering hole. `onPhase` is caller-supplied and awaited, so a rejecting listener aborts
    // the broadcast. When the durable callback ran FIRST, that abort left a persisted 'broadcast'
    // for a transaction that was never sent — the exact phantom the write-ahead exists to prevent,
    // reintroduced by instrumentation. The record and the send must agree.
    const chain = new PublishSignalRecordingChain();
    const publisher = await publishOver(chain);
    let recorded = false;

    await publisher.publish({
      ...(await publishArgs()),
      onBeforeBroadcast: () => { recorded = true; },
      onPhase: (phase, status) => {
        // PR #2300 r3 (3811569451) — reject on the LAST fallible phase before the durable
        // boundary, not on the first hash-bearing one. Throwing at `chain:txsigned:` aborted so
        // early that the row passed under ANY ordering, including the unsafe one this claims to
        // forbid (durable callback moved ahead of `chain:writeahead:start`). Letting the hash
        // phases through and rejecting exactly here is what makes the row discriminate.
        if (phase === 'chain:writeahead' && status === 'start') throw new Error('a listener blew up');
      },
    }).catch(() => undefined);

    // Neither happened: the throw came before anything durable was written.
    expect(recorded).toBe(false);
    expect(chain.sent).toBe(false);
    // The load-bearing invariant, stated as the pair that must never disagree.
    expect(recorded).toBe(chain.sent);
  });
});
