import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG = 'route-large';
const ROOT = `did:dkg:context-graph:${CG}`;
function fixture(agent: object, body: object = { contextGraphId: CG }, operator = false) {
  const req = Object.assign(new EventEmitter(), { method: 'POST', headers: {}, aborted: false, __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, statusCode: 0, body: '', headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    writeHead(code: number, headers: Record<string, string>) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(body: string) { this.body = body; this.writableEnded = true; },
  });
  const ctx = { req, res, agent, path: '/api/context-graph/memory-layers', url: new URL('http://localhost/api/context-graph/memory-layers'),
    authentication: requestAuthentication(operator ? { kind: 'nodeOperator' } : { kind: 'agent', agentAddress: '0xcaller' }),
  } as unknown as RequestContext;
  return { req, res, ctx };
}

describe('memory-layer route', () => {
  it.each(['denied', 'unavailable'])('does no partition discovery for %s authority', async outcome => {
    const list = vi.fn();
    const authority = vi.fn(async () => ({ outcome }));
    const { ctx, res } = fixture({ resolveContextGraphSubscriptionBootstrapAuthority: authority, listContextGraphQueryPartitions: list });
    await handleContextGraphRoutes(ctx);
    expect(authority).toHaveBeenCalledWith(CG, { callerAgentAddress: '0xcaller', allowSubscriptionFallback: false });
    expect(list).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(outcome === 'denied' ? 200 : 503);
    if (outcome === 'unavailable') {
      expect(res.headers['Retry-After']).toBe('2');
      expect(JSON.parse(res.body)).not.toHaveProperty('contextGraphId');
    } else expect(JSON.parse(res.body).layers.wm.bindings).toEqual([]);
  });

  it.each(['allowed', 'read-denied', 'swm-denied'] as const)('reads through the real agent methods with %s authority', async permission => {
    const store = new OxigraphStore();
    try {
      const wm = `${ROOT}/_working_memory/0xagent/1`;
      const swm = `${ROOT}/_shared_memory/0xagent/1`;
      await store.insert([
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: wm, graph: `${ROOT}/_meta` },
        ...[wm, swm, ROOT].map(graph => ({ subject: `urn:${graph.split('/')[3] ?? 'vm'}`, predicate: 'urn:p', object: '"visible"', graph })),
      ]);
      const engine = new DKGQueryEngine(store);
      // Use the SDK's composed methods; control authority below that boundary.
      const agent = Object.assign(Object.create(DKGAgent.prototype), { store, queryEngine: engine,
        node: { peerId: 'test-node' }, log: { info() {} },
        resolveContextGraphSubscriptionBootstrapAuthority: vi.fn(async () => ({ outcome: 'allowed' })),
        resolveContextGraphReadAuthority: vi.fn(async () => ({ outcome: permission === 'read-denied' ? 'denied' : 'allowed' })),
        canUseSharedMemoryForContextGraph: vi.fn(async () => permission !== 'swm-denied'),
      }) as DKGAgent;
      const query = vi.spyOn(agent, 'query');
      const list = vi.spyOn(agent, 'listContextGraphQueryPartitions');
      const { ctx, res } = fixture(agent);
      await handleContextGraphRoutes(ctx);
      expect(res.statusCode).toBe(200);
      const layers = JSON.parse(res.body).layers;
      expect([layers.wm.bindings.length, layers.swm.bindings.length, layers.vm.bindings.length])
        .toEqual(permission === 'read-denied' ? [0, 0, 0] : [1, permission === 'swm-denied' ? 0 : 1, 1]);
      expect(list).toHaveBeenCalledWith(CG, expect.objectContaining({ callerAgentAddress: '0xcaller' }));
      expect(agent.resolveContextGraphReadAuthority).toHaveBeenCalledWith(CG, expect.objectContaining({ callerAgentAddress: '0xcaller' }));
      if (permission === 'read-denied') {
        expect(query).not.toHaveBeenCalled();
        return;
      }
      expect(agent.canUseSharedMemoryForContextGraph).toHaveBeenCalledWith(CG, expect.objectContaining({ callerAgentAddress: '0xcaller' }));
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls.map(([, options]) => options.includeSharedMemory)).toEqual([false, true, false]);
      for (const [sparql, options] of query.mock.calls) {
        expect(sparql).not.toMatch(/GRAPH\s+\?|\bVALUES\b/i);
        expect(options).toMatchObject({ contextGraphId: CG, exactContextGraphPartitions: true, priority: 'background' });
      }
    } finally { await store.close(); }
  });

  it('cancels an outstanding batch when the client disconnects and removes lifecycle listeners', async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const query = vi.fn((_sparql, options) => new Promise((_resolve, reject) => {
      receivedSignal = options.signal;
      receivedSignal!.addEventListener('abort', () => reject(receivedSignal!.reason), { once: true });
      notifyStarted();
    }));
    const { req, res, ctx } = fixture({ store: {}, query, listContextGraphQueryPartitions: async () => [ROOT] }, undefined, true);
    const running = handleContextGraphRoutes(ctx);
    await started;
    res.destroyed = true;
    res.emit('close');
    await running;
    expect(receivedSignal!.aborted).toBe(true);
    expect(res.body).toBe('');
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it.each([false, true])('returns a public retryable 503 when inventory authority fails (operator=%s)', async operator => {
    const store = new OxigraphStore();
    try {
      const agent = Object.assign(Object.create(DKGAgent.prototype), { store,
        queryEngine: new DKGQueryEngine(store), node: { peerId: 'test-node' }, log: { info() {} },
        resolveContextGraphSubscriptionBootstrapAuthority: vi.fn(async () => ({ outcome: 'allowed' })),
        resolveContextGraphReadAuthority: vi.fn(async () => ({ outcome: 'unavailable', source: 'registered-chain',
          reason: 'internal-chain-roster-failure', dependency: 'private-roster' })),
      }) as DKGAgent;
      const query = vi.spyOn(agent, 'query');
      const list = vi.spyOn(agent, 'listContextGraphQueryPartitions');
      const { ctx, res } = fixture(agent, undefined, operator);
      await handleContextGraphRoutes(ctx);
      expect(list).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.headers['Retry-After']).toBe('3');
      expect(JSON.parse(res.body)).toEqual({
        code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true,
        error: 'Context Graph read authority is temporarily unavailable; retry once chain and metadata access recover.',
      });
      expect(res.body).not.toContain(CG);
      expect(res.body).not.toContain('registered-chain');
      expect(res.body).not.toContain('internal-chain-roster-failure');
    } finally { await store.close(); }
  });
});
