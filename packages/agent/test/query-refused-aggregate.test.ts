// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { QueryOptions } from '@origintrail-official/dkg-query';
import { DKGAgent } from '../src/dkg-agent.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

const OWNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COUNT = 'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }';
const NO_DATA_COUNT = { bindings: [{ cnt: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] };

/** A node whose engine would answer a count of 4, behind the query method's own read gates. */
function node(overrides: Record<string, unknown> = {}) {
  const query = vi.fn(async (_sparql: string, _options?: QueryOptions) => (
    { bindings: [{ cnt: '"4"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }
  ));
  const store = new OxigraphStore();
  stores.push(store);
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  Object.assign(agent, {
    defaultAgentAddress: OWNER, config: {}, log: { info() {}, warn() {}, debug() {}, error() {} },
    store, queryEngine: { query }, subscribedContextGraphs: new Map(),
    resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed', grantScope: 'public', source: 'system', reason: 'test', metadataBootstrap: 'eligible' }),
    resolveSharedMemoryReadAdmission: async () => ({ outcome: 'allowed' }),
    ...overrides,
  });
  Object.defineProperty(agent, 'peerId', { value: 'RefusedAggregatePeer', configurable: true });
  return { agent, query };
}

// A refused read answers what the query returns over no data. For a count
// that is one row of 0, which is the row the caller reads.
describe('a count the node refuses to read', () => {
  it('reads as a count of nothing when the caller may not read the graph', async () => {
    const { agent, query } = node({
      resolveContextGraphReadAuthority: async () => ({ outcome: 'denied', source: 'registered-chain', reason: 'no-read-authority' }),
    });
    expect(await agent.query(COUNT, { contextGraphId: 'cg-1', view: 'verifiable-memory', callerAgentAddress: OTHER }))
      .toEqual(NO_DATA_COUNT);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads as a count of nothing when shared memory is closed to the caller', async () => {
    const { agent, query } = node({ resolveSharedMemoryReadAdmission: async () => ({ outcome: 'denied' }) });
    expect(await agent.query(COUNT, { contextGraphId: 'cg-1', view: 'shared-working-memory', callerAgentAddress: OTHER }))
      .toEqual(NO_DATA_COUNT);
    expect(query).not.toHaveBeenCalled();
  });

  it('applies SWM admission to attribution metadata even without an SWM view', async () => {
    const { agent, query } = node({ resolveSharedMemoryReadAdmission: async () => ({ outcome: 'denied' }) });
    expect(await agent.query(COUNT, { contextGraphId: 'cg-1', callerAgentAddress: OTHER,
      includeContextGraphPartitions: true, includeSharedMemoryMeta: true })).toEqual(NO_DATA_COUNT);
    expect(query).not.toHaveBeenCalled();
  });

  it('applies shared-memory admission to the typed statistics operation', async () => {
    const admission = vi.fn(async () => ({ outcome: 'denied' }));
    const execute = vi.fn(async () => []);
    const { agent } = node({ resolveSharedMemoryReadAdmission: admission,
      queryEngine: { readContextGraphNamedGraphStats: (_cg: string, _options: unknown,
        gate: import('@origintrail-official/dkg-query').NamedGraphStatsBatchGate) => gate('shared-memory', execute) } });
    expect(await agent.readContextGraphNamedGraphStats('cg-1', { callerAgentAddress: OTHER })).toEqual([]);
    expect(admission).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('forwards metadata expansion only after shared-memory admission succeeds', async () => {
    const admission = vi.fn(async () => ({ outcome: 'allowed' }));
    const { agent, query } = node({ resolveSharedMemoryReadAdmission: admission });
    await agent.query(COUNT, { contextGraphId: 'cg-1', callerAgentAddress: OTHER,
      includeContextGraphPartitions: true, includeSharedMemoryMeta: true });
    expect(admission).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toMatchObject({ includeContextGraphPartitions: true, includeSharedMemoryMeta: true });
  });

  it('preserves caller cancellation rather than presenting it as an empty legacy read', async () => {
    const controller = new AbortController(), reason = new Error('caller cancelled during admission');
    const { agent, query } = node({ resolveSharedMemoryReadAdmission: async () => {
      controller.abort(reason); return { outcome: 'unavailable', error: reason };
    } });
    await expect(agent.query(COUNT, { contextGraphId: 'cg-1', view: 'shared-working-memory',
      callerAgentAddress: OTHER, signal: controller.signal })).rejects.toBe(reason);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads as a count of nothing for another agent\'s working memory', async () => {
    const { agent, query } = node();
    expect(await agent.query(COUNT, { contextGraphId: 'cg-1', view: 'working-memory', callerAgentAddress: OTHER, agentAddress: OWNER }))
      .toEqual(NO_DATA_COUNT);
    expect(query).not.toHaveBeenCalled();
  });

  it('is the engine\'s own answer for a caller who may read', async () => {
    const { agent, query } = node();
    expect(await agent.query(COUNT, { contextGraphId: 'cg-1', view: 'verifiable-memory', callerAgentAddress: OWNER }))
      .toEqual({ bindings: [{ cnt: '"4"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    expect(query).toHaveBeenCalledOnce();
  });
});
