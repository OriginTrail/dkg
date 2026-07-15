import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { generateEd25519Keypair, TypedEventBus } from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  type PublishOptions,
} from '@origintrail-official/dkg-publisher';
import { seedLegacyRawLiftTestJob } from '../../publisher/test/_helpers/legacy-raw-lift.js';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { addPublisherWallet } from '../src/publisher-wallets.js';
import { createPublisherRuntimeFromAgent } from '../src/publisher-runner.js';

describe('publisher runner LU-11 runtime wiring', () => {
  it('injects runtime-only chunked encryption callbacks into async lift publishes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-lu11-'));
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

    let factoryInput: PublishOptions | undefined;
    let chunkedInput:
      | { plaintextNquads: Uint8Array; batchId: Uint8Array; publishOperationId: string }
      | undefined;

    const runtime = await createPublisherRuntimeFromAgent({
      dataDir,
      store,
      keypair,
      chainBase: undefined,
      pollIntervalMs: 10,
      errorBackoffMs: 10,
      publishEncryptionFactory: (publishOptions) => {
        factoryInput = publishOptions;
        return {
          encryptInlinePayload: async () => new Uint8Array([0x01]),
          encryptInlineChunked: async (input) => {
            chunkedInput = input;
            return {
              ciphertextChunksRoot: ethers.getBytes(ethers.id('async-lu11-chunk-root')),
              ciphertextChunkCount: 1,
              totalCiphertextBytes: 1,
            };
          },
        };
      },
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
    });

    const processed = await runtime.publisher.processNext(wallet.address);

    expect(processed?.jobId).toBe(jobId);
    expect(factoryInput?.contextGraphId).toBe('music-social');
    expect(chunkedInput?.batchId).toHaveLength(32);
    expect(chunkedInput?.publishOperationId).toBeTruthy();

    await runtime.stop();
    await store.close();
  });
});
