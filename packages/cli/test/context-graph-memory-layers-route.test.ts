import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
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

  it('reads registered partitions through canonical agent queries, preserving normalization and per-layer SWM gating', async () => {
    const store = new OxigraphStore();
    try {
      const wm = `${ROOT}/_working_memory/0xagent/1`;
      const swm = `${ROOT}/_shared_memory/0xagent/1`;
      await store.insert([
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: wm, graph: `${ROOT}/_meta` },
        ...[wm, swm, ROOT].map(graph => ({ subject: `urn:${graph.split('/')[3] ?? 'vm'}`, predicate: 'urn:p', object: '"visible"', graph })),
      ]);
      const engine = new DKGQueryEngine(store);
      const query = vi.fn((sparql, options) => engine.query(sparql, options));
      const { ctx, res } = fixture({ store, query, listContextGraphQueryPartitions: (_cg: string, options: object) => engine.listContextGraphQueryPartitions(CG, options) }, undefined, true);
      await handleContextGraphRoutes(ctx);
      expect(res.statusCode).toBe(200);
      const layers = JSON.parse(res.body).layers;
      expect([layers.wm.bindings.length, layers.swm.bindings.length, layers.vm.bindings.length]).toEqual([1, 1, 1]);
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
});
