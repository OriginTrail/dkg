// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { QueryOptions } from '@origintrail-official/dkg-query';
import { DKGAgent } from '../src/dkg-agent.js';

const OWNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COUNT = 'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }';
const NO_DATA_COUNT = { bindings: [{ cnt: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] };

/** A node whose engine would answer a count of 4, behind the query method's own read gates. */
function node(overrides: Record<string, unknown> = {}) {
  const query = vi.fn(async (_sparql: string, _options?: QueryOptions) => (
    { bindings: [{ cnt: '"4"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }
  ));
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  Object.assign(agent, {
    defaultAgentAddress: OWNER, config: {}, log: { info() {}, warn() {}, debug() {}, error() {} },
    queryEngine: { query }, subscribedContextGraphs: new Map(),
    resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed', source: 'system', reason: 'test', metadataBootstrap: 'eligible' }),
    canUseSharedMemoryForContextGraph: async () => true,
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
    const { agent, query } = node({ canUseSharedMemoryForContextGraph: async () => false });
    expect(await agent.query(COUNT, { contextGraphId: 'cg-1', view: 'shared-working-memory', callerAgentAddress: OTHER }))
      .toEqual(NO_DATA_COUNT);
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
