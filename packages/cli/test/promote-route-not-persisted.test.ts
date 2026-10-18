/**
 * Regression coverage for issue #864 — the daemon-side 409
 * `ASSERTION_NOT_PERSISTED` response envelope on the SWM-share verb
 * `POST /api/knowledge-assets/:name/swm/share` (the KA-unified successor
 * of the legacy `POST /api/assertion/:name/promote`).
 *
 * The UI in `packages/node-ui/src/ui/api.ts` (`describePromoteError`)
 * pattern-matches on `code === "ASSERTION_NOT_PERSISTED"` to render
 * the actionable "extracted N triples but the data graph is empty,
 * re-import the source file" copy instead of the misleading "Promoted
 * 0 triples" toast. This test pins the wire contract so a future
 * refactor of the publisher's typed error or the route's catch branch
 * cannot silently change the envelope the UI now depends on.
 *
 * Pattern mirrors `knowledge-assets-route.test.ts`: spin up a real HTTP
 * server with `handleKnowledgeAssetsRoutes`, hand it a minimal mock agent
 * whose `assertion.promote` throws a synthetic error matching what
 * `DKGPublisher.assertionPromote` throws (duck-typed by `name` +
 * `code` — same shape the daemon catch branch matches). No publisher
 * dependency needed: the test asserts the route's translation, not
 * the publisher's throwing logic (the publisher has its own dedicated
 * tests in `packages/publisher/test/draft-lifecycle.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { createServer, type Server } from 'node:http';
import { StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import { classifyExactSwmGraphReplaceFailure } from '../../publisher/test/_helpers/promote-replay-safety.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG_ID = 'issue-864-cg';
const ASSERTION_NAME = 'orphan-assertion';
const ASSERTION_GRAPH = `did:dkg:context-graph:${CG_ID}/main/assertion/did:dkg:agent:test/${ASSERTION_NAME}`;
const EXPECTED_TRIPLE_COUNT = 49;

class FakeAssertionNotPersistedError extends Error {
  readonly name = 'AssertionNotPersistedError';
  readonly code = 'ASSERTION_NOT_PERSISTED';
  readonly contextGraphId: string;
  readonly assertionGraph: string;
  readonly expectedTripleCount: number;
  constructor() {
    super(
      `Assertion data graph <${ASSERTION_GRAPH}> is empty, but its _meta record ` +
        `reports extractionStatus="completed" with structuralTripleCount=${EXPECTED_TRIPLE_COUNT}. ` +
        `The extracted triples were never persisted (or have been deleted) so promote has nothing to move. ` +
        `Re-import the source file or re-write the assertion before promoting.`,
    );
    this.contextGraphId = CG_ID;
    this.assertionGraph = ASSERTION_GRAPH;
    this.expectedTripleCount = EXPECTED_TRIPLE_COUNT;
  }
}

describe('POST /api/knowledge-assets/:name/swm/share — issue #864 not-persisted envelope', () => {
  let server: Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
  });

  async function startWithPromoteImpl(
    promote: (cgId: string, name: string, opts: unknown) => Promise<{
      promotedCount: number;
      sealed?: boolean;
      publishReady?: boolean;
    }>,
  ) {
    const agent = {
      async listContextGraphs() {
        return [{
          id: CG_ID,
          uri: `did:dkg:context-graph:${CG_ID}`,
          name: CG_ID,
          subscribed: true,
          synced: true,
        }];
      },
      async contextGraphExists(cgId: string) {
        return cgId === CG_ID;
      },
      resolveAgentByToken: () => undefined,
      assertion: {
        promote,
      },
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        await handleKnowledgeAssetsRoutes({
          req,
          res,
          agent,
          publisherControl: {},
          publisherRuntime: null,
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

  async function postPromote(body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/knowledge-assets/${ASSERTION_NAME}/swm/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  it('translates AssertionNotPersistedError to a 409 with the structured body the UI expects', async () => {
    await startWithPromoteImpl(async () => {
      throw new FakeAssertionNotPersistedError();
    });

    const res = await postPromote({ contextGraphId: CG_ID, entities: 'all' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      // The publisher's full error message is forwarded so debug
      // tools / curl users get the same explanation the UI builds
      // via `describePromoteError`.
      error: expect.stringContaining('Re-import the source file or re-write the assertion before promoting.'),
      // UI matches on this exact code in `describePromoteError`.
      // Changing the literal here breaks the toast translation.
      code: 'ASSERTION_NOT_PERSISTED',
      contextGraphId: CG_ID,
      assertionGraph: ASSERTION_GRAPH,
      expectedTripleCount: EXPECTED_TRIPLE_COUNT,
    });
  });

  it('also matches when only the .code is set (defensive: ducktype fallback)', async () => {
    // The route's catch branch checks `err?.name === "AssertionNotPersistedError" ||
    // err?.code === "ASSERTION_NOT_PERSISTED"`. Cover the second arm so a
    // future tidy that drops the named class but keeps the code still
    // routes through the structured envelope path.
    await startWithPromoteImpl(async () => {
      const err = new Error('data graph empty, expected 7') as Error & {
        code?: string;
        contextGraphId?: string;
        assertionGraph?: string;
        expectedTripleCount?: number;
      };
      err.code = 'ASSERTION_NOT_PERSISTED';
      err.contextGraphId = CG_ID;
      err.assertionGraph = ASSERTION_GRAPH;
      err.expectedTripleCount = 7;
      throw err;
    });

    const res = await postPromote({ contextGraphId: CG_ID, entities: 'all' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ASSERTION_NOT_PERSISTED',
      contextGraphId: CG_ID,
      assertionGraph: ASSERTION_GRAPH,
      expectedTripleCount: 7,
    });
  });

  it('returns 200 with the publisher result for a normal promote', async () => {
    // Sanity: the new 409 branch must not steal happy-path responses.
    await startWithPromoteImpl(async () => ({ promotedCount: 49 }));

    const res = await postPromote({ contextGraphId: CG_ID, entities: 'all' });

    expect(res.status).toBe(200);
    // KA swm/share wraps the promotedCount in the share envelope.
    expect(res.body).toEqual({ swmShared: true, promotedCount: 49 });
  });

  it('preserves the retryable 503 contract for a committed exact SWM replacement timeout', async () => {
    await startWithPromoteImpl(async () => {
      throw classifyExactSwmGraphReplaceFailure(
        new StoreOperationTimeoutError({
          backend: 'managed-oxigraph',
          operation: 'replaceGraph',
          timeoutMs: 30_000,
          outcome: 'indeterminate',
        }),
      );
    });

    const res = await postPromote({ contextGraphId: CG_ID, entities: 'all' });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'STORE_OPERATION_TIMEOUT',
      retryable: true,
      outcome: 'indeterminate',
      backend: 'managed-oxigraph',
      operation: 'replaceGraph',
      timeoutMs: 30_000,
    });
  });

  it('returns 200 with an explicit non-share outcome when promote moves zero rows', async () => {
    // The publisher returns `{ promotedCount: 0 }` (does NOT throw) when
    // the data graph is empty AND `_meta` either has no extraction
    // record or says structuralTripleCount=0. The route must forward
    // that 200 as-is — the UI's `describePromoteResult` handles the
    // user-facing "nothing to promote" copy. If the route accidentally
    // mapped 0-count to 409, every freshly-created empty draft would
    // light up as "ASSERTION_NOT_PERSISTED".
    await startWithPromoteImpl(async () => ({
      promotedCount: 0,
      sealed: true,
      publishReady: false,
    }));

    const res = await postPromote({ contextGraphId: CG_ID, entities: 'all' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      swmShared: false,
      promotedCount: 0,
      sealed: false,
      publishReady: false,
    });
  });
});
