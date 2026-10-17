/**
 * #3293: a write into a sub-graph that is not registered on the node, and that
 * the graph's peers do not hold either, is refused with HTTP 400 and the code
 * SUB_GRAPH_NOT_FOUND on every write route, never with a 500. Driven over real
 * HTTP against `handleKnowledgeAssetsRoutes` with a minimal fake agent (the
 * pattern of knowledge-assets-1116-share-errors.test.ts); the agent and
 * publisher sides are pinned in their packages
 * (registered-public-sub-graph-first-write.test.ts,
 * sub-graph-registration-resolver.test.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { SubGraphNotFoundError, SUB_GRAPH_NOT_FOUND_CODE } from '@origintrail-official/dkg-publisher';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG_ID = 'issue-3293-cg';
const SUB_GRAPH = 'reports';
const ASSERTION_NAME = 'report-1';
const DETAIL = 'none of the 1 peer(s) of the context graph asked holds it';

function refusal(): SubGraphNotFoundError {
  return new SubGraphNotFoundError(CG_ID, SUB_GRAPH, DETAIL);
}

describe('write into a sub-graph nobody holds (#3293)', () => {
  let server: Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
  });

  async function startWith(agentFields: Record<string, unknown>, fileStore: Record<string, unknown> = {}) {
    const agent = {
      async listContextGraphs() {
        return [{ id: CG_ID, uri: `did:dkg:context-graph:${CG_ID}`, name: CG_ID, subscribed: true, synced: true }];
      },
      async contextGraphExists(cgId: string) {
        return cgId === CG_ID;
      },
      resolveAgentByToken: () => undefined,
      ...agentFields,
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        await handleKnowledgeAssetsRoutes({
          req,
          res,
          agent,
          publisherControl: {},
          publisherState: { runtime: null, availability: { available: false, reason: 'publisher_disabled' } },
          config: {},
          startedAt: Date.now(),
          dashDb: { insertNotification: () => 1 },
          opWallets: {},
          network: {},
          tracker: {},
          memoryManager: {},
          bridgeAuthToken: undefined,
          nodeVersion: 'test',
          nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {},
          fileStore,
          extractionStatus: new Map(),
          assertionImportLocks: new Map(),
          vectorStore: {},
          embeddingProvider: null,
          validTokens: new Set(),
          apiHost: '127.0.0.1',
          apiPortRef: { value: 0 },
          url,
          path: url.pathname,
          requestAgentAddress: 'did:dkg:agent:test',
          authentication: requestAuthentication({ kind: 'anonymous' }),
          emitMemoryGraphChanged: () => {},
          emitNotification: () => {},
        } as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unhandled: ${err?.message ?? err}` }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server!.address();
    if (!addr || typeof addr === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/knowledge-assets${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  async function importFile(subGraphName: string) {
    const boundary = '----dkg-3293';
    const field = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body = field('contextGraphId', CG_ID)
      + field('subGraphName', subGraphName)
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.md"\r\n`
      + 'Content-Type: text/markdown\r\n\r\n# Report\r\n'
      + `--${boundary}--\r\n`;
    const res = await fetch(`${baseUrl}/api/knowledge-assets/${ASSERTION_NAME}/wm/import-file`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  const expectRefusal = (res: { status: number; body: Record<string, unknown> }) => {
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(SUB_GRAPH_NOT_FOUND_CODE);
    expect(String(res.body.error)).toContain(`Sub-graph "${SUB_GRAPH}" has not been registered in context graph "${CG_ID}"`);
    expect(String(res.body.error)).toContain(DETAIL);
  };

  it('POST /api/knowledge-assets answers 400 SUB_GRAPH_NOT_FOUND, not 500', async () => {
    await startWith({
      assertion: {
        history: async () => null,
        create: async () => { throw refusal(); },
      },
    });

    expectRefusal(await post('', {
      contextGraphId: CG_ID,
      name: ASSERTION_NAME,
      subGraphName: SUB_GRAPH,
      quads: [{ subject: 'urn:test:3293', predicate: 'http://schema.org/name', object: '"report"', graph: '' }],
      alsoShareSwm: true,
    }));
  });

  it('wm/write and swm/share answer the same 400', async () => {
    await startWith({
      assertion: {
        history: async () => null,
        create: async () => { throw refusal(); },
        promote: async () => { throw refusal(); },
      },
    });

    expectRefusal(await post(`/${ASSERTION_NAME}/wm/write`, {
      contextGraphId: CG_ID,
      subGraphName: SUB_GRAPH,
      quads: [{ subject: 'urn:test:3293', predicate: 'http://schema.org/name', object: '"report"', graph: '' }],
    }));
    expectRefusal(await post(`/${ASSERTION_NAME}/swm/share`, { contextGraphId: CG_ID, subGraphName: SUB_GRAPH }));
  });

  it('wm/import-file asks the agent to resolve the sub-graph and answers its refusal with 400 SUB_GRAPH_NOT_FOUND', async () => {
    const resolveSubGraphRegistration = vi.fn(async () => ({ registered: false, detail: DETAIL }));
    const put = vi.fn();
    await startWith({ resolveSubGraphRegistration }, { put });

    expectRefusal(await importFile(SUB_GRAPH));
    expect(resolveSubGraphRegistration).toHaveBeenCalledWith(CG_ID, SUB_GRAPH);
    expect(put).not.toHaveBeenCalled();
  });

  it('wm/import-file goes on with a sub-graph the agent resolved', async () => {
    const resolveSubGraphRegistration = vi.fn(async () => ({ registered: true }));
    const put = vi.fn(async () => { throw new Error('file store stopped the test here'); });
    await startWith({ resolveSubGraphRegistration }, { put });

    const res = await importFile(SUB_GRAPH);
    expect(resolveSubGraphRegistration).toHaveBeenCalledWith(CG_ID, SUB_GRAPH);
    expect(put).toHaveBeenCalledOnce();
    expect(res.body.code).not.toBe(SUB_GRAPH_NOT_FOUND_CODE);
  });

  it('wm/import-file answers 500 when the resolution itself fails', async () => {
    await startWith({ resolveSubGraphRegistration: async () => { throw new Error('store unavailable'); } });

    const res = await importFile(SUB_GRAPH);
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain('Failed to verify sub-graph registration: store unavailable');
  });
});
