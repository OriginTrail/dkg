// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import type { QueryOptions } from '@origintrail-official/dkg-query';

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
    resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed', source: 'system', reason: 'test', metadataBootstrap: 'eligible' }),
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
