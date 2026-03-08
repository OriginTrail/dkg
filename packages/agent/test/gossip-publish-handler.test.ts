import { describe, it, expect, vi } from 'vitest';
import {
  encodePublishRequest,
  TypedEventBus,
} from '@dkg/core';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { GossipPublishHandler } from '../src/gossip-publish-handler.js';

const PARANET = 'test-gossip-handler';

function makePublishMessage(opts: {
  ual?: string;
  paranetId?: string;
  nquads?: string;
}): Uint8Array {
  return encodePublishRequest({
    ual: opts.ual ?? '',
    nquads: new TextEncoder().encode(opts.nquads ?? '<http://s> <http://p> <http://o> .'),
    paranetId: opts.paranetId ?? PARANET,
    kas: [],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: '0x1111111111111111111111111111111111111111',
    startKAId: 0,
    endKAId: 0,
    chainId: 'mock:31337',
    publisherSignatureR: new Uint8Array(0),
    publisherSignatureVs: new Uint8Array(0),
  });
}

describe('GossipPublishHandler', () => {
  it('processes a valid publish message and inserts quads into store', async () => {
    const store = new OxigraphStore();
    const eventBus = new TypedEventBus();
    const subscribedParanets = new Map<string, any>();

    const handler = new GossipPublishHandler(
      store,
      undefined,
      eventBus,
      subscribedParanets,
      {
        paranetExists: async () => false,
        subscribeToParanet: () => {},
      },
    );

    const data = makePublishMessage({
      paranetId: PARANET,
      nquads: '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
    });

    await handler.handlePublishMessage(data, PARANET);

    const results = await store.query(
      `SELECT ?s ?p ?o WHERE { ?s ?p ?o . FILTER(?s = <http://example.org/s>) }`,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]['s']).toBe('http://example.org/s');
    expect(results[0]['p']).toBe('http://example.org/p');
    expect(results[0]['o']).toBe('http://example.org/o');
  });

  it('ignores empty broadcast with no UAL', async () => {
    const store = new OxigraphStore();
    const eventBus = new TypedEventBus();
    const subscribedParanets = new Map<string, any>();

    const insertSpy = vi.spyOn(store, 'insert');

    const handler = new GossipPublishHandler(
      store,
      undefined,
      eventBus,
      subscribedParanets,
      {
        paranetExists: async () => false,
        subscribeToParanet: () => {},
      },
    );

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
});
