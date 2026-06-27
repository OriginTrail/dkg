import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  TypedEventBus,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { reconstructChunkedText } from '../../core/test/helpers/chunked-text.js';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { skolemizeByEntity } from '../src/auto-partition.js';
import { preparePublicWriteQuads } from '../src/public-write-normalization.js';

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

    expect(reconstructChunkedText(result.quads, root)).toBe('x'.repeat(60_000));
  });

  it('chunks oversized schema:text literals on linked blank nodes before shared-memory writes', async () => {
    const { publisher, store } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;
    const root = 'urn:compat:share-blank-root';
    const child = `${root}/.well-known/genid/body`;

    await publisher.share('test', [
      q(root, 'http://schema.org/hasPart', '_:body'),
      q('_:body', 'http://schema.org/text', oversized),
    ], { publisherPeerId: 'test-peer', localOnly: true });

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <did:dkg:context-graph:test/_shared_memory> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.some((quad) =>
      quad.subject === child &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/hasPart' &&
      quad.object === child
    )).toBe(true);
    expect(reconstructChunkedText(result.quads, child)).toBe('x'.repeat(60_000));
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

  it('chunks oversized schema:text literals during conditionalShare writes', async () => {
    const { publisher, store } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;
    const root = 'urn:compat:cas-chunked';

    await publisher.conditionalShare('test', [
      q(root, 'http://schema.org/text', oversized),
    ], {
      publisherPeerId: 'test-peer',
      localOnly: true,
      conditions: [{
        subject: root,
        predicate: 'http://schema.org/name',
        expectedValue: null,
      }],
    });

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <did:dkg:context-graph:test/_shared_memory> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(result.quads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
    expect(reconstructChunkedText(result.quads, root)).toBe('x'.repeat(60_000));
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
    expect(reconstructChunkedText(result.quads, root)).toBe('x'.repeat(60_000));
  });

  it('chunks oversized schema:text literals on linked blank nodes during direct publish', async () => {
    const { publisher, store } = await makePublisher();
    const oversized = `"${'x'.repeat(60_000)}"`;
    const root = 'urn:compat:publish-blank-root';
    const child = `${root}/.well-known/genid/body`;

    await publisher.publish({
      contextGraphId: 'test',
      publisherPeerId: 'test-peer',
      quads: [
        q(root, 'http://schema.org/hasPart', '_:body'),
        q('_:body', 'http://schema.org/text', oversized),
      ],
      skipContextGraphEnsure: true,
    });

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <did:dkg:context-graph:test> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.some((quad) =>
      quad.subject === child &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/hasPart' &&
      quad.object === child
    )).toBe(true);
    expect(reconstructChunkedText(result.quads, child)).toBe('x'.repeat(60_000));
  });

  it('chunks oversized schema:text literals during update', async () => {
    const { publisher, store } = await makePublisher();
    const root = 'urn:compat:update-oversized';
    const original = await publisher.publish({
      contextGraphId: 'test',
      publisherPeerId: 'test-peer',
      quads: [q(root, 'http://schema.org/name', '"Before"')],
      skipContextGraphEnsure: true,
    });

    await publisher.update(original.kaId, {
      contextGraphId: 'test',
      publisherPeerId: 'test-peer',
      quads: [q(root, 'http://schema.org/text', `"${'x'.repeat(60_000)}"`)],
      skipContextGraphEnsure: true,
    });

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(reconstructChunkedText(result.quads, root)).toBe('x'.repeat(60_000));
  });

  it('chunks oversized schema:text literals on linked blank nodes during update', async () => {
    const { publisher, store } = await makePublisher();
    const root = 'urn:compat:update-blank-root';
    const child = `${root}/.well-known/genid/body`;
    const original = await publisher.publish({
      contextGraphId: 'test',
      publisherPeerId: 'test-peer',
      quads: [q(root, 'http://schema.org/name', '"Before"')],
      skipContextGraphEnsure: true,
    });

    await publisher.update(original.kaId, {
      contextGraphId: 'test',
      publisherPeerId: 'test-peer',
      quads: [
        q(root, 'http://schema.org/hasPart', '_:body'),
        q('_:body', 'http://schema.org/text', `"${'x'.repeat(60_000)}"`),
      ],
      skipContextGraphEnsure: true,
    });

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.some((quad) =>
      quad.subject === child &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(result.quads.some((quad) =>
      quad.subject === root &&
      quad.predicate === 'http://schema.org/hasPart' &&
      quad.object === child
    )).toBe(true);
    expect(reconstructChunkedText(result.quads, child)).toBe('x'.repeat(60_000));
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
    expect(reconstructChunkedText(quads, root)).toBe('x'.repeat(60_000));
  });

  it('preserves already-skolemized quads when normal roots are present', () => {
    const externalSkolemized = q(
      'http://example.org/external/.well-known/genid/body',
      'http://schema.org/name',
      '"kept"',
    );

    const prepared = preparePublicWriteQuads([
      q('http://example.org/root', 'http://schema.org/name', '"root"'),
      externalSkolemized,
    ]).quads;

    expect(prepared).toContainEqual(externalSkolemized);
    expect(prepared).toHaveLength(2);
  });

  it('uses a blank node inferred root when skolemizing shared blank-node object links', () => {
    const rootA = 'http://example.org/root-a';
    const rootB = 'http://example.org/root-b';
    const shared = `${rootA}/.well-known/genid/shared`;
    const wrongShared = `${rootB}/.well-known/genid/shared`;

    const prepared = preparePublicWriteQuads([
      q(rootA, 'http://schema.org/hasPart', '_:shared'),
      q(rootB, 'http://schema.org/hasPart', '_:shared'),
      q('_:shared', 'http://schema.org/name', '"Shared"'),
    ]).quads;

    expect(prepared).toContainEqual({
      ...q(rootA, 'http://schema.org/hasPart', '_:shared'),
      object: shared,
    });
    expect(prepared).toContainEqual({
      ...q(rootB, 'http://schema.org/hasPart', '_:shared'),
      object: shared,
    });
    expect(prepared).toContainEqual({
      ...q('_:shared', 'http://schema.org/name', '"Shared"'),
      subject: shared,
    });
    expect(prepared.some((quad) =>
      quad.subject === wrongShared || quad.object === wrongShared
    )).toBe(false);
  });

  it('indexes already-skolemized subjects even when their root subject is absent', () => {
    const root = 'http://example.org/external';
    const externalSkolemized = q(
      `${root}/.well-known/genid/body`,
      'http://schema.org/hasPart',
      '_:nested',
    );

    const partitioned = skolemizeByEntity([
      q('http://example.org/root', 'http://schema.org/name', '"root"'),
      externalSkolemized,
      q('_:nested', 'http://schema.org/name', '"kept"'),
    ]);

    expect(partitioned.get(root)).toContainEqual({
      ...externalSkolemized,
      object: `${root}/.well-known/genid/nested`,
    });
    expect(partitioned.get(root)).toContainEqual({
      ...q('_:nested', 'http://schema.org/name', '"kept"'),
      subject: `${root}/.well-known/genid/nested`,
    });
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
