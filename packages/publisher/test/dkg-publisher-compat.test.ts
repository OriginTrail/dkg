import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  TypedEventBus,
  generateEd25519Keypair,
  reconstructChunkedTextBodies,
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

async function makePublisher(): Promise<{ publisher: DKGPublisher; store: OxigraphStore }> {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return { publisher, store };
}

describe('DKGPublisher compatibility aliases', () => {
  it('keeps autoPartition as a deprecated alias for skolemizeByEntity', async () => {
    const { publisher } = await makePublisher();
    const quads = [
      q('urn:compat:one', 'http://schema.org/name', '"One"'),
      q('urn:compat:two', 'http://schema.org/name', '"Two"'),
    ];

    expect(publisher.autoPartition(quads)).toEqual(publisher.skolemizeByEntity(quads));
  });

  it('chunks oversized schema:text literals at shared-memory producer boundary', async () => {
    const { publisher, store } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;
    const root = 'urn:compat:oversized';

    await publisher.share('test', [
      q(root, 'http://schema.org/text', oversized),
    ], { publisherPeerId: 'test-peer', localOnly: true });

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <did:dkg:context-graph:test/_shared_memory> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === DKG_HAS_TEXT_BODY
    )).toBe(true);
    expect(result.quads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);

    const reconstructed = reconstructChunkedTextBodies(result.quads, { subject: root });
    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0].lexical).toBe('x'.repeat(60_000));
  });

  it('rejects oversized non-text RDF literals at shared-memory producer boundary', async () => {
    const { publisher } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;

    await expect(
      publisher.share('test', [
        q('urn:compat:oversized-name', 'http://schema.org/name', oversized),
      ], { publisherPeerId: 'test-peer' }),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      actualBytes: 60_002,
      predicate: 'http://schema.org/name',
    });
  });

  it('keeps reserved-subject failures ahead of large-text chunking', async () => {
    const { publisher } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;

    await expect(
      publisher.share('test', [
        q('urn:dkg:file:reserved', 'http://schema.org/text', oversized),
      ], { publisherPeerId: 'test-peer' }),
    ).rejects.toThrow(/reserved namespace/i);
  });

  it('rejects oversized conditional-write expected values instead of chunking conditions', async () => {
    const { publisher } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;

    await expect(
      publisher.conditionalShare('test', [
        q('urn:compat:cas', 'http://schema.org/name', '"CAS"'),
      ], {
        publisherPeerId: 'test-peer',
        conditions: [{
          subject: 'urn:compat:cas',
          predicate: 'http://schema.org/text',
          expectedValue: oversized,
        }],
      }),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      predicate: 'http://schema.org/text',
    });
  });

  it('chunks oversized schema:text literals during direct publish', async () => {
    const { publisher, store } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;
    const root = 'urn:compat:publish-oversized';

    await publisher.publish({
      contextGraphId: 'test',
      publisherPeerId: 'test-peer',
      quads: [q(root, 'http://schema.org/text', oversized)],
      skipContextGraphEnsure: true,
    });

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <did:dkg:context-graph:test> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(reconstructChunkedTextBodies(result.quads, { subject: root })[0].lexical).toBe('x'.repeat(60_000));
  });

  it('chunks oversized schema:text literals during assertion write', async () => {
    const { publisher } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;
    const root = 'urn:compat:assertion-oversized';
    const agent = '0x1234567890abcdef1234567890abcdef12345678';

    await publisher.assertionCreate('test', 'large-text', agent);
    await publisher.assertionWrite('test', 'large-text', agent, [
      q(root, 'http://schema.org/text', oversized),
    ]);

    const quads = await publisher.assertionQuery('test', 'large-text', agent);
    expect(quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(reconstructChunkedTextBodies(quads, { subject: root })[0].lexical).toBe('x'.repeat(60_000));
  });

  it('rejects oversized private literals before publish canonicalization', async () => {
    const { publisher } = await makePublisher();
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
});
