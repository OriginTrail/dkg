import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';

describe('DKGPublisher Design B manifest compatibility', () => {
  it('publishes multi-root payloads as one tentative KA with per-root token IDs', async () => {
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const roots = ['urn:test:publisher-design-b:one', 'urn:test:publisher-design-b:two'];
    const quads: Quad[] = [
      { subject: roots[0], predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: roots[1], predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ];

    const result = await publisher.publish({ contextGraphId: 'publisher-design-b', quads });

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(new Set(result.kaManifest.map((m) => m.rootEntity))).toEqual(new Set(roots));
    expect(new Set(result.kaManifest.map((m) => String(m.tokenId)))).toEqual(new Set(['1', '2']));
  });
});
