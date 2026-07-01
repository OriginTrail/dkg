/**
 * #1404 (🔴 runner-path coverage): `publisher-runner-ack-readiness.test.ts` proves
 * `createV10ACKProviderForPublisher` routes through the centralized production ACK
 * factory, but NOT that the RUNNER actually calls that helper. This drives a REAL
 * publish job through the async publisher runtime and asserts the executor reaches
 * the helper — with the publisher and the transport from `ackTransportFactory`. A
 * regression that stopped routing through the helper at the runner call site (or
 * dropped `ackTransportFactory`) leaves `helperCalls` empty → red.
 *
 * Uses `chainBase: undefined` (NoChainAdapter): the executor calls the helper
 * regardless of V10-readiness (the helper self-guards and returns undefined), so
 * the runner→helper wiring is exercised without a live chain.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { generateEd25519Keypair, TypedEventBus } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { addPublisherWallet } from '../src/publisher-wallets.js';

const helperCalls: Array<{ hasPublisher: boolean; transport: unknown }> = [];

vi.mock('../src/ack-provider.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    createV10ACKProviderForPublisher: (publisher: unknown, transport: unknown) => {
      helperCalls.push({ hasPublisher: !!publisher, transport });
      return undefined; // NoChainAdapter → no provider; publish proceeds non-V10
    },
  };
});

const { createPublisherRuntimeFromAgent } = await import('../src/publisher-runner.js');

describe('CLI publisher runner — routes ACK-provider construction through the helper (#1404)', () => {
  it('the async publish executor calls createV10ACKProviderForPublisher with the publisher + the ackTransportFactory transport', async () => {
    helperCalls.length = 0;
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-ack-wiring-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    await addPublisherWallet(dataDir, wallet.privateKey);

    const writer = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
    });
    const write = await writer.writeToWorkspace('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    const transport = {
      publisherPeerId: 'peer-runner',
      gossipPublish: async () => undefined,
      sendP2P: async () => new Uint8Array(),
      getConnectedCorePeers: () => ['core-a'],
      log: () => undefined,
    };
    const runtime = await createPublisherRuntimeFromAgent({
      dataDir,
      store,
      keypair,
      chainBase: undefined,
      pollIntervalMs: 10,
      errorBackoffMs: 10,
      // Minimal encryption factory (mirrors the lu11 runtime test) so the job
      // processes cleanly and the executor reaches the ACK-provider resolution.
      publishEncryptionFactory: () => ({
        encryptInlinePayload: async () => new Uint8Array([0x01]),
      }),
      ackTransportFactory: () => transport,
    });

    const jobId = await runtime.publisher.lift({
      swmId: 'swm-main',
      shareOperationId: write.shareOperationId,
      roots: ['urn:local:/rihana'],
      contextGraphId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    });
    const processed = await runtime.publisher.processNext(wallet.address);
    expect(processed?.jobId).toBe(jobId);

    // The runner reached the helper — with the real publisher and the exact
    // transport instance produced by ackTransportFactory.
    expect(helperCalls).toHaveLength(1);
    expect(helperCalls[0].hasPublisher).toBe(true);
    expect(helperCalls[0].transport).toBe(transport);

    await runtime.stop();
    await store.close();
  });
});
