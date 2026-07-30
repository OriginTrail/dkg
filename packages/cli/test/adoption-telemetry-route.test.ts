import { describe, expect, it } from 'vitest';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';

describe('manifest install adoption receipt route', () => {
  it('queues the graph-scoped install signal without accepting identity input', async () => {
    const events: unknown[] = [];
    let status = 0;
    let responseBody = '';
    const req = { method: 'POST' } as any;
    const res = {
      writableEnded: false,
      writeHead(nextStatus: number) {
        status = nextStatus;
      },
      end(body?: string) {
        responseBody = body ?? '';
        this.writableEnded = true;
      },
    } as any;
    const url = new URL(
      'http://127.0.0.1/api/context-graph/project%2Falpha/manifest/install-receipt',
    );
    await handleContextGraphRoutes({
        req,
        res,
        agent: { resolveAgentByToken: () => undefined },
        publisherControl: {},
        config: {},
        startedAt: Date.now(),
        dashDb: {},
        opWallets: {},
        network: {},
        tracker: {},
        memoryManager: {},
        bridgeAuthToken: undefined,
        nodeVersion: 'test',
        nodeCommit: 'test',
        catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
        extractionRegistry: {},
        fileStore: {},
        extractionStatus: new Map(),
        assertionImportLocks: new Map(),
        vectorStore: {},
        embeddingProvider: null,
        validTokens: new Set(),
        apiHost: '127.0.0.1',
        apiPortRef: { value: 0 },
        routePlugins: [],
        admission: { inFlight: 0, max: 1, rejectedTotal: 0 },
        url,
        path: url.pathname,
        requestToken: undefined,
        requestAgentAddress: '',
        adoptionTelemetry: {
          enabled: true,
          enqueue: (event) => {
            events.push(event);
            return true;
          },
        },
      } as any);

    expect(status).toBe(202);
    expect(JSON.parse(responseBody)).toEqual({ ok: true, adoptionTracking: 'queued' });
    expect(events).toEqual([{
      type: 'install_completed',
      contextGraphId: 'project/alpha',
    }]);
  });
});
