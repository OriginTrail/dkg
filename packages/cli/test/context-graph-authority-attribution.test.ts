import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, type CanonicalLogRecord } from '@origintrail-official/dkg-core';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const GRAPH = 'private-graph-name';
const CALLER = '0x1111111111111111111111111111111111111111';
const decision = { outcome: 'unavailable', source: 'registered-chain',
  reason: 'chain-access-policy-timeout', dependency: 'chain', metadataBootstrap: 'eligible' };

async function invoke(operation: 'subscribe' | 'unsubscribe', authority: unknown, throws = false) {
  const records: CanonicalLogRecord[] = [];
  Logger.setSink(record => { records.push(record); });
  const agent = { getDefaultAgentAddress: () => CALLER,
    resolveContextGraphOnChainIdReference: async () => ({ kind: 'as-given', contextGraphId: GRAPH }),
    resolveContextGraphIdAlias: () => 'resolved-private-graph',
    resolveContextGraphSubscriptionBootstrapAuthority: async () => { if (throws) throw authority; return authority; },
    subscribeToContextGraph: vi.fn(), unsubscribeFromContextGraph: vi.fn() };
  const path = `/api/context-graph/${operation}`;
  const server = createServer(async (req, res) => {
    try {
      await handleContextGraphRoutes({ req, res, agent, path, url: new URL(path, 'http://localhost'),
        requestAgentAddress: CALLER, authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
        config: {}, catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() } } as any);
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId: GRAPH }), signal: AbortSignal.timeout(5_000),
    });
    const res = { statusCode: response.status, body: await response.text() };
    return { res, headers: Object.fromEntries(response.headers), records, agent };
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

}

afterEach(() => { Logger.setSink(null); vi.restoreAllMocks(); });

describe('subscription authority refusal attribution (#2843)', () => {
  it.each(['subscribe', 'unsubscribe'] as const)('correlates %s refusal to exactly one bounded server-side log', async operation => {
    const { res, headers, records, agent } = await invoke(operation, decision);
    expect(res.statusCode).toBe(503);
    expect(headers['retry-after']).toBe('3');
    expect(JSON.parse(res.body)).toEqual({
      error: 'Context Graph read authority is temporarily unavailable; retry once chain and metadata access recover.',
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE', retryable: true,
    });
    expect(headers['x-dkg-operation-id']).toMatch(/^[a-z0-9-]+$/i);
    const lines = records.filter(line => line.operationId === headers['x-dkg-operation-id']);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toContain(operation === 'subscribe'
      ? 'source=registered-chain reason=chain-access-policy-timeout dependency=chain'
      : 'source=unknown reason=unknown dependency=unknown');
    expect(res.body).not.toContain(GRAPH);
    expect(lines[0]!.message).not.toContain(GRAPH);
    expect(agent.subscribeToContextGraph).not.toHaveBeenCalled();
    expect(agent.unsubscribeFromContextGraph).not.toHaveBeenCalled();
  });

  it.each(['subscribe', 'unsubscribe'] as const)('attributes thrown %s reads without exposing raw errors', async operation => {
    const { res, headers, records } = await invoke(operation, new Error('RPC https://secret@host/private-graph-name'), true);
    expect(res.statusCode).toBe(503);
    expect(headers['x-dkg-operation-id']).toBeTruthy();
    const lines = records.filter(line => line.operationId === headers['x-dkg-operation-id']);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toContain('source=unknown reason=unknown dependency=unknown');
    expect(JSON.stringify(lines)).not.toContain('secret');
    expect(res.body).not.toContain('secret');
  });
});
