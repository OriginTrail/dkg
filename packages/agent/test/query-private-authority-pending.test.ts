import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const OUTSIDER = '0x00000000000000000000000000000000000000ff';
const PRIVATE_CG = `${OWNER}/authority-pending-private`;
const PUBLIC_CG = 'authority-pending-public';
const MARKER_CLASS = 'urn:nos:R3SyntheticMarker';
const PRIVATE_MARKER = 'urn:nos:r3:private';
const PUBLIC_MARKER = 'urn:nos:r3:public';
const privatePrefix = contextGraphDataGraphUri(PRIVATE_CG);
const markerQuery = (prefix: string) =>
  `SELECT ?g ?s WHERE { GRAPH ?g { ?s a <${MARKER_CLASS}> } FILTER(STRSTARTS(STR(?g), "${prefix}")) } LIMIT 20`;
const anyMarkerQuery = `SELECT ?g ?s WHERE { GRAPH ?g { ?s a <${MARKER_CLASS}> } } LIMIT 20`;

interface Registration {
  onChainId: bigint;
  accessPolicy: 0 | 1;
  participantAgents: string[];
}

describe('unscoped queries while RFC-64 private authority is pending (#2564)', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (agent) {
      await agent.stop();
      await agent.store.close();
    }
    agent = undefined;
  });

  async function fixture(options: { privateGraph?: boolean; publicGraph?: boolean } = {}) {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'QueryPrivateAuthorityPending',
      chainAdapter: chain,
      store: new OxigraphStore(),
    });
    // These local create/query tests need a host identity, not a running peer.
    vi.spyOn(agent, 'peerId', 'get').mockReturnValue('peer-query-authority-pending');
    // Keep the real subscription state changes while replacing only transport:
    // no peer lifecycle or network delivery is needed to query the local store.
    agent.gossip = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      onMessage: vi.fn(),
      offMessage: vi.fn(),
      publish: vi.fn(async () => undefined),
    } as unknown as DKGAgent['gossip'];
    const runtime = agent as unknown as {
      config: { syncContextGraphs?: string[]; rfc64CatalogBootstrap?: unknown };
      subscribedContextGraphs: Map<string, unknown>;
      rfc64PublicCatalogServiceV1: { acceptedPolicySnapshot: () => null } | undefined;
    };
    const acceptedPolicySnapshot = vi.fn(() => null);
    vi.spyOn(runtime, 'rfc64PublicCatalogServiceV1', 'get')
      .mockReturnValue({ acceptedPolicySnapshot });
    expect(runtime.config.rfc64CatalogBootstrap).toBeUndefined();
    expect(agent.resolveRfc64PrivateReadRosterV1(PRIVATE_CG)).toBeUndefined();
    expect(acceptedPolicySnapshot).toHaveBeenCalled();

    // Only external registration and chain reads are replaced. Candidate
    // discovery, metadata, read authority, and query execution remain real.
    const registrations = new Map<string, Registration>();
    const byChainId = (onChainId: bigint) => {
      const entry = [...registrations.values()].find((value) => value.onChainId === onChainId);
      if (!entry) throw new Error(`Unknown test chain id ${onChainId}`);
      return entry;
    };
    const resolveRegistration = agent.resolveContextGraphRegistrationBinding.bind(agent);
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockImplementation(async (id) => {
      const entry = registrations.get(id);
      return entry
        ? { kind: 'registered' as const, onChainId: entry.onChainId, provenance: 'numeric-id' as const }
        : resolveRegistration(id);
    });
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockImplementation(async (id) => {
      byChainId(id);
      return true;
    });
    const policyRead = vi.spyOn(chain, 'getContextGraphAccessPolicy')
      .mockImplementation(async (id) => byChainId(id).accessPolicy);
    const rosterRead = vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockImplementation(async (id) => [...byChainId(id).participantAgents]);

    if (options.privateGraph !== false) {
      await agent.createContextGraph({
        id: PRIVATE_CG,
        name: 'Private graph with pending finalized authority',
        accessPolicy: 1,
        callerAgentAddress: OWNER,
      });
      registrations.set(PRIVATE_CG, { onChainId: 7n, accessPolicy: 1, participantAgents: [OWNER] });
      await agent.store.insert([
        ...['context/7', `_verifiable_memory/${OWNER}/3384`].map((suffix) => ({
          subject: PRIVATE_MARKER,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: MARKER_CLASS,
          graph: `${privatePrefix}/${suffix}`,
        })),
        {
          subject: privatePrefix,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH,
          graph: `${privatePrefix}/_catalog`,
        },
      ]);
    }
    if (options.publicGraph !== false) {
      await agent.createContextGraph({
        id: PUBLIC_CG,
        name: 'Public positive control',
        accessPolicy: 0,
        callerAgentAddress: OWNER,
      });
      registrations.set(PUBLIC_CG, { onChainId: 8n, accessPolicy: 0, participantAgents: [] });
      await agent.store.insert([{
        subject: PUBLIC_MARKER,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: MARKER_CLASS,
        graph: contextGraphDataGraphUri(PUBLIC_CG),
      }]);
    }
    const queryExecution = vi.spyOn(agent.queryEngine, 'query');
    return { agent, chain, runtime, registrations, policyRead, rosterRead, queryExecution };
  }

  const reportedForms = [
    {
      row: 5,
      form: 'explicit private GRAPH',
      sparql: `SELECT ?s ?p ?o WHERE { GRAPH <${privatePrefix}/_catalog> { ?s ?p ?o } } LIMIT 50`,
      empty: { bindings: [] },
    },
    {
      row: 6,
      form: 'graph variable with STRSTARTS',
      sparql: `SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${privatePrefix}")) } LIMIT 50`,
      empty: { bindings: [] },
    },
    {
      row: 7,
      form: 'ASK',
      sparql: `ASK { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${privatePrefix}")) }`,
      empty: { bindings: [{ result: 'false' }] },
    },
    {
      row: 8,
      form: 'COUNT',
      sparql: `SELECT (COUNT(*) AS ?count) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${privatePrefix}")) }`,
      empty: { bindings: [] },
    },
    {
      row: 9,
      form: 'projection without the graph variable',
      sparql: `SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${privatePrefix}")) } LIMIT 50`,
      empty: { bindings: [] },
    },
    {
      row: 11,
      form: 'unfiltered graph-variable SELECT',
      sparql: 'SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 50',
      empty: { bindings: [] },
    },
    {
      row: 13,
      form: 'CONSTRUCT',
      sparql: 'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 50',
      empty: { bindings: [], quads: [] },
    },
  ];

  it.each(reportedForms)('denies probe row $row ($form) before executing SPARQL', async ({ sparql, empty }) => {
    const { agent, queryExecution } = await fixture();
    await expect(agent.query(sparql, { callerAgentAddress: OUTSIDER })).resolves.toEqual(empty);
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it('keeps owner/private and outsider/public positive controls, and scoped outsider denial', async () => {
    const { agent, queryExecution } = await fixture();
    const owner = await agent.query(markerQuery(privatePrefix), {
      contextGraphId: PRIVATE_CG,
      callerAgentAddress: OWNER,
    });
    expect(owner.bindings).toEqual([expect.objectContaining({ s: PRIVATE_MARKER })]);
    const publicRead = await agent.query(markerQuery(contextGraphDataGraphUri(PUBLIC_CG)), {
      contextGraphId: PUBLIC_CG,
      callerAgentAddress: OUTSIDER,
    });
    expect(publicRead.bindings).toEqual([expect.objectContaining({ s: PUBLIC_MARKER })]);
    expect(queryExecution).toHaveBeenCalledTimes(2);

    await expect(agent.query(markerQuery(privatePrefix), {
      contextGraphId: PRIVATE_CG,
      callerAgentAddress: OUTSIDER,
    })).resolves.toEqual({ bindings: [] });
    expect(queryExecution).toHaveBeenCalledTimes(2);

    const ownerUnscoped = await agent.query(markerQuery(privatePrefix), { callerAgentAddress: OWNER });
    expect(ownerUnscoped.bindings).toHaveLength(2);
    expect(ownerUnscoped.bindings?.map((row) => row.g)).toEqual(expect.arrayContaining([
      `${privatePrefix}/context/7`,
      `${privatePrefix}/_verifiable_memory/${OWNER}/3384`,
    ]));
  });

  it('denies a freshly registered outsider in all three row-32 probes', async () => {
    const { agent, queryExecution } = await fixture();
    const freshOutsider = await agent.registerAgent('Fresh unrelated probe agent');
    const callerAgentAddress = freshOutsider.agentAddress;
    await expect(agent.query(markerQuery(privatePrefix), {
      contextGraphId: PRIVATE_CG,
      callerAgentAddress,
    })).resolves.toEqual({ bindings: [] });
    await expect(agent.query(markerQuery(privatePrefix), { callerAgentAddress }))
      .resolves.toEqual({ bindings: [] });
    await expect(agent.query(reportedForms[2].sparql, { callerAgentAddress }))
      .resolves.toEqual({ bindings: [{ result: 'false' }] });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it('discovers namespaced private _meta after subscription state is lost', async () => {
    const { agent, runtime, registrations, queryExecution } = await fixture({ publicGraph: false });
    runtime.subscribedContextGraphs.clear();
    runtime.config.syncContextGraphs = [];
    registrations.clear();
    const ontology = await agent.store.query(`SELECT ?policy WHERE {
      GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> {
        <${privatePrefix}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
      }
    }`);
    expect(ontology).toMatchObject({ type: 'bindings', bindings: [] });
    await expect(agent.isPrivateContextGraph(PRIVATE_CG)).resolves.toBe(true);

    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
    const owner = await agent.query(markerQuery(privatePrefix), { callerAgentAddress: OWNER });
    expect(owner.bindings).toHaveLength(2);
  });

  it('discovers a persisted namespaced legacy agent gate without an explicit accessPolicy', async () => {
    const { agent, runtime, queryExecution } = await fixture({ privateGraph: false, publicGraph: false });
    await agent.store.insert([
      {
        subject: privatePrefix,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${OWNER}"`,
        graph: contextGraphMetaGraphUri(PRIVATE_CG),
      },
      {
        subject: PRIVATE_MARKER,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: MARKER_CLASS,
        graph: `${privatePrefix}/_verifiable_memory/${OWNER}/3384`,
      },
    ]);
    expect(runtime.subscribedContextGraphs.has(PRIVATE_CG)).toBe(false);
    await expect(agent.getExplicitAccessPolicy(PRIVATE_CG)).resolves.toBeNull();
    await expect(agent.isPrivateContextGraph(PRIVATE_CG)).resolves.toBe(true);
    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it('checks chain-private runtime candidates even when local metadata contains no policy', async () => {
    const { agent, registrations, queryExecution } = await fixture({ privateGraph: false, publicGraph: false });
    registrations.set(PRIVATE_CG, { onChainId: 7n, accessPolicy: 1, participantAgents: [OWNER] });
    agent.setContextGraphSubscription(PRIVATE_CG, {
      subscribed: true,
      synced: false,
      metaSynced: false,
      onChainId: '7',
    }, { persist: false });
    await agent.store.insert([{
      subject: PRIVATE_MARKER,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: MARKER_CLASS,
      graph: `${privatePrefix}/context/7`,
    }]);
    await expect(agent.isPrivateContextGraph(PRIVATE_CG)).resolves.toBe(false);
    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it.each([
    'context/7',
    'tasks/_meta',
    `assertion/${OWNER}/legacy-working-memory`,
    `_verifiable_memory/${OWNER}/3384`,
    `_shared_memory/${OWNER}/3384`,
  ])('denies a registered private graph persisted only as /%s data', async (suffix) => {
    const { agent, runtime, registrations, queryExecution } = await fixture({
      privateGraph: false,
      publicGraph: false,
    });
    registrations.set(PRIVATE_CG, { onChainId: 7n, accessPolicy: 1, participantAgents: [OWNER] });
    const dataGraph = `${privatePrefix}/${suffix}`;
    await agent.store.insert([{
      subject: PRIVATE_MARKER,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: MARKER_CLASS,
      graph: dataGraph,
    }]);
    expect(runtime.subscribedContextGraphs.has(PRIVATE_CG)).toBe(false);
    expect(runtime.config.syncContextGraphs ?? []).not.toContain(PRIVATE_CG);
    expect((await agent.store.listGraphs()).filter((graph) => graph.startsWith(privatePrefix)))
      .toEqual([dataGraph]);

    // The same chain authority already denies scoped outsiders; the remaining
    // data partition must also make this CG a candidate for unscoped admission.
    await expect(agent.query(markerQuery(privatePrefix), {
      contextGraphId: PRIVATE_CG,
      callerAgentAddress: OUTSIDER,
    })).resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
    const owner = await agent.query(markerQuery(privatePrefix), { callerAgentAddress: OWNER });
    expect(owner.bindings).toEqual([{ g: dataGraph, s: PRIVATE_MARKER }]);
    queryExecution.mockClear();

    await expect(agent.query(markerQuery(privatePrefix), { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it.each(['policy', 'roster'] as const)('denies even the owner when registered %s authority is unavailable', async (source) => {
    const { agent, policyRead, rosterRead, queryExecution } = await fixture({ publicGraph: false });
    (source === 'policy' ? policyRead : rosterRead).mockRejectedValue(new Error('RPC authority unavailable'));
    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OWNER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'tenant/_meta', suffix: '', layout: 'legacy _meta root data' },
    { id: 'tenant/_catalog', suffix: '', layout: 'legacy _catalog root data' },
    { id: 'tenant/_old/private', suffix: '', layout: 'legacy reserved-segment root data' },
    { id: 'tenant/namespaced-private', suffix: '/_meta', layout: 'root metadata without a self-declaration' },
  ])('denies private $layout even with a known public ancestor', async ({ id, suffix }) => {
    const { agent, runtime, registrations, queryExecution } = await fixture({
      privateGraph: false,
      publicGraph: false,
    });
    const rootPrefix = contextGraphDataGraphUri(id);
    const dataGraph = `${rootPrefix}${suffix}`;
    const publicAncestor = 'tenant';
    const publicPrefix = contextGraphDataGraphUri(publicAncestor);
    registrations.set(id, { onChainId: 7n, accessPolicy: 1, participantAgents: [OWNER] });
    registrations.set(publicAncestor, { onChainId: 8n, accessPolicy: 0, participantAgents: [] });
    // These are persisted legacy layouts. New-root validation intentionally
    // forbids reserved segments, but stored data remains available to readers.
    await agent.store.insert([
      {
        subject: PRIVATE_MARKER,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: MARKER_CLASS,
        graph: dataGraph,
      },
      {
        subject: PUBLIC_MARKER,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: MARKER_CLASS,
        graph: publicPrefix,
      },
    ]);
    expect(runtime.subscribedContextGraphs.has(id)).toBe(false);
    expect(runtime.config.syncContextGraphs ?? []).not.toContain(id);
    const publicRead = await agent.query(
      `SELECT ?s WHERE { GRAPH <${publicPrefix}> { ?s a <${MARKER_CLASS}> } }`,
      { contextGraphId: publicAncestor, callerAgentAddress: OUTSIDER },
    );
    expect(publicRead.bindings).toEqual([{ s: PUBLIC_MARKER }]);
    queryExecution.mockClear();

    await expect(agent.query(markerQuery(rootPrefix), {
      contextGraphId: id,
      callerAgentAddress: OUTSIDER,
    })).resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
    const owner = await agent.query(markerQuery(rootPrefix), { callerAgentAddress: OWNER });
    expect(owner.bindings).toEqual([{ g: dataGraph, s: PRIVATE_MARKER }]);
    queryExecution.mockClear();

    await expect(agent.query(markerQuery(rootPrefix), { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it('denies a runtime graph whose authenticated metadata is pending', async () => {
    const { agent, queryExecution } = await fixture({ privateGraph: false, publicGraph: false });
    agent.setContextGraphSubscription(PRIVATE_CG, {
      subscribed: true,
      synced: false,
      metaSynced: false,
      pendingMeta: true,
    }, { persist: false });
    await expect(agent.query('ASK { GRAPH ?g { ?s ?p ?o } }', { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [{ result: 'false' }] });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it('allows unscoped public-only reads without an accepted RFC-64 snapshot', async () => {
    const { agent, queryExecution } = await fixture({ privateGraph: false });
    const result = await agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER });
    expect(result.bindings).toEqual([expect.objectContaining({ s: PUBLIC_MARKER })]);
    expect(queryExecution).toHaveBeenCalledOnce();
  });

  it('preserves registered-public authority over stale local private metadata', async () => {
    const { agent, registrations, queryExecution } = await fixture({ publicGraph: false });
    registrations.get(PRIVATE_CG)!.accessPolicy = 0;
    await expect(agent.isPrivateContextGraph(PRIVATE_CG)).resolves.toBe(true);
    const result = await agent.query(markerQuery(privatePrefix), { callerAgentAddress: OUTSIDER });
    expect(result.bindings).toHaveLength(2);
    expect(queryExecution).toHaveBeenCalledOnce();
  });

  it('denies unscoped reads when another possible metadata owner is unavailable but preserves scoped public reads', async () => {
    const { agent, chain, queryExecution } = await fixture({ privateGraph: false });
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockRejectedValue(new Error('unknown graph registration unavailable'));
    await agent.store.insert([{
      subject: 'urn:public:task:1',
      predicate: 'urn:public:task:status',
      object: '"complete"',
      graph: `${contextGraphDataGraphUri(PUBLIC_CG)}/tasks/_meta`,
    }]);
    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
    const publicRead = await agent.query(markerQuery(contextGraphDataGraphUri(PUBLIC_CG)), {
      contextGraphId: PUBLIC_CG,
      callerAgentAddress: OUTSIDER,
    });
    expect(publicRead.bindings).toEqual([expect.objectContaining({ s: PUBLIC_MARKER })]);
    expect(queryExecution).toHaveBeenCalledOnce();
  });

  it('discovers a namespaced private graph known only by its own catalog declaration', async () => {
    const { agent, queryExecution } = await fixture({ privateGraph: false, publicGraph: false });
    await agent.store.insert([{
      subject: privatePrefix,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH,
      graph: `${privatePrefix}/_catalog`,
    }]);
    await expect(agent.query(reportedForms[0].sparql, { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it('keeps private discovery closed with the legacy listGraphs inventory fallback', async () => {
    const { agent, runtime, queryExecution } = await fixture({ publicGraph: false });
    runtime.subscribedContextGraphs.clear();
    runtime.config.syncContextGraphs = [];
    Object.defineProperty(agent.store, 'listGraphsByPrefix', { configurable: true, value: undefined });
    const inventory = vi.spyOn(agent.store, 'listGraphs');
    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(inventory).toHaveBeenCalled();
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it('checks a private graph after the first 128 stored graphs', async () => {
    const { agent, runtime, queryExecution } = await fixture({ privateGraph: false, publicGraph: false });
    const lastPrivateId = `${OWNER}/batch-zzz-private`;
    const lastPrivatePrefix = contextGraphDataGraphUri(lastPrivateId);
    await agent.store.insert([
      ...Array.from({ length: 128 }, (_, index) => {
        const id = `${OWNER}/batch-${String(index).padStart(3, '0')}`;
        return {
          subject: contextGraphDataGraphUri(id),
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"public"',
          graph: contextGraphMetaGraphUri(id),
        };
      }),
      {
        subject: lastPrivatePrefix,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${OWNER}"`,
        graph: contextGraphMetaGraphUri(lastPrivateId),
      },
      {
        subject: PRIVATE_MARKER,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: MARKER_CLASS,
        graph: contextGraphMetaGraphUri(lastPrivateId),
      },
    ]);
    expect(runtime.subscribedContextGraphs.has(lastPrivateId)).toBe(false);
    // Store enumeration order is unspecified. Sort its real results so this
    // fixture reliably puts the private graph after the 128 public graphs.
    const listGraphsByPrefix = agent.store.listGraphsByPrefix!.bind(agent.store);
    vi.spyOn(agent.store, 'listGraphsByPrefix').mockImplementation(async (prefix, options) => (
      (await listGraphsByPrefix(prefix, options)).sort()
    ));
    const readAuthority = vi.spyOn(agent, 'canReadContextGraph');

    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER }))
      .resolves.toEqual({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
    expect(readAuthority).toHaveBeenCalledWith(lastPrivateId, { callerAgentAddress: OUTSIDER });
    const checkedIds = readAuthority.mock.calls.map(([id]) => id);
    expect(checkedIds.indexOf(lastPrivateId)).toBeGreaterThanOrEqual(128);

    const owner = await agent.query(markerQuery(lastPrivatePrefix), { callerAgentAddress: OWNER });
    expect(owner.bindings).toEqual([{ g: contextGraphMetaGraphUri(lastPrivateId), s: PRIVATE_MARKER }]);
  });

  it('does not execute SPARQL if access-policy discovery returns a non-bindings result', async () => {
    const { agent, queryExecution } = await fixture();
    const query = agent.store.query.bind(agent.store);
    vi.spyOn(agent.store, 'query').mockImplementation(async (sparql, options) => {
      if (options?.source === 'agent.query.privateGraphAccessPolicy') return { type: 'boolean' as const, value: true };
      return query(sparql, options);
    });
    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER }))
      .rejects.toThrow();
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'graph inventory'] as const)('does not execute SPARQL if %s discovery fails', async (source) => {
    const { agent, queryExecution } = await fixture();
    if (source === 'metadata') {
      vi.spyOn(agent.store, 'query').mockRejectedValue(new Error('metadata discovery unavailable'));
    } else {
      vi.spyOn(agent.store, 'listGraphsByPrefix').mockRejectedValue(new Error('graph inventory discovery unavailable'));
    }
    await expect(agent.query(anyMarkerQuery, { callerAgentAddress: OUTSIDER }))
      .rejects.toThrow('discovery unavailable');
    expect(queryExecution).not.toHaveBeenCalled();
  });
});
