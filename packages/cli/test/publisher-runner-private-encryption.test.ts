/**
 * GH #1121 / KoOvD — CLI runtime-boundary regression for the inline-encryption
 * callback precedence.
 *
 * The original failure mode was at THIS boundary (`publisher-runner.ts`'s
 * `publishExecutor`): the async-lift mapper pre-populates a fail-closed default
 * `encryptInlinePayload` for non-public CGs (so plaintext can never silently
 * ship), and the runner must let the REAL `publishEncryptionFactory` callback
 * win over that default — otherwise every private async publish would invoke the
 * throwing fail-closed default instead of encrypting.
 *
 * The publisher-level unit tests only assert the mapper's `resolved`-precedence;
 * they do NOT cover the runner's `?? publishOptions.encryptInlinePayload` merge.
 * This drives a real non-public (ownerOnly) async-lift publish end to end through
 * `createPublisherRuntimeFromAgent` and asserts that the callback `publisher.publish`
 * actually receives is the factory's closure — NOT the fail-closed mapper default.
 * Hermetic — NoChainAdapter, in-memory store, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { generateEd25519Keypair, TypedEventBus } from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  isFailClosedInlineEncrypt,
  type PublishOptions,
} from '@origintrail-official/dkg-publisher';
import { seedLegacyRawLiftTestJob } from '../../publisher/test/_helpers/legacy-raw-lift.js';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { addPublisherWallet } from '../src/publisher-wallets.js';
import { createPublisherRuntimeFromAgent } from '../src/publisher-runner.js';

describe('publisher runner — private (non-public) inline-encryption callback handoff', () => {
  it('passes the real publishEncryptionFactory callback to publisher.publish for an ownerOnly lift (not the fail-closed mapper default)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-priv-enc-'));
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
      {
        subject: 'urn:local:/rihana',
        predicate: 'http://schema.org/name',
        object: '"Rihana"',
        graph: '',
      },
    ], { publisherPeerId: 'peer-1' });

    // The agent-resolved, chainKey-bound AEAD closures. Stable references so the
    // assertion can prove THESE reached publish (vs. the throwing fail-closed default).
    const realInline = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array([...b, 0xee]);
    const realChunked = async (): Promise<{ ciphertextChunksRoot: Uint8Array; ciphertextChunkCount: number; totalCiphertextBytes: number }> => ({
      ciphertextChunksRoot: ethers.getBytes(ethers.id('priv-enc-chunk-root')),
      ciphertextChunkCount: 1,
      totalCiphertextBytes: 1,
    });

    // Capture what the runner's publishExecutor hands to publisher.publish, then
    // run the real publish (local finalization under NoChainAdapter).
    let captured: PublishOptions | undefined;
    const originalPublish = DKGPublisher.prototype.publish;
    const publishSpy = vi
      .spyOn(DKGPublisher.prototype, 'publish')
      .mockImplementation(async function (this: DKGPublisher, opts: PublishOptions) {
        captured ??= opts;
        return originalPublish.call(this, opts);
      });

    try {
      const runtime = await createPublisherRuntimeFromAgent({
        dataDir,
        store,
        keypair,
        chainBase: undefined,
        pollIntervalMs: 10,
        errorBackoffMs: 10,
        publishEncryptionFactory: () => ({
          encryptInlinePayload: realInline,
          encryptInlineChunked: realChunked,
        }),
      });

      const jobId = await seedLegacyRawLiftTestJob(store, {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: ['urn:local:/rihana'],
        contextGraphId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
        // The crux: a NON-public publish — the mapper pre-populates the fail-closed
        // default, and the runner must override it with the real factory callback.
        accessPolicy: 'ownerOnly',
      });

      const processed = await runtime.publisher.processNext(wallet.address);
      expect(processed?.jobId).toBe(jobId);

      // The runner forwarded the lift's non-public access policy through.
      expect(captured?.accessPolicy).toBe('ownerOnly');
      // publisher.publish received the REAL factory callbacks, by reference …
      expect(captured?.encryptInlinePayload).toBe(realInline);
      expect(captured?.encryptInlineChunked).toBe(realChunked);
      // … and explicitly NOT the throwing fail-closed mapper default.
      expect(isFailClosedInlineEncrypt(captured?.encryptInlinePayload)).toBe(false);

      await runtime.stop();
    } finally {
      publishSpy.mockRestore();
      await store.close();
    }
  });
});
