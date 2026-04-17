import { describe, it, expect } from 'vitest';
import {
  encodePublishRequest,
  DKG_ONTOLOGY,
  SYSTEM_PARANETS,
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

function createHandler(store?: OxigraphStore, callbacks?: Partial<{ contextGraphExists: (id: string) => Promise<boolean>; getContextGraphOwner: (id: string) => Promise<string | null>; subscribeToContextGraph: (id: string) => void }>) {
  const s = store ?? new OxigraphStore();
  return {
    store: s,
    handler: new GossipPublishHandler(
      s,
      undefined,
      new Map<string, any>(),
      {
        contextGraphExists: callbacks?.contextGraphExists ?? (async () => false),
        getContextGraphOwner: callbacks?.getContextGraphOwner ?? (async () => null),
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

    const countBefore = await store.countQuads(`did:dkg:context-graph:${PARANET}`);

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

    const countAfter = await store.countQuads(`did:dkg:context-graph:${PARANET}`);
    expect(countAfter).toBe(countBefore);
  });

  it('rejects gossip when contextGraphId mismatches topic', async () => {
    const { store, handler } = createHandler();

    const countBefore = await store.countQuads(`did:dkg:context-graph:${PARANET}`);

    const data = makePublishMessage({
      contextGraphId: 'wrong-paranet',
      nquads: '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
    });

    await handler.handlePublishMessage(data, PARANET);

    const countAfter = await store.countQuads(`did:dkg:context-graph:${PARANET}`);
    expect(countAfter).toBe(countBefore);
  });

  it('handles duplicate gossip replay (same UAL) without breaking and without double-inserting quads', async () => {
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

    const graphUri = `did:dkg:context-graph:${PARANET}`;
    const firstResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${graphUri}> { ?s <http://schema.org/name> ?o } }`,
    );
    const firstBindings = firstResult.type === 'bindings' ? firstResult.bindings : [];
    expect(firstBindings.length).toBeGreaterThan(0);

    // Snapshot the graph's quad count before the replay so we can assert
    // the second delivery is *actually* a no-op on the store — not just
    // that it returned without throwing. A regression where dedup stops
    // firing (duplicate UAL still re-inserts) would otherwise slip past
    // a `.resolves.not.toThrow()` assertion unnoticed.
    const countBefore = await store.countQuads(graphUri);

    await expect(handler.handlePublishMessage(data, PARANET)).resolves.not.toThrow();

    const countAfter = await store.countQuads(graphUri);
    expect(
      countAfter,
      'replay of identical gossip UAL must not add any quads to the data graph',
    ).toBe(countBefore);
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

  it('rejects forged ontology policy approvals from non-owners', async () => {
    const { store, handler } = createHandler(undefined, {
      getContextGraphOwner: async (id) => id === 'ops-policy' ? 'did:dkg:agent:owner' : null,
    });

    const data = makePublishMessage({
      contextGraphId: SYSTEM_PARANETS.ONTOLOGY,
      nquads: [
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#PolicyBinding> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#appliesToParanet> <did:dkg:context-graph:ops-policy> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://schema.org/name> "incident-review" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#activePolicy> <did:dkg:policy:ops-policy:sha256-fake> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#approvedBy> <did:dkg:agent:attacker> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#approvedAt> "2026-03-24T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_PARANETS.ONTOLOGY);

    const result = await store.query(
      `SELECT ?binding WHERE { GRAPH <did:dkg:context-graph:${SYSTEM_PARANETS.ONTOLOGY}> { ?binding <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> ?policy } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings).toHaveLength(0);
  });

  it('rejects ontology policy approvals that omit approvedBy', async () => {
    const { store, handler } = createHandler(undefined, {
      getContextGraphOwner: async (id) => id === 'ops-policy' ? 'did:dkg:agent:owner' : null,
    });

    const data = makePublishMessage({
      contextGraphId: SYSTEM_PARANETS.ONTOLOGY,
      nquads: [
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#PolicyBinding> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <https://dkg.network/ontology#appliesToParanet> <did:dkg:context-graph:ops-policy> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <https://schema.org/name> "incident-review" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <https://dkg.network/ontology#activePolicy> <did:dkg:policy:ops-policy:sha256-missing-approved-by> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <https://dkg.network/ontology#approvedAt> "2026-03-24T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_PARANETS.ONTOLOGY);

    const result = await store.query(
      `SELECT ?binding WHERE { GRAPH <did:dkg:context-graph:${SYSTEM_PARANETS.ONTOLOGY}> { ?binding <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> <did:dkg:policy:ops-policy:sha256-missing-approved-by> } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings).toHaveLength(0);
  });

  it('rejects ontology policy revocations that omit revokedBy', async () => {
    const { store, handler } = createHandler(undefined, {
      getContextGraphOwner: async (id) => id === 'ops-policy' ? 'did:dkg:agent:owner' : null,
    });

    const data = makePublishMessage({
      contextGraphId: SYSTEM_PARANETS.ONTOLOGY,
      nquads: [
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#PolicyBinding> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#appliesToParanet> <did:dkg:context-graph:ops-policy> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://schema.org/name> "incident-review" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#activePolicy> <did:dkg:policy:ops-policy:sha256-missing-revoked-by> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#approvedBy> <did:dkg:agent:owner> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#approvedAt> "2026-03-24T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#revokedAt> "2026-03-25T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_PARANETS.ONTOLOGY);

    const result = await store.query(
      `SELECT ?binding WHERE { GRAPH <did:dkg:context-graph:${SYSTEM_PARANETS.ONTOLOGY}> { ?binding <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> <did:dkg:policy:ops-policy:sha256-missing-revoked-by> } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings).toHaveLength(0);
  });

  it('accepts ontology policy approvals from the current paranet owner', async () => {
    const { store, handler } = createHandler(undefined, {
      getContextGraphOwner: async (id) => id === 'ops-policy' ? 'did:dkg:agent:owner' : null,
    });

    const data = makePublishMessage({
      contextGraphId: SYSTEM_PARANETS.ONTOLOGY,
      nquads: [
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#PolicyBinding> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#appliesToParanet> <did:dkg:context-graph:ops-policy> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://schema.org/name> "incident-review" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#activePolicy> <did:dkg:policy:ops-policy:sha256-real> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#approvedBy> <did:dkg:agent:owner> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#approvedAt> "2026-03-24T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_PARANETS.ONTOLOGY);

    const result = await store.query(
      `SELECT ?binding WHERE { GRAPH <did:dkg:context-graph:${SYSTEM_PARANETS.ONTOLOGY}> { ?binding <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> <did:dkg:policy:ops-policy:sha256-real> } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings).toHaveLength(1);
  });
});
