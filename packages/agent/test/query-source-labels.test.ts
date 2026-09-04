import { describe, expect, it, vi } from 'vitest';
import type {
  ContextGraphIdV1,
  Digest32V1,
  EvmAddressV1,
  NetworkIdV1,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { QueryMethods } from '../src/dkg-agent-query.js';
import {
  createRfc64CatalogAccessPolicyRegistryFixture,
} from './support/rfc64-catalog-access-policy-fixture.js';

describe('query caller-provided store labels', () => {
  it('attributes the unscoped private-graph access-policy lookup', async () => {
    const query = vi.fn<TripleStore['query']>(async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const listGraphsByPrefix = vi.fn(async () => []);
    const store = { query, listGraphsByPrefix } as unknown as TripleStore;

    await expect(
      QueryMethods.prototype.getDisallowedGraphPrefixes.call(
        {
          store,
          config: {},
          subscribedContextGraphs: new Map(),
        } as never,
      ),
    ).resolves.toEqual([]);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]?.source).toBe(
      'agent.query.privateGraphAccessPolicy',
    );
    expect(listGraphsByPrefix).toHaveBeenCalledWith(
      'did:dkg:context-graph:',
      { source: 'agent.query.rfc64RuntimePrivateGraphs' },
    );
  });

  it('forwards caller attribution through context-graph enumeration', async () => {
    const listGraphsByPrefix = vi.fn(async () => []);
    const store = {
      listGraphsByPrefix,
    } as unknown as TripleStore;

    await expect(
      new GraphManager(store).listContextGraphs({
        source: 'agent.swmHostMode.listContextGraphs',
      }),
    ).resolves.toEqual([]);

    expect(listGraphsByPrefix).toHaveBeenCalledWith(
      'did:dkg:context-graph:',
      { source: 'agent.swmHostMode.listContextGraphs' },
    );
  });
});

const RUNTIME_NETWORK_ID = 'otp:20430' as NetworkIdV1;
const RUNTIME_GENESIS_NETWORK_ID = '7449c543ff04a550b2dafa999fe8ee577a00b212023bb4d4244e8d58a4792c7b';
const RUNTIME_PRIVATE_CG = 'runtime-private-query' as ContextGraphIdV1;
const RUNTIME_POLICY_DIGEST = `0x${'31'.repeat(32)}` as Digest32V1;
const LOCAL_MEMBER = `0x${'11'.repeat(20)}` as EvmAddressV1;
const REMOTE_MEMBER = `0x${'22'.repeat(20)}` as EvmAddressV1;
const OUTSIDER = `0x${'33'.repeat(20)}` as EvmAddressV1;

function runtimePrivateQueryAgent(options: {
  readonly subscribed?: boolean;
  readonly storedContextGraph?: boolean;
} = {}) {
  const registry = createRfc64CatalogAccessPolicyRegistryFixture({
    localAgentAddress: LOCAL_MEMBER,
    remoteAgentAddress: REMOTE_MEMBER,
    networkId: RUNTIME_NETWORK_ID,
    contextGraphId: RUNTIME_PRIVATE_CG,
    accessPolicy: 1,
    publishPolicy: 1,
    policyDigest: RUNTIME_POLICY_DIGEST,
    ownerAddress: LOCAL_MEMBER,
    curatorAddress: LOCAL_MEMBER,
  });
  const acceptedPolicySnapshot = vi.fn((
    networkId: NetworkIdV1,
    contextGraphId: ContextGraphIdV1,
  ) => registry.lookup(networkId, contextGraphId));
  const queryEngine = {
    query: vi.fn(async () => ({ bindings: [{ value: 'visible' }] })),
  };
  const store = {
    query: vi.fn(async () => ({ type: 'bindings', bindings: [] })),
    listGraphsByPrefix: vi.fn(async () => (
      options.storedContextGraph === true
        ? [`did:dkg:context-graph:${RUNTIME_PRIVATE_CG}`]
        : []
    )),
  };
  const isPrivateContextGraph = vi.fn(async () => {
    throw new Error('legacy private metadata must not decide runtime RFC-64 authority');
  });
  const agent = {
    config: {
      networkIdentity: {
        networkId: RUNTIME_GENESIS_NETWORK_ID,
        chainId: RUNTIME_NETWORK_ID,
      },
      rfc64CatalogAccessPolicyAuthority: { localAgentAddress: LOCAL_MEMBER },
    },
    defaultAgentAddress: LOCAL_MEMBER,
    peerId: 'peer-runtime-private-query',
    chain: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    queryEngine,
    store,
    subscribedContextGraphs: options.subscribed === false
      ? new Map()
      : new Map([[RUNTIME_PRIVATE_CG, { synced: true }]]),
    rfc64PublicCatalogServiceV1: { acceptedPolicySnapshot },
    isPrivateContextGraph,
    getContextGraphAllowedPeers: vi.fn(async () => null),
    resolveRegisteredContextGraphAuthority: vi.fn(async () => ({ kind: 'unregistered' as const })),
    isAgentAddressAllowed: QueryMethods.prototype.isAgentAddressAllowed,
    resolveRfc64PrivateReadRosterV1:
      QueryMethods.prototype.resolveRfc64PrivateReadRosterV1,
    resolveContextGraphReadAuthority:
      QueryMethods.prototype.resolveContextGraphReadAuthority,
    canReadContextGraph: QueryMethods.prototype.canReadContextGraph,
    getDisallowedGraphPrefixes: QueryMethods.prototype.getDisallowedGraphPrefixes,
    sparqlReferencesPrivateGraphs: QueryMethods.prototype.sparqlReferencesPrivateGraphs,
  };
  return {
    agent,
    acceptedPolicySnapshot,
    isPrivateContextGraph,
    queryEngine,
    store,
  };
}

describe('runtime-accepted RFC-64 private query authorization', () => {
  it('uses a live private roster for scoped VM reads without bootstrap config', async () => {
    const fixture = runtimePrivateQueryAgent();
    expect(fixture.agent.config).not.toHaveProperty('rfc64CatalogBootstrap');

    const member = await QueryMethods.prototype.query.call(
      fixture.agent as never,
      'SELECT ?s WHERE { ?s ?p ?o }',
      {
        contextGraphId: RUNTIME_PRIVATE_CG,
        view: 'verifiable-memory',
        callerAgentAddress: REMOTE_MEMBER,
      },
    );
    expect(member.bindings).toEqual([{ value: 'visible' }]);

    const outsider = await QueryMethods.prototype.query.call(
      fixture.agent as never,
      'SELECT ?s WHERE { ?s ?p ?o }',
      {
        contextGraphId: RUNTIME_PRIVATE_CG,
        view: 'verifiable-memory',
        callerAgentAddress: OUTSIDER,
      },
    );
    expect(outsider.bindings).toEqual([]);
    expect(fixture.queryEngine.query).toHaveBeenCalledTimes(1);
    expect(fixture.isPrivateContextGraph).not.toHaveBeenCalled();
    expect(fixture.acceptedPolicySnapshot).toHaveBeenCalledWith(
      RUNTIME_NETWORK_ID,
      RUNTIME_PRIVATE_CG,
    );
  });

  it('filters a runtime-only private subscription from outsider unscoped reads', async () => {
    const fixture = runtimePrivateQueryAgent();
    const sparql = `SELECT ?s WHERE { GRAPH <did:dkg:context-graph:${RUNTIME_PRIVATE_CG}/_verifiable_memory> { ?s ?p ?o } }`;

    const member = await QueryMethods.prototype.query.call(
      fixture.agent as never,
      sparql,
      { callerAgentAddress: REMOTE_MEMBER },
    );
    expect(member.bindings).toEqual([{ value: 'visible' }]);

    const outsider = await QueryMethods.prototype.query.call(
      fixture.agent as never,
      sparql,
      { callerAgentAddress: OUTSIDER },
    );
    expect(outsider.bindings).toEqual([]);
    expect(fixture.queryEngine.query).toHaveBeenCalledTimes(1);
    expect(fixture.store.query).toHaveBeenCalledTimes(2);
    expect(fixture.isPrivateContextGraph).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'ASK',
      sparql: 'ASK { GRAPH ?g { ?s ?p ?o } }',
      expected: { bindings: [{ result: 'false' }] },
    },
    {
      label: 'COUNT',
      sparql: 'SELECT (COUNT(*) AS ?count) WHERE { GRAPH ?g { ?s ?p ?o } }',
      expected: { bindings: [] },
    },
    {
      label: 'SELECT',
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      expected: { bindings: [] },
    },
  ])('fails closed before query execution for a truly unscoped outsider $label query', async ({
    sparql,
    expected,
  }) => {
    const fixture = runtimePrivateQueryAgent();

    await expect(QueryMethods.prototype.query.call(
      fixture.agent as never,
      sparql,
      { callerAgentAddress: OUTSIDER },
    )).resolves.toEqual(expected);
    expect(fixture.queryEngine.query).not.toHaveBeenCalled();
    expect(fixture.isPrivateContextGraph).not.toHaveBeenCalled();
  });

  it('uses storage discovery to protect a runtime-only private graph without a subscription', async () => {
    const fixture = runtimePrivateQueryAgent({
      subscribed: false,
      storedContextGraph: true,
    });
    const sparql = 'SELECT ?s WHERE { ?s ?p ?o }';

    const member = await QueryMethods.prototype.query.call(
      fixture.agent as never,
      sparql,
      { callerAgentAddress: REMOTE_MEMBER },
    );
    expect(member.bindings).toEqual([{ value: 'visible' }]);

    const outsider = await QueryMethods.prototype.query.call(
      fixture.agent as never,
      sparql,
      { callerAgentAddress: OUTSIDER },
    );
    expect(outsider.bindings).toEqual([]);
    expect(fixture.queryEngine.query).toHaveBeenCalledTimes(1);
    expect(fixture.store.listGraphsByPrefix).toHaveBeenCalledWith(
      'did:dkg:context-graph:',
      { source: 'agent.query.rfc64RuntimePrivateGraphs' },
    );
    expect(fixture.isPrivateContextGraph).not.toHaveBeenCalled();
  });
});
