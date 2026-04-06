import { describe, it, expect, vi } from 'vitest';
import {
  encodePublishRequest,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { GossipPublishHandler } from '../src/gossip-publish-handler.js';

const PARANET = 'test-gossip-handler';

function makePublishMessage(opts: {
  ual?: string;
  contextGraphId?: string;
  nquads?: string;
  kas?: Array<{ tokenId: number; rootEntity: string; privateMerkleRoot: Uint8Array; privateTripleCount: number }>;
}): Uint8Array {
  return encodePublishRequest({
    ual: opts.ual ?? '',
    nquads: new TextEncoder().encode(opts.nquads ?? '<http://s> <http://p> <http://o> .'),
    paranetId: opts.contextGraphId ?? PARANET,
    kas: opts.kas ?? [],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: '0x1111111111111111111111111111111111111111',
    startKAId: 0,
    endKAId: 0,
    chainId: 'mock:31337',
    publisherSignatureR: new Uint8Array(0),
    publisherSignatureVs: new Uint8Array(0),
  });
}

function createHandler(store?: OxigraphStore, callbacks?: Partial<{ contextGraphExists: (id: string) => Promise<boolean>; subscribeToContextGraph: (id: string) => void }>) {
  const s = store ?? new OxigraphStore();
  return {
    store: s,
    handler: new GossipPublishHandler(
      s,
      undefined,
      new Map<string, any>(),
      {
        contextGraphExists: callbacks?.contextGraphExists ?? (async () => false),
        subscribeToContextGraph: callbacks?.subscribeToContextGraph ?? (() => {}),
      },
    ),
  };
}

describe('GossipPublishHandler', () => {
  it('processes a valid publish message and inserts quads into store', async () => {
    const { store, handler } = createHandler();

    const data = makePublishMessage({
      contextGraphId: PARANET,
      nquads: '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
    });

    await handler.handlePublishMessage(data, PARANET);

    const result = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <did:dkg:context-graph:${PARANET}> { ?s ?p ?o . FILTER(?s = <http://example.org/s>) } }`,
    );
    expect(result.type).toBe('bindings');
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings[0]['s']).toBe('http://example.org/s');
    expect(bindings[0]['p']).toBe('http://example.org/p');
    expect(bindings[0]['o']).toBe('http://example.org/o');
  });

  it('ignores empty broadcast with no UAL', async () => {
    const { store, handler } = createHandler();
    const insertSpy = vi.spyOn(store, 'insert');

    const data = encodePublishRequest({
      ual: '',
      nquads: new Uint8Array(0),
      paranetId: PARANET,
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x1111111111111111111111111111111111111111',
      startKAId: 0,
      endKAId: 0,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    await handler.handlePublishMessage(data, PARANET);

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects gossip when contextGraphId mismatches topic', async () => {
    const { store, handler } = createHandler();
    const insertSpy = vi.spyOn(store, 'insert');

    const data = makePublishMessage({
      contextGraphId: 'wrong-paranet',
      nquads: '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
    });

    await handler.handlePublishMessage(data, PARANET);

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('handles duplicate gossip replay (same UAL) without breaking', async () => {
    const { store, handler } = createHandler();

    const entity = 'did:dkg:test:replay-entity';
    const nquads = `<${entity}> <http://schema.org/name> "Replay" .`;
    const kas = [{ tokenId: 1, rootEntity: entity, privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }];

    const data = makePublishMessage({
      ual: 'did:dkg:mock:31337/0x1/1',
      contextGraphId: PARANET,
      nquads,
      kas,
    });

    await handler.handlePublishMessage(data, PARANET);

    const firstResult = await store.query(
      `SELECT ?s WHERE { GRAPH <did:dkg:context-graph:${PARANET}> { ?s <http://schema.org/name> ?o } }`,
    );
    const firstBindings = firstResult.type === 'bindings' ? firstResult.bindings : [];
    expect(firstBindings.length).toBeGreaterThan(0);

    // Second identical message should not throw (replay detected, early return)
    await expect(handler.handlePublishMessage(data, PARANET)).resolves.not.toThrow();
  });

  it('inserts quads for UAL with empty kas (no structural validation)', async () => {
    const { store, handler } = createHandler();

    const data = makePublishMessage({
      ual: 'did:dkg:mock:31337/0x1/1',
      contextGraphId: PARANET,
      nquads: '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
      kas: [],
    });

    await handler.handlePublishMessage(data, PARANET);

    const result = await store.query(
      `SELECT ?s WHERE { GRAPH <did:dkg:context-graph:${PARANET}> { ?s ?p ?o . FILTER(?s = <http://example.org/s>) } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings.length).toBeGreaterThan(0);
  });
});
