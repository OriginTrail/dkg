import { describe, it, expect } from 'vitest';
import {
  encodePublishRequest,
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { GossipPublishHandler } from '../src/gossip-publish-handler.js';
import type { ContextGraphSub } from '../src/index.js';

const CONTEXT_GRAPH = 'test-gossip-handler';

function makePublishMessage(opts: {
  ual?: string;
  contextGraphId?: string;
  nquads?: string;
  kas?: Array<{ tokenId: number; rootEntity: string; privateMerkleRoot: Uint8Array; privateTripleCount: number }>;
}): Uint8Array {
  return encodePublishRequest({
    ual: opts.ual ?? '',
    nquads: new TextEncoder().encode(opts.nquads ?? '<http://s> <http://p> <http://o> .'),
    contextGraphId: opts.contextGraphId ?? CONTEXT_GRAPH,
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

function createHandler(store?: OxigraphStore, callbacks?: Partial<{
  contextGraphExists: (id: string) => Promise<boolean>;
  getContextGraphOwner: (id: string) => Promise<string | null>;
  setContextGraphSubscription: (id: string, next: ContextGraphSub) => void;
  recordDiscoveredContextGraph: (id: string, next: ContextGraphSub) => void;
}>) {
  const s = store ?? new OxigraphStore();
  const subscriptions = new Map<string, ContextGraphSub>();
  return {
    store: s,
    subscriptions,
    handler: new GossipPublishHandler(
      s,
      undefined,
      subscriptions,
      {
        contextGraphExists: callbacks?.contextGraphExists ?? (async () => false),
        getContextGraphOwner: callbacks?.getContextGraphOwner ?? (async () => null),
        setContextGraphSubscription: callbacks?.setContextGraphSubscription ?? ((id, next) => { subscriptions.set(id, next); }),
        recordDiscoveredContextGraph: callbacks?.recordDiscoveredContextGraph ?? ((id, next) => {
          subscriptions.set(id, { ...next, subscribed: false });
        }),
      },
    ),
  };
}

describe('GossipPublishHandler', () => {
  it('processes a valid publish message and inserts quads into store', async () => {
    const { store, handler } = createHandler();

    const data = makePublishMessage({
      contextGraphId: CONTEXT_GRAPH,
      nquads: '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
    });

    await handler.handlePublishMessage(data, CONTEXT_GRAPH);

    const result = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH}> { ?s ?p ?o . FILTER(?s = <http://example.org/s>) } }`,
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

    const countBefore = await store.countQuads(`did:dkg:context-graph:${CONTEXT_GRAPH}`);

    const data = encodePublishRequest({
      ual: '',
      nquads: new Uint8Array(0),
      contextGraphId: CONTEXT_GRAPH,
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x1111111111111111111111111111111111111111',
      startKAId: 0,
      endKAId: 0,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    await handler.handlePublishMessage(data, CONTEXT_GRAPH);

    const countAfter = await store.countQuads(`did:dkg:context-graph:${CONTEXT_GRAPH}`);
    expect(countAfter).toBe(countBefore);
  });

  it('rejects gossip when contextGraphId mismatches topic', async () => {
    const { store, handler } = createHandler();

    const countBefore = await store.countQuads(`did:dkg:context-graph:${CONTEXT_GRAPH}`);

    const data = makePublishMessage({
      contextGraphId: 'wrong-contextGraph',
      nquads: '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
    });

    await handler.handlePublishMessage(data, CONTEXT_GRAPH);

    const countAfter = await store.countQuads(`did:dkg:context-graph:${CONTEXT_GRAPH}`);
    expect(countAfter).toBe(countBefore);
  });

  it('handles duplicate gossip replay (same UAL) without breaking and without double-inserting quads', async () => {
    const { store, handler } = createHandler();

    const entity = 'did:dkg:test:replay-entity';
    const nquads = `<${entity}> <http://schema.org/name> "Replay" .`;
    const kas = [{ tokenId: 1, rootEntity: entity, privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }];

    const data = makePublishMessage({
      ual: 'did:dkg:mock:31337/0x1/1',
      contextGraphId: CONTEXT_GRAPH,
      nquads,
      kas,
    });

    await handler.handlePublishMessage(data, CONTEXT_GRAPH);

    const graphUri = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
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

    await expect(handler.handlePublishMessage(data, CONTEXT_GRAPH)).resolves.not.toThrow();

    const countAfter = await store.countQuads(graphUri);
    expect(
      countAfter,
      'replay of identical gossip UAL must not add any quads to the data graph',
    ).toBe(countBefore);
  });

  it('does NOT persist tentative _meta for the agents registry CG (#1233 — agents/_meta bloat)', async () => {
    const { store, handler } = createHandler();
    const agentsCg = SYSTEM_CONTEXT_GRAPHS.AGENTS;
    const entity = 'did:dkg:agent:0x1111111111111111111111111111111111111111';

    const data = makePublishMessage({
      ual: 'did:dkg:mock:31337/0x1/t-session-1',
      contextGraphId: agentsCg,
      nquads: `<${entity}> <http://schema.org/name> "Agent" .`,
      kas: [{ tokenId: 1, rootEntity: entity, privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
    });

    await handler.handlePublishMessage(data, agentsCg);

    // The profile data is still stored in the agents DATA graph...
    const dataCount = await store.countQuads(`did:dkg:context-graph:${agentsCg}`);
    expect(dataCount, 'agent profile data must still land in the data graph').toBeGreaterThan(0);

    // ...but NO per-publish tentative tracking record lands in agents/_meta.
    // That record has no consumer (the registry is served from the data graph)
    // and a fresh one per peer heartbeat is what grows agents/_meta unbounded.
    const metaCount = await store.countQuads(`did:dkg:context-graph:${agentsCg}/_meta`);
    expect(metaCount, 'agents/_meta must not accumulate per-publish tentative records').toBe(0);
  });

  it('DOES persist tentative _meta for a non-registry data CG (control)', async () => {
    const { store, handler } = createHandler();
    const entity = 'did:dkg:test:meta-control-entity';

    const data = makePublishMessage({
      ual: 'did:dkg:mock:31337/0x1/1',
      contextGraphId: CONTEXT_GRAPH,
      nquads: `<${entity}> <http://schema.org/name> "Thing" .`,
      kas: [{ tokenId: 1, rootEntity: entity, privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
    });

    await handler.handlePublishMessage(data, CONTEXT_GRAPH);

    const metaCount = await store.countQuads(`did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`);
    expect(metaCount, 'non-registry CGs keep the tentative publish-tracking record').toBeGreaterThan(0);
  });

  it('inserts quads for UAL with empty kas (no structural validation)', async () => {
    const { store, handler } = createHandler();

    const data = makePublishMessage({
      ual: 'did:dkg:mock:31337/0x1/1',
      contextGraphId: CONTEXT_GRAPH,
      nquads: '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
      kas: [],
    });

    await handler.handlePublishMessage(data, CONTEXT_GRAPH);

    const result = await store.query(
      `SELECT ?s WHERE { GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH}> { ?s ?p ?o . FILTER(?s = <http://example.org/s>) } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings.length).toBeGreaterThan(0);
  });

  it('inserts validated ontology definitions without activating a member subscription', async () => {
    const { store, handler, subscriptions } = createHandler();
    const id = 'ontology-discovery-only';
    const data = makePublishMessage({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      nquads: [
        `<did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> .`,
        `<did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.SCHEMA_NAME}> "Ontology Discovery Only" <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> .`,
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    expect(subscriptions.get(id)).toMatchObject({
      name: 'Ontology Discovery Only',
      subscribed: false,
      synced: false,
      metaSynced: false,
    });

    const inserted = await store.query(`
      ASK WHERE {
        GRAPH <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> {
          <did:dkg:context-graph:${id}>
            <${DKG_ONTOLOGY.RDF_TYPE}>
            <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        }
      }
    `);
    expect(inserted).toEqual({ type: 'boolean', value: true });
  });

  it('does not catalogue ontology rows that lack a ContextGraph definition', async () => {
    const { handler, subscriptions } = createHandler();
    const id = 'ontology-name-only';
    const data = makePublishMessage({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      nquads: [
        `<did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.SCHEMA_NAME}> "Not A Definition" <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> .`,
        `<did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.RDF_TYPE}> <http://schema.org/Thing> <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> .`,
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    expect(subscriptions.has(id)).toBe(false);
  });

  it('keeps legacy subscription-map fallback when setContextGraphSubscription is omitted', async () => {
    const store = new OxigraphStore();
    const subscriptions = new Map<string, ContextGraphSub>();
    const handler = new GossipPublishHandler(
      store,
      undefined,
      subscriptions,
      {
        contextGraphExists: async () => false,
        getContextGraphOwner: async () => null,
      },
    );

    const id = 'legacy-callback-discovery';
    const data = makePublishMessage({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      nquads: [
        `<did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> .`,
        `<did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.SCHEMA_NAME}> "Legacy Callback Discovery" <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> .`,
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    expect(subscriptions.get(id)).toMatchObject({
      name: 'Legacy Callback Discovery',
      subscribed: false,
      synced: false,
      metaSynced: false,
    });
  });

  it('requires the invalidating subscription setter for agent-backed handlers', () => {
    const store = new OxigraphStore();
    const subscriptions = new Map<string, ContextGraphSub>();

    expect(() => new GossipPublishHandler(
      store,
      undefined,
      subscriptions,
      {
        contextGraphExists: async () => false,
        getContextGraphOwner: async () => null,
      },
      { requireContextGraphSubscriptionSetter: true },
    )).toThrow('requires setContextGraphSubscription');
  });

  it('rejects forged ontology policy approvals from non-owners', async () => {
    const { store, handler } = createHandler(undefined, {
      getContextGraphOwner: async (id) => id === 'ops-policy' ? 'did:dkg:agent:0x1111111111111111111111111111111111111111' : null,
    });

    const data = makePublishMessage({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      nquads: [
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#PolicyBinding> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#appliesToContextGraph> <did:dkg:context-graph:ops-policy> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://schema.org/name> "incident-review" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#activePolicy> <did:dkg:policy:ops-policy:sha256-fake> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#approvedBy> <did:dkg:agent:0x2222222222222222222222222222222222222222> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#approvedAt> "2026-03-24T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    const result = await store.query(
      `SELECT ?binding WHERE { GRAPH <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> { ?binding <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> ?policy } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings).toHaveLength(0);
  });

  it('rejects ontology policy approvals that omit approvedBy', async () => {
    const { store, handler } = createHandler(undefined, {
      getContextGraphOwner: async (id) => id === 'ops-policy' ? 'did:dkg:agent:0x1111111111111111111111111111111111111111' : null,
    });

    const data = makePublishMessage({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      nquads: [
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#PolicyBinding> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <https://dkg.network/ontology#appliesToContextGraph> <did:dkg:context-graph:ops-policy> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <https://schema.org/name> "incident-review" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <https://dkg.network/ontology#activePolicy> <did:dkg:policy:ops-policy:sha256-missing-approved-by> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-approved-by> <https://dkg.network/ontology#approvedAt> "2026-03-24T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    const result = await store.query(
      `SELECT ?binding WHERE { GRAPH <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> { ?binding <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> <did:dkg:policy:ops-policy:sha256-missing-approved-by> } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings).toHaveLength(0);
  });

  it('rejects ontology policy revocations that omit revokedBy', async () => {
    const { store, handler } = createHandler(undefined, {
      getContextGraphOwner: async (id) => id === 'ops-policy' ? 'did:dkg:agent:0x1111111111111111111111111111111111111111' : null,
    });

    const data = makePublishMessage({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      nquads: [
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#PolicyBinding> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#appliesToContextGraph> <did:dkg:context-graph:ops-policy> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://schema.org/name> "incident-review" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#activePolicy> <did:dkg:policy:ops-policy:sha256-missing-revoked-by> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#approvedBy> <did:dkg:agent:0x1111111111111111111111111111111111111111> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#approvedAt> "2026-03-24T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:missing-revoked-by> <https://dkg.network/ontology#revokedAt> "2026-03-25T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    const result = await store.query(
      `SELECT ?binding WHERE { GRAPH <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> { ?binding <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> <did:dkg:policy:ops-policy:sha256-missing-revoked-by> } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings).toHaveLength(0);
  });

  it('accepts ontology policy approvals from the current contextGraph owner', async () => {
    const { store, handler } = createHandler(undefined, {
      getContextGraphOwner: async (id) => id === 'ops-policy' ? 'did:dkg:agent:0x1111111111111111111111111111111111111111' : null,
    });

    const data = makePublishMessage({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      nquads: [
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#PolicyBinding> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#appliesToContextGraph> <did:dkg:context-graph:ops-policy> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://schema.org/name> "incident-review" <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#activePolicy> <did:dkg:policy:ops-policy:sha256-real> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#approvedBy> <did:dkg:agent:0x1111111111111111111111111111111111111111> <did:dkg:context-graph:ontology> .',
        '<did:dkg:policy-binding:ops-policy:incident-review:default:1> <https://dkg.network/ontology#approvedAt> "2026-03-24T00:00:00.000Z" <did:dkg:context-graph:ontology> .',
      ].join('\n'),
    });

    await handler.handlePublishMessage(data, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    const result = await store.query(
      `SELECT ?binding WHERE { GRAPH <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> { ?binding <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> <did:dkg:policy:ops-policy:sha256-real> } }`,
    );
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings).toHaveLength(1);
  });
});
