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
      expect.objectContaining({ source: 'agent.query.rfc64RuntimePrivateGraphs' }),
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

describe('unscoped query authority concurrency', () => {
  const contextGraphIds = Array.from({ length: 10 }, (_, index) => `authority-candidate-${index}`);

  function authorityAgent(canReadContextGraph: (
    contextGraphId: string,
    options?: { callerAgentAddress?: string; signal?: AbortSignal },
  ) => Promise<boolean>) {
    return {
      config: {},
      subscribedContextGraphs: new Map(contextGraphIds.map((id) => [id, { synced: true }])),
      store: {
        query: vi.fn<TripleStore['query']>(async () => ({ type: 'bindings', bindings: [] })),
        listGraphsByPrefix: vi.fn<NonNullable<TripleStore['listGraphsByPrefix']>>(async () => []),
      },
      log: { info() {} },
      queryEngine: { query: vi.fn(async () => ({ bindings: [{ value: 'visible' }] })) },
      canReadContextGraph,
      getDisallowedGraphPrefixes: QueryMethods.prototype.getDisallowedGraphPrefixes,
      sparqlReferencesPrivateGraphs: QueryMethods.prototype.sparqlReferencesPrivateGraphs,
    };
  }

  it('checks at most four candidates together and retains denial order after out-of-order completion', async () => {
    const gates = contextGraphIds.map(() => {
      let resolve!: (allowed: boolean) => void;
      const promise = new Promise<boolean>((done) => { resolve = done; });
      return { promise, resolve };
    });
    let active = 0;
    let maximumActive = 0;
    const completed: string[] = [];
    const canReadContextGraph = vi.fn(async (id: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const allowed = await gates[contextGraphIds.indexOf(id)].promise;
      active -= 1;
      completed.push(id);
      return allowed;
    });
    const agent = authorityAgent(canReadContextGraph);
    const pending = QueryMethods.prototype.getDisallowedGraphPrefixes.call(agent as never);

    try {
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(4));
      expect(active).toBe(4);
      for (const index of [3, 2, 1, 0]) gates[index].resolve(index % 2 === 1);
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(8));
      expect(active).toBe(4);
      for (const index of [7, 6, 5, 4]) gates[index].resolve(index % 2 === 1);
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(10));
      for (const index of [9, 8]) gates[index].resolve(index % 2 === 1);

      await expect(pending).resolves.toEqual(
        contextGraphIds.filter((_, index) => index % 2 === 0)
          .map((id) => `did:dkg:context-graph:${id}`),
      );
      expect(maximumActive).toBe(4);
      expect(active).toBe(0);
      expect(completed).not.toEqual(contextGraphIds);
    } finally {
      // Also release outstanding work when an assertion rejects a regression.
      for (const gate of gates) gate.resolve(true);
      await pending;
    }
  });

  it('rejects before query execution if any candidate authority check throws', async () => {
    const authorityFailure = new Error('authority lookup failed');
    const canReadContextGraph = vi.fn(async (id: string) => {
      if (id === contextGraphIds[6]) throw authorityFailure;
      return true;
    });
    const agent = authorityAgent(canReadContextGraph);

    await expect(QueryMethods.prototype.query.call(
      agent as never,
      'ASK { GRAPH ?g { ?s ?p ?o } }',
      { callerAgentAddress: '0x00000000000000000000000000000000000000ff' },
    )).rejects.toBe(authorityFailure);
    expect(agent.queryEngine.query).not.toHaveBeenCalled();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  const unscopedQuery = 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }';
  const callerAgentAddress = '0x00000000000000000000000000000000000000ff';

  it('rejects 1000 per-KA graphs before any authority lookup instead of truncating possible owners', async () => {
    const canReadContextGraph = vi.fn(async () => true);
    const agent = authorityAgent(canReadContextGraph);
    agent.subscribedContextGraphs.clear();
    agent.subscribedContextGraphs.set('public-cg', { synced: true });
    agent.store.listGraphsByPrefix.mockResolvedValue(Array.from({ length: 1000 }, (_, index) => (
      `did:dkg:context-graph:public-cg/_verifiable_memory/${callerAgentAddress}/${index + 1}`
    )));

    // Each KA path can also denote a persisted legacy root. The 512-owner
    // admission budget must reject the entire inventory before live checks.
    await expect(QueryMethods.prototype.query.call(
      agent as never, unscopedQuery, { callerAgentAddress },
    )).rejects.toThrow('owner candidate limit exceeded');
    expect(canReadContextGraph).not.toHaveBeenCalled();
    expect(agent.queryEngine.query).not.toHaveBeenCalled();
  });

  it('does no discovery when the unscoped caller is already aborted', async () => {
    const canReadContextGraph = vi.fn(async () => true);
    const agent = authorityAgent(canReadContextGraph);
    const controller = new AbortController();
    controller.abort(new Error('caller disconnected'));

    await expect(QueryMethods.prototype.query.call(
      agent as never, unscopedQuery, { callerAgentAddress, signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError', message: 'caller disconnected' });
    expect(agent.store.query).not.toHaveBeenCalled();
    expect(agent.store.listGraphsByPrefix).not.toHaveBeenCalled();
    expect(canReadContextGraph).not.toHaveBeenCalled();
    expect(agent.queryEngine.query).not.toHaveBeenCalled();
  });

  it('signals all four active checks on caller abort and schedules no more after late success', async () => {
    const gates = contextGraphIds.map(() => deferred<boolean>());
    const receivedSignals: AbortSignal[] = [];
    const observedAborts: string[] = [];
    const canReadContextGraph = vi.fn(async (id: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) {
        receivedSignals.push(options.signal);
        options.signal.addEventListener('abort', () => { observedAborts.push(id); }, { once: true });
      }
      // Intentionally ignore cancellation until released: the admission boundary
      // must not depend on every authority implementation settling promptly.
      return gates[contextGraphIds.indexOf(id)].promise;
    });
    const agent = authorityAgent(canReadContextGraph);
    const controller = new AbortController();
    const pending = QueryMethods.prototype.query.call(
      agent as never, unscopedQuery, { callerAgentAddress, signal: controller.signal },
    );
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });

    try {
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(4));
      expect(receivedSignals).toHaveLength(4);
      controller.abort(new Error('caller disconnected'));
      await vi.waitFor(() => expect(failure).toMatchObject({ name: 'AbortError', message: 'caller disconnected' }));
      expect(observedAborts).toEqual(contextGraphIds.slice(0, 4));
      expect(receivedSignals.every((signal) => signal.aborted)).toBe(true);
      for (const gate of gates) gate.resolve(true);
      await observed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
      expect(agent.queryEngine.query).not.toHaveBeenCalled();
    } finally {
      for (const gate of gates) gate.resolve(true);
      await observed;
    }
  });

  it('bounds the entire authority admission to five seconds and stops checks after late success', async () => {
    vi.useFakeTimers();
    const gates = contextGraphIds.map(() => deferred<boolean>());
    const receivedSignals: AbortSignal[] = [];
    const canReadContextGraph = vi.fn(async (id: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) receivedSignals.push(options.signal);
      return gates[contextGraphIds.indexOf(id)].promise;
    });
    const agent = authorityAgent(canReadContextGraph);
    const pending = QueryMethods.prototype.query.call(agent as never, unscopedQuery, { callerAgentAddress });
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(4999);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toMatchObject({ code: 'BOUNDED_OPERATION_TIMEOUT', timeoutMs: 5000 });
      expect(receivedSignals).toHaveLength(4);
      expect(receivedSignals.every((signal) => signal.aborted)).toBe(true);
      for (const gate of gates) gate.resolve(true);
      await observed;
      await vi.advanceTimersByTimeAsync(0);
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
      expect(agent.queryEngine.query).not.toHaveBeenCalled();
    } finally {
      for (const gate of gates) gate.resolve(true);
      await observed;
      vi.useRealTimers();
    }
  });

  it.each(['ontology', 'inventory'] as const)('includes blocked %s discovery in the five-second admission deadline', async (stage) => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const canReadContextGraph = vi.fn(async () => true);
    const agent = authorityAgent(canReadContextGraph);
    let discoverySignal: AbortSignal | undefined;
    if (stage === 'ontology') {
      agent.store.query.mockImplementation(async (_sparql, options) => {
        discoverySignal = options?.signal;
        await gate.promise;
        return { type: 'bindings', bindings: [] };
      });
    } else {
      agent.store.listGraphsByPrefix.mockImplementation(async (_prefix, options) => {
        discoverySignal = options?.signal;
        await gate.promise;
        return [];
      });
    }
    const pending = QueryMethods.prototype.query.call(agent as never, unscopedQuery, { callerAgentAddress });
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });

    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(failure).toMatchObject({ code: 'BOUNDED_OPERATION_TIMEOUT', timeoutMs: 5000 });
      expect(discoverySignal?.aborted).toBe(true);
      expect(canReadContextGraph).not.toHaveBeenCalled();
      gate.resolve();
      await observed;
      await vi.advanceTimersByTimeAsync(0);
      if (stage === 'ontology') expect(agent.store.listGraphsByPrefix).not.toHaveBeenCalled();
      expect(canReadContextGraph).not.toHaveBeenCalled();
      expect(agent.queryEngine.query).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await observed;
      vi.useRealTimers();
    }
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
      expect.objectContaining({ source: 'agent.query.rfc64RuntimePrivateGraphs' }),
    );
    expect(fixture.isPrivateContextGraph).not.toHaveBeenCalled();
  });
});
