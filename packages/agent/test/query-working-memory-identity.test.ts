// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { DKGQueryEngine, type QueryOptions } from '@origintrail-official/dkg-query';
import { markCoreTrustedGraph } from '../src/public-snapshot-evidence.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

const A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PEER = 'LegacyPeer';
function node(defaultAgentAddress: string | undefined = A) {
  const query = vi.fn(async (_sparql: string, _options?: QueryOptions) => ({ bindings: [{ value: 'visible' }] }));
  const store = new OxigraphStore();
  stores.push(store);
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  Object.assign(agent, {
    defaultAgentAddress, config: {}, log: { info() {}, warn() {}, debug() {}, error() {} },
    store, queryEngine: { query }, subscribedContextGraphs: new Map(),
    resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed', grantScope: 'public', source: 'system', reason: 'test', metadataBootstrap: 'eligible' }),
    canReadContextGraph: async () => true, isPrivateContextGraph: async () => false,
    listPrivateContextGraphIdsNotReadableBy: async () => [],
  });
  Object.defineProperty(agent, 'peerId', { value: PEER, configurable: true });
  return { agent, query };
}
const sparql = 'SELECT ?s WHERE { ?s ?p ?o }';
describe('agent-owned working-memory identity aliases', () => {
  it.each([
    ['default caller omitted target', A, undefined, PEER, [A]],
    ['default target retains case', A.toLowerCase(), A.toUpperCase(), A.toUpperCase(), [PEER]],
    ['legacy text target remains case-insensitive', A, PEER.toLowerCase(), PEER.toLowerCase(), [A]],
    ['co-tenant omitted target stays private', B, undefined, B, undefined],
    ['unauthenticated default stays wallet-first', undefined, undefined, A, [PEER]],
  ] as const)('%s', async (_name, callerAgentAddress, agentAddress, expectedAddress, aliases) => {
    const fixture = node();
    await fixture.agent.query(sparql, { contextGraphId: 'cg-1', view: 'working-memory', callerAgentAddress, agentAddress });
    expect(fixture.query).toHaveBeenCalledOnce();
    expect(fixture.query.mock.calls[0][1]).toMatchObject({ agentAddress: expectedAddress });
    expect(fixture.query.mock.calls[0][1]?.agentAddressAliases).toEqual(aliases);
  });
  it.each([[B, A], [B, PEER], [A, B]] as const)('denies caller %s targeting %s', async (callerAgentAddress, agentAddress) => {
    const fixture = node();
    expect(await fixture.agent.query(sparql, { contextGraphId: 'cg-1', view: 'working-memory', callerAgentAddress, agentAddress })).toEqual({ bindings: [] });
    expect(fixture.query).not.toHaveBeenCalled();
  });
  it('falls back to the peer when no default wallet exists', async () => {
    const fixture = node(undefined);
    // Default parameters are intentionally bypassed for this historical mode.
    Object.assign(fixture.agent, { defaultAgentAddress: undefined });
    await fixture.agent.query(sparql, { contextGraphId: 'cg-1', view: 'working-memory' });
    expect(fixture.query.mock.calls[0][1]).toMatchObject({ agentAddress: PEER });
    expect(fixture.query.mock.calls[0][1]?.agentAddressAliases).toBeUndefined();
  });
});

it.each([
  [undefined, [A, PEER]], [A, [A, PEER]], [PEER, [PEER, A]], [B, [B]],
] as const)('shares draft policy across query, inventory and statistics for %s', async (caller, owners) => {
  const { agent, query } = node();
  const inventory = vi.fn(async () => []);
  const statistics = vi.fn(async () => []);
  Object.assign(agent.queryEngine, { listContextGraphQueryPartitionReads: inventory, readContextGraphNamedGraphStats: statistics });
  await agent.query(sparql, { contextGraphId: 'cg-1', callerAgentAddress: caller });
  await agent.listContextGraphQueryPartitionReads('cg-1', { callerAgentAddress: caller });
  await agent.readContextGraphNamedGraphStats('cg-1', { callerAgentAddress: caller });
  const expected = { kind: 'owners', owners };
  expect(query.mock.calls[0][1]?.draftAccess).toEqual(expected);
  expect(inventory).toHaveBeenCalledWith('cg-1', expect.objectContaining({ draftAccess: expected }));
  expect(statistics).toHaveBeenCalledWith('cg-1', expect.objectContaining({ draftAccess: expected }), expect.any(Function));
});
it('keeps explicit draft exclusion on ordinary queries', async () => {
  const { agent, query } = node();
  await agent.query(sparql, { contextGraphId: 'cg-1', callerAgentAddress: A, excludeWorkingMemoryPartitions: true });
  expect(query.mock.calls[0][1]?.draftAccess).toEqual({ kind: 'none' });
});


it.each(['readable', 'trust-changes', 'cancelled'] as const)('runs real named-graph statistics with agent guards: %s', async mode => {
  const { agent } = node();
  const graph = 'did:dkg:context-graph:stats-agent/_verifiable_memory/a/1';
  await agent.store.insert([1, 2].map(i => ({ subject: 'urn:entity', predicate: `urn:p:${i}`, object: '"value"', graph })));
  Object.assign(agent, { queryEngine: new DKGQueryEngine(agent.store) });
  const controller = new AbortController(), reason = new Error('caller cancelled after aggregate');
  const originalQuery = agent.store.query.bind(agent.store);
  const reads = vi.spyOn(agent.store, 'query').mockImplementation(async (sparql, options) => {
    const result = await originalQuery(sparql, options);
    if (sparql.includes('COUNT(DISTINCT ?s)')) {
      if (mode === 'trust-changes') await markCoreTrustedGraph(agent.store, 'stats-agent');
      if (mode === 'cancelled') controller.abort(reason);
    }
    return result;
  });
  const stats = agent.readContextGraphNamedGraphStats('stats-agent', { callerAgentAddress: A,
    signal: controller.signal, priority: 'normal', source: 'test.stats-agent' });
  if (mode === 'trust-changes') await expect(stats).rejects.toMatchObject({ code: 'CORE_CACHE_QUERY_TRUST_REQUIRED' });
  else if (mode === 'cancelled') await expect(stats).rejects.toBe(reason);
  else await expect(stats).resolves.toContainEqual({ graph, entityCount: 1, tripleCount: 2 });
  expect(reads.mock.calls.filter(([sparql]) => sparql.includes('COUNT(DISTINCT ?s)'))).toHaveLength(1);
});


it.each(['inventory', 'statistics'] as const)('refuses node-only authority for an unrelated %s caller before store reads', async mode => {
  const { agent } = node();
  Object.assign(agent, { resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed', grantScope: 'node' }) });
  const inventory = vi.fn(async () => []), statistics = vi.fn(async () => []);
  Object.assign(agent.queryEngine, { listContextGraphQueryPartitionReads: inventory, readContextGraphNamedGraphStats: statistics });
  expect(await (mode === 'inventory' ? agent.listContextGraphQueryPartitionReads('private', { callerAgentAddress: B })
    : agent.readContextGraphNamedGraphStats('private', { callerAgentAddress: B }))).toEqual([]);
  expect(inventory).not.toHaveBeenCalled(); expect(statistics).not.toHaveBeenCalled();
});

it.each(['trusted-node', 'caller-downgraded'] as const)('checks caller scope for statistics batches: %s', async mode => {
  const { agent } = node();
  const graph = 'did:dkg:context-graph:stats-scope/_verifiable_memory/a/1';
  await agent.store.insert([{ subject: 'urn:entity', predicate: 'urn:p', object: '"value"', graph }]);
  const authority = vi.fn().mockResolvedValue({ outcome: 'allowed', grantScope: 'node' });
  if (mode === 'caller-downgraded') authority.mockResolvedValueOnce({ outcome: 'allowed', grantScope: 'caller' });
  Object.assign(agent, { queryEngine: new DKGQueryEngine(agent.store), resolveContextGraphReadAuthority: authority });
  const reads = vi.spyOn(agent.store, 'query');
  const callerAgentAddress = mode === 'trusted-node' ? undefined : B;
  const result = await agent.readContextGraphNamedGraphStats('stats-scope', { callerAgentAddress });
  const aggregates = reads.mock.calls.filter(([sparql]) => sparql.includes('COUNT(DISTINCT ?s)'));
  if (mode === 'trusted-node') {
    expect(result).toContainEqual({ graph, entityCount: 1, tripleCount: 1 });
    expect(aggregates).toHaveLength(1);
    expect(await agent.listContextGraphQueryPartitionReads('stats-scope')).toContainEqual(expect.objectContaining({ graph }));
  } else { expect(result).toEqual([]); expect(aggregates).toHaveLength(0); }
  expect(authority.mock.calls.length).toBeGreaterThanOrEqual(2);
});
