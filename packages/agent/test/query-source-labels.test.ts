import { describe, expect, it, vi } from 'vitest';
import type {
  ContextGraphIdV1,
  Digest32V1,
  EvmAddressV1,
  NetworkIdV1,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
  type GraphWriteRevisionSource,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { SignedAgentDelegation } from '../src/auth/agent-delegation.js';
import type { DKGAgent } from '../src/dkg-agent.js';
import { JoinRequestMethods } from '../src/dkg-agent-join.js';
import { QueryMethods } from '../src/dkg-agent-query.js';
import { ContextGraphPartitionQueryMethods } from '../src/internal/context-graph-partition-query.js';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { canReadUnscopedQuery } from '../src/unscoped-query-admission.js';
import { resolveRfc64PrivateReadRoster } from '../src/rfc64/private-read-roster-v1.js';
import {
  createRfc64CatalogAccessPolicyRegistryFixture,
} from './support/rfc64-catalog-access-policy-fixture.js';

type ContextGraphQueryStore = Pick<TripleStore, 'query' | 'listGraphs' | 'listGraphsByPrefix'>;

describe('query caller-provided store labels', () => {
  it.each(['allowed', 'denied', 'unavailable'] as const)('admits the public partition inventory with %s caller authority', async outcome => {
    const store = new OxigraphStore();
    const contextGraphId = 'inventory-admission';
    const root = `did:dkg:context-graph:${contextGraphId}`;
    try {
      await store.insert([
        { subject: 'urn:public', predicate: 'urn:p', object: 'urn:o', graph: root },
        { subject: 'urn:private', predicate: 'urn:p', object: 'urn:o', graph: `${root}/_private` },
      ]);
      const queryEngine = new DKGQueryEngine(store);
      const inventory = vi.spyOn(queryEngine, 'listContextGraphQueryPartitions');
      const authority = vi.fn(async () => ({ outcome }));
      const agent = { queryEngine, resolveContextGraphReadAuthority: authority } as unknown as DKGAgent;
      const options = { callerAgentAddress: '0xreader', signal: new AbortController().signal, priority: 'background' as const, source: 'inventory-caller' };
      const result = ContextGraphPartitionQueryMethods.prototype.listContextGraphQueryPartitions.call(agent, contextGraphId, options);
      if (outcome === 'unavailable') await expect(result).rejects.toMatchObject({ code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE' });
      else {
        const graphs = await result;
        if (outcome === 'allowed') {
          expect(graphs).toContain(root);
          expect(graphs).not.toContain(`${root}/_private`);
        } else expect(graphs).toEqual([]);
      }
      expect(authority).toHaveBeenCalledExactlyOnceWith(contextGraphId, {
        ...options, authorityReadMode: 'finalized-index', allowSubscriptionFallback: false,
      });
      if (outcome === 'allowed') expect(inventory).toHaveBeenCalledWith(contextGraphId, options);
      else expect(inventory).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('attributes the unscoped private-graph access-policy lookup', async () => {
    const query = vi.fn<TripleStore['query']>(async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const listGraphsByPrefix = vi.fn(async () => []);
    const store = {
      query,
      listGraphs: vi.fn<ContextGraphQueryStore['listGraphs']>(async () => []),
      listGraphsByPrefix,
    } satisfies ContextGraphQueryStore;

    await expect(
      canReadUnscopedQuery({
        store,
        knownContextGraphIds: [],
        canReadContextGraph: vi.fn(async () => true),
      }),
    ).resolves.toBe(true);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]?.source).toBe(
      'agent.query.privateGraphAccessPolicy',
    );
    expect(listGraphsByPrefix).toHaveBeenCalledWith(
      'did:dkg:context-graph:',
      expect.objectContaining({ source: 'storage.contextGraphOwnerCandidates' }),
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

  it('attributes the already-member delegation refresh state lookup', async () => {
    const query = vi.fn<TripleStore['query']>(async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const delegation = {
      agentAddress: `0x${'22'.repeat(20)}`,
      delegateePeerId: 'carrier-peer',
      issuedAtMs: 1,
    } as SignedAgentDelegation;

    await expect(
      JoinRequestMethods.prototype.assertAlreadyMemberDelegationRefresh.call(
        { store: { query } } as unknown as DKGAgent,
        'delegation-refresh-cg',
        delegation,
        'carrier-peer',
      ),
    ).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]?.source).toBe('agent.delegationRefresh.currentState');
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
    // This fixture has no writers; model the stable local-store capability
    // required across unscoped admission and query execution.
    writeRevisionCoverage: 'all-writers' as const,
    getWriteRevision: vi.fn<GraphWriteRevisionSource['getWriteRevision']>(
      () => ({ generation: 0, stable: true }),
    ),
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
    contextGraphMetaProjection: {
      readAuthorityFactsRevision: 0,
      prepareReadAuthorityFactsSnapshot: vi.fn(async () => ({
        assertCurrent: () => true,
        isAbsent: () => true,
      })),
    },
    prepareContextGraphRegistrationReadPlan: vi.fn(async () => null),
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
  };
  return {
    agent,
    acceptedPolicySnapshot,
    isPrivateContextGraph,
    queryEngine,
    store,
  };
}

describe('minimal RFC-64 private roster authority', () => {
  function fixture() {
    const { acceptedPolicySnapshot } = runtimePrivateQueryAgent();
    const current = acceptedPolicySnapshot(RUNTIME_NETWORK_ID, RUNTIME_PRIVATE_CG)!;
    acceptedPolicySnapshot.mockClear();
    const input = {
      activeNetworkId: RUNTIME_NETWORK_ID as string | undefined,
      acceptedPolicies: undefined,
      service: { acceptedPolicySnapshot },
      isJoinDerived: () => false,
    } satisfies Parameters<typeof resolveRfc64PrivateReadRoster>[0];
    const policies = [{ policyEnvelope: { payload: {
      networkId: RUNTIME_NETWORK_ID, contextGraphId: RUNTIME_PRIVATE_CG, accessPolicy: 1 as const,
    } } }];
    return { input, policies, current, acceptedPolicySnapshot };
  }

  it('returns a frozen accepted roster through only the typed lookup capability', () => {
    const { input, acceptedPolicySnapshot } = fixture();
    const result = resolveRfc64PrivateReadRoster(input, RUNTIME_PRIVATE_CG);
    expect(result).toEqual([LOCAL_MEMBER, REMOTE_MEMBER]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(acceptedPolicySnapshot).toHaveBeenCalledExactlyOnceWith(RUNTIME_NETWORK_ID, RUNTIME_PRIVATE_CG);
  });

  it('keeps unselected authority undefined and configured unavailable authority null', () => {
    const { input, policies } = fixture();
    expect(resolveRfc64PrivateReadRoster({ ...input, service: undefined }, RUNTIME_PRIVATE_CG)).toBeUndefined();
    expect(resolveRfc64PrivateReadRoster({ ...input, service: undefined, acceptedPolicies: policies }, RUNTIME_PRIVATE_CG)).toBeNull();
    expect(resolveRfc64PrivateReadRoster({ ...input, service: undefined, acceptedPolicies: policies }, 'unselected')).toBeUndefined();
  });

  it('distinguishes missing, empty and public rosters', () => {
    const { input, current, acceptedPolicySnapshot } = fixture();
    acceptedPolicySnapshot.mockReturnValue({ ...current, roster: null });
    expect(resolveRfc64PrivateReadRoster(input, RUNTIME_PRIVATE_CG)).toBeNull();
    acceptedPolicySnapshot.mockReturnValue({ ...current, roster: { ...current.roster!, members: [] } });
    expect(resolveRfc64PrivateReadRoster(input, RUNTIME_PRIVATE_CG)).toEqual([]);
    acceptedPolicySnapshot.mockReturnValue({ ...current, policy: { ...current.policy, accessPolicy: 0 } });
    expect(resolveRfc64PrivateReadRoster(input, RUNTIME_PRIVATE_CG)).toBeUndefined();
  });

  it('excludes live join-derived acceptance from the read authority result', () => {
    const { input } = fixture();
    expect(resolveRfc64PrivateReadRoster({ ...input, isJoinDerived: () => true }, RUNTIME_PRIVATE_CG)).toBeUndefined();
  });

  it.each([
    { networkId: ' invalid network ', contextGraphId: RUNTIME_PRIVATE_CG },
    { networkId: RUNTIME_NETWORK_ID, contextGraphId: ' invalid graph ' },
  ])('skips the live lookup for invalid identifiers: $networkId / $contextGraphId', ({ networkId, contextGraphId }) => {
    const { input, acceptedPolicySnapshot } = fixture();
    expect(resolveRfc64PrivateReadRoster({ ...input, activeNetworkId: networkId }, contextGraphId)).toBeUndefined();
    expect(acceptedPolicySnapshot).not.toHaveBeenCalled();
  });

  it('uses configured policy authority after the active-network lookup misses', () => {
    const { input, policies, acceptedPolicySnapshot } = fixture();
    expect(resolveRfc64PrivateReadRoster({ ...input, activeNetworkId: 'otp:1', acceptedPolicies: policies }, RUNTIME_PRIVATE_CG))
      .toEqual([LOCAL_MEMBER, REMOTE_MEMBER]);
    expect(acceptedPolicySnapshot.mock.calls).toEqual([
      ['otp:1', RUNTIME_PRIVATE_CG], [RUNTIME_NETWORK_ID, RUNTIME_PRIVATE_CG],
    ]);
    acceptedPolicySnapshot.mockReturnValue(null);
    expect(resolveRfc64PrivateReadRoster({ ...input, acceptedPolicies: policies }, RUNTIME_PRIVATE_CG)).toBeNull();
  });
});

describe('runtime-accepted RFC-64 private query authorization', () => {
  it('does not execute SPARQL when unscoped read authority throws', async () => {
    const fixture = runtimePrivateQueryAgent();
    const authorityFailure = new Error('authority lookup failed');
    fixture.acceptedPolicySnapshot.mockImplementation(() => { throw authorityFailure; });

    await expect(QueryMethods.prototype.query.call(
      fixture.agent as never,
      'ASK { GRAPH ?g { ?s ?p ?o } }',
      { callerAgentAddress: OUTSIDER },
    )).rejects.toBe(authorityFailure);
    expect(fixture.acceptedPolicySnapshot).toHaveBeenCalledWith(
      RUNTIME_NETWORK_ID,
      RUNTIME_PRIVATE_CG,
    );
    expect(fixture.queryEngine.query).not.toHaveBeenCalled();
  });

  it('uses a live private roster for scoped VM reads without bootstrap config', async () => {
    const fixture = runtimePrivateQueryAgent();
    expect(fixture.agent.config).not.toHaveProperty('rfc64CatalogBootstrap');
    expect(fixture.agent).not.toHaveProperty(
      'hasAcceptedRfc64PublicUnregisteredAuthorityV1',
    );

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
      expect.objectContaining({ source: 'storage.contextGraphOwnerCandidates' }),
    );
    expect(fixture.isPrivateContextGraph).not.toHaveBeenCalled();
  });
});
