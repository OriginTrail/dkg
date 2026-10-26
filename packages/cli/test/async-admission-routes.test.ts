/**
 * The `async_admission_usage` HTTP figures, end to end through the real knowledge-assets routes:
 * which step answered each async share and async publish request, with what status and code.
 * The daemon's server wiring is reproduced by calling `beginAsyncAdmissionTrace` before the
 * route, as `lifecycle.ts` does; the agent and the publisher control are minimal fakes whose
 * failures stand in for the pre-queue reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { asyncAdmissionUsage } from '@origintrail-official/dkg-core';
import { AsyncLiftJobConflictError } from '@origintrail-official/dkg-publisher';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { beginAsyncAdmissionTrace } from '../src/daemon/async-admission-trace.js';
import { daemonState } from '../src/daemon/state.js';
import type { AsyncPublisherAvailability } from '../src/publisher-runner.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG = 'cg';
const NAME = 'albums';

describe('async admission outcomes by route and phase', () => {
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(() => {
    asyncAdmissionUsage.reset();
    daemonState.promoteWorkerAvailable = true;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  async function start(options: {
    agent?: Record<string, unknown>;
    publisherControl?: Record<string, unknown>;
    availability?: AsyncPublisherAvailability;
  } = {}) {
    const agent = {
      async listContextGraphs() {
        return [{ id: CG, uri: `did:dkg:context-graph:${CG}`, name: CG, subscribed: true, synced: true }];
      },
      async contextGraphExists(contextGraphId: string) {
        return contextGraphId === CG;
      },
      resolveAgentByToken: () => undefined,
      assertion: {
        async promoteAsync() {
          return { jobId: 'share-job-1' };
        },
      },
      ...options.agent,
    };
    const availability = options.availability ?? { available: true };
    const publisherState = availability.available
      ? { runtime: { walletIds: ['0x1111111111111111111111111111111111111111'] }, availability }
      : { runtime: null, availability };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      beginAsyncAdmissionTrace(req.method, url.pathname, res);
      try {
        await handleKnowledgeAssetsRoutes({
          req,
          res,
          agent,
          publisherControl: options.publisherControl ?? {},
          publisherState,
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
          fileStore: {},
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

  async function post(verbPath: string, body: unknown) {
    const res = await fetch(`${baseUrl}/api/knowledge-assets/${NAME}/${verbPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    await res.json().catch(() => null);
    return res.status;
  }

  /** The server records on `close`, which can land just after the client has read the answer. */
  async function recorded(count = 1): Promise<string[]> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const entries = asyncAdmissionUsage.take().http
        .map((e) => `${e.route}/${e.phase}/${e.status}/${e.code}:${e.count}`);
      if (entries.length >= count || Date.now() > deadline) return entries;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const publishBody = { contextGraphId: CG };
  const intent = { shareOperationId: 'op-1', contentScopeVersion: 'v', kaUal: 'did:dkg:x/1', intentKey: 'k' };

  describe('share_async', () => {
    it('answers an unparseable body in the request phase', async () => {
      await start();
      expect(await post('swm/share-async', 'not json')).toBe(400);
      expect(await recorded()).toEqual(['share_async/request/400/-:1']);
    });

    it('answers a missing worker in the request phase with its code', async () => {
      daemonState.promoteWorkerAvailable = false;
      await start();
      expect(await post('swm/share-async', { contextGraphId: CG })).toBe(503);
      expect(await recorded()).toEqual(['share_async/request/503/-:1']);
    });

    it('answers an unknown context graph in the write preflight', async () => {
      await start();
      expect(await post('swm/share-async', { contextGraphId: 'nobody-home' })).toBe(400);
      expect(await recorded()).toEqual(['share_async/write_preflight/400/CONTEXT_GRAPH_NOT_FOUND:1']);
    });

    it('records an accepted share as enqueue', async () => {
      await start();
      expect(await post('swm/share-async', { contextGraphId: CG, entities: 'all' })).toBe(200);
      expect(await recorded()).toEqual(['share_async/enqueue/200/-:1']);
    });

    it('answers an enqueue conflict in the enqueue phase', async () => {
      const { PromoteJobConflictError } = await import('@origintrail-official/dkg-publisher');
      await start({
        agent: {
          assertion: {
            async promoteAsync() {
              throw new PromoteJobConflictError('albums', 'existing-job');
            },
          },
        },
      });
      expect(await post('swm/share-async', { contextGraphId: CG })).toBe(409);
      expect(await recorded()).toEqual(['share_async/enqueue/409/-:1']);
    });
  });

  describe('publish_async', () => {
    it('answers an unavailable publisher in the request phase', async () => {
      await start({
        availability: {
          available: false,
          reason: 'publisher_startup_failed',
          retryable: false,
          operatorActionRequired: true,
        } as AsyncPublisherAvailability,
      });
      expect(await post('vm/publish-async', publishBody)).toBe(503);
      expect(await recorded()).toEqual(['publish_async/request/503/async_publisher_unavailable:1']);
    });

    it('answers a stale intent in intent resolution', async () => {
      await start({
        agent: {
          resolveFinalizedAssertionVmPublishIntent: async () => {
            throw Object.assign(new Error('share changed'), { code: 'PUBLISH_INTENT_STALE' });
          },
        },
      });
      expect(await post('vm/publish-async', publishBody)).toBe(409);
      expect(await recorded()).toEqual(['publish_async/intent_resolution/409/PUBLISH_INTENT_STALE:1']);
    });

    it('answers a stale snapshot, and a busy store, in the snapshot preflight', async () => {
      let failure: unknown = Object.assign(new Error('share snapshot missing'), { code: 'PUBLISH_INTENT_STALE' });
      await start({
        agent: {
          resolveFinalizedAssertionVmPublishIntent: async () => intent,
          preflightKnowledgeAssetVmPublishSnapshot: async () => {
            throw failure;
          },
        },
      });
      expect(await post('vm/publish-async', publishBody)).toBe(409);
      failure = new StoreSchedulerBusyError('queue_full', 'normal', 'query');
      expect(await post('vm/publish-async', publishBody)).toBe(503);

      expect(await recorded(2)).toEqual([
        'publish_async/snapshot_preflight/409/PUBLISH_INTENT_STALE:1',
        'publish_async/snapshot_preflight/503/STORE_SCHEDULER_BUSY:1',
      ]);
    });

    it('answers an enqueue conflict in the enqueue phase', async () => {
      await start({
        agent: {
          resolveFinalizedAssertionVmPublishIntent: async () => intent,
          preflightKnowledgeAssetVmPublishSnapshot: async () => {},
        },
        publisherControl: {
          enqueueKnowledgeAssetVmPublish: async () => {
            throw new AsyncLiftJobConflictError('albums', 'existing-job');
          },
        },
      });
      expect(await post('vm/publish-async', publishBody)).toBe(409);
      expect(await recorded()).toEqual(['publish_async/enqueue/409/-:1']);
    });

    it('records an accepted publish as enqueue', async () => {
      await start({
        agent: {
          resolveFinalizedAssertionVmPublishIntent: async () => intent,
          preflightKnowledgeAssetVmPublishSnapshot: async () => {},
        },
        publisherControl: { enqueueKnowledgeAssetVmPublish: async () => 'job-1' },
      });
      expect(await post('vm/publish-async', publishBody)).toBe(202);
      expect(await recorded()).toEqual(['publish_async/enqueue/202/-:1']);
    });

    it('does not trace the other verbs of the same name', async () => {
      await start({ agent: { assertion: { async promote() { return { promotedCount: 1 }; } } } });
      await post('swm/share', { contextGraphId: CG });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(asyncAdmissionUsage.take().http).toEqual([]);
    });
  });
});
