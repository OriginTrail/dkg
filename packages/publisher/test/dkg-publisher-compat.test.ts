import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';

function q(s: string, p: string, o: string, graph = 'did:dkg:context-graph:test'): Quad {
  return {
    subject: s,
    predicate: p,
    object: o,
    graph,
  };
}

async function makePublisher(): Promise<DKGPublisher> {
  return new DKGPublisher({
    store: new OxigraphStore(),
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
}

describe('DKGPublisher compatibility aliases', () => {
  it('keeps autoPartition as a deprecated alias for skolemizeByEntity', async () => {
    const publisher = await makePublisher();
    const quads = [
      q('urn:compat:one', 'http://schema.org/name', '"One"'),
      q('urn:compat:two', 'http://schema.org/name', '"Two"'),
    ];

    expect(publisher.autoPartition(quads)).toEqual(publisher.skolemizeByEntity(quads));
  });

  it('rejects oversized RDF literals at shared-memory producer boundary', async () => {
    const publisher = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;

    await expect(
      publisher.share('test', [
        q('urn:compat:oversized', 'http://schema.org/text', oversized),
      ], { publisherPeerId: 'test-peer' }),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      actualBytes: 60_002,
    });
  });

  it('rejects oversized private literals before publish canonicalization', async () => {
    const publisher = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;

    await expect(
      publisher.publish({
        contextGraphId: 'test',
        publisherPeerId: 'test-peer',
        quads: [q('urn:compat:root', 'http://schema.org/name', '"ok"')],
        privateQuads: [q('urn:compat:root', 'http://schema.org/text', oversized)],
      }),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      actualBytes: 60_002,
    });
  });

  it('uses onChainContextGraphId as the direct publish chain domain without remap intent', async () => {
    const seenPublisherAddressCgIds: Array<bigint | undefined> = [];
    const signerAddress = '0x1111111111111111111111111111111111111111';
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherAddressResolver: async (cgId) => {
        seenPublisherAddressCgIds.push(cgId);
        return signerAddress;
      },
    });
    const internals = publisher as any;

    internals.publisherPlanner.refreshChainV10Readiness = async () => true;
    internals.getPublisherSigner = async () => ({ address: signerAddress, source: 'test' });
    internals.chain.getEvmChainId = async () => 31337n;
    internals.chain.getKnowledgeAssetsLifecycleAddress = async () => '0x2222222222222222222222222222222222222222';
    internals.chain.getRequiredPublishTokenAmount = async () => 1n;

    await expect(
      publisher.publish({
        contextGraphId: 'product-cg',
        onChainContextGraphId: '42',
        publisherPeerId: 'test-peer',
        quads: [
          q(
            'urn:compat:on-chain-binding',
            'http://schema.org/name',
            '"Binding"',
            'did:dkg:context-graph:product-cg',
          ),
        ],
      }),
    ).rejects.toThrow(/V10 ACKs required for on-chain publish/);

    expect(seenPublisherAddressCgIds[0]).toBe(42n);
  });
});
