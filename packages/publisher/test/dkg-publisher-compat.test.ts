import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_HAS_TEXT_CHUNK,
  TypedEventBus,
  javaModifiedUtf8Length,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';

function q(s: string, p: string, o: string): Quad {
  return {
    subject: s,
    predicate: p,
    object: o,
    graph: 'did:dkg:context-graph:test',
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

  it('rewrites oversized schema:text literals before storing a direct publish', async () => {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const root = 'urn:compat:computer-history';
    const body = 'computer history '.repeat(5_000);

    await publisher.publish({
      contextGraphId: 'test',
      quads: [q(root, 'http://schema.org/text', JSON.stringify(body))],
    });

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <did:dkg:context-graph:test> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;

    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/text' &&
      quad.object === JSON.stringify(body),
    )).toBe(false);

    const chunkSubjects = result.quads
      .filter((quad) => quad.predicate === DKG_HAS_TEXT_CHUNK)
      .map((quad) => quad.object);
    expect(chunkSubjects.length).toBeGreaterThan(1);

    const chunkTextQuads = result.quads.filter((quad) =>
      chunkSubjects.includes(quad.subject) &&
      quad.predicate === 'http://schema.org/text'
    );
    expect(chunkTextQuads).toHaveLength(chunkSubjects.length);
    expect(chunkTextQuads.every((quad) => javaModifiedUtf8Length(quad.object) <= 60_000)).toBe(true);
  });
});
