/**
 * GH#3044 — a synchronous publish to a private graph whose recipient
 * authority would not hold still answers a retryable 503, as a share does,
 * instead of a generic 500. The publish has already read it again within its
 * bound; the failure is raised before anything is signed or sent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import {
  createContextGraphAuthorityError,
  createRecipientAuthorityChangedError,
} from '../../agent/src/internal/context-graph-authority/context-graph-authority.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG_ID = 'publish-authority-cg';
const ASSERTION_NAME = 'private-asset';

describe('POST /api/knowledge-assets/:name/vm/publish — a briefly unavailable graph authority', () => {
  let server: Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
  });

  async function startWithPublishFailure(failure: unknown) {
    const agent = {
      async listContextGraphs() {
        return [{ id: CG_ID, uri: `did:dkg:context-graph:${CG_ID}`, name: CG_ID, subscribed: true, synced: true }];
      },
      async contextGraphExists(cgId: string) {
        return cgId === CG_ID;
      },
      resolveAgentByToken: () => undefined,
      publishFromFinalizedAssertion: async () => { throw failure; },
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        await handleKnowledgeAssetsRoutes({
          req, res, agent,
          publisherControl: {}, publisherRuntime: null, config: {}, startedAt: Date.now(),
          dashDb: { insertNotification: () => 1 }, opWallets: {}, network: {}, tracker: {}, memoryManager: {},
          bridgeAuthToken: undefined, nodeVersion: 'test', nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {}, fileStore: {}, extractionStatus: new Map(), assertionImportLocks: new Map(),
          vectorStore: {}, embeddingProvider: null, validTokens: new Set(), apiHost: '127.0.0.1', apiPortRef: { value: 0 },
          url, path: url.pathname, requestAgentAddress: 'did:dkg:agent:test',
          authentication: requestAuthentication({ kind: 'anonymous' }),
          emitMemoryGraphChanged: () => {}, emitNotification: () => {},
        } as any);
        if (!res.writableEnded) { res.statusCode = 404; res.end(); }
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

  async function postPublish() {
    const res = await fetch(`${baseUrl}/api/knowledge-assets/${ASSERTION_NAME}/vm/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId: CG_ID }),
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json().catch(() => null) };
  }

  function daemonEvents(stderr: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
    return stderr.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[DKG-Daemon] '))
      .map((line) => JSON.parse(line.slice('[DKG-Daemon] '.length)));
  }

  it('answers a retryable 503 with Retry-After when the authority moved while recipient keys resolved', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await startWithPublishFailure(createRecipientAuthorityChangedError(CG_ID, 'revision-moved'));

    const res = await postPublish();
    expect(res.status).toBe(503);
    expect(res.retryAfter).toBe('1');
    expect(res.body).toEqual({
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      error: `Context graph "${CG_ID}" private authority changed while recipient keys were resolving`,
      retryable: true,
    });
    expect(daemonEvents(stderr)).toContainEqual({
      event: 'knowledge_asset_publish_authority_unavailable',
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      causeReason: 'chain-participant-authority-unavailable',
      causeSite: 'revision-moved',
      contextGraphId: CG_ID,
      name: ASSERTION_NAME,
    });
  });

  it('answers the 503 for any authority outage that heals on its own, without an endpoint in the text', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await startWithPublishFailure(Object.assign(createContextGraphAuthorityError(
      `Context graph "${CG_ID}" access policy read via https://rpc.internal.example timed out`,
      { reason: 'chain-access-policy-timeout' },
    ), { site: 'not-a-site' }));

    const res = await postPublish();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE', retryable: true });
    expect(res.body.error).toBe(`Context graph "${CG_ID}" access policy read via [rpc] timed out`);
    const [event] = daemonEvents(stderr).filter((logged) => logged.event === 'knowledge_asset_publish_authority_unavailable');
    expect(event).toMatchObject({ causeReason: 'chain-access-policy-timeout' });
    expect(event).not.toHaveProperty('causeSite');
  });

  it('keeps an authority failure that needs a change a server error', async () => {
    await startWithPublishFailure(createContextGraphAuthorityError(
      `Context graph "${CG_ID}" participant authority is invalid`,
      { reason: 'chain-participant-authority-invalid' },
    ));

    const res = await postPublish();
    expect(res.status).toBe(500);
    expect(res.retryAfter).toBeNull();
    expect(res.body).toEqual({ error: `Context graph "${CG_ID}" participant authority is invalid` });
  });
});
