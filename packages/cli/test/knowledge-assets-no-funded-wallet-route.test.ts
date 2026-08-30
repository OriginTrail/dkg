/**
 * Wire-contract coverage for the daemon HTTP response when funded-wallet
 * selection finds no operational wallet able to fund a publish.
 *
 * The chain adapter throws `InsufficientPublisherFundsError`
 * (`code: 'NO_FUNDED_PUBLISHER_WALLET'`) and `POST
 * /api/knowledge-assets/:name/vm/publish` must surface it as HTTP **400** with
 * `{ code: 'NO_FUNDED_PUBLISHER_WALLET', error }` (code-first, with a
 * message-marker fallback for a re-wrap that drops `.code`), NOT a generic 500.
 * node-ui's `describeInsufficientPublisherFunds` keys on exactly this contract.
 *
 * Pattern mirrors `promote-route-not-persisted.test.ts`: a real HTTP server
 * with `handleKnowledgeAssetsRoutes` and a minimal mock agent whose
 * `publishFromFinalizedAssertion` throws the funds error — the test asserts the
 * route's translation, not the chain adapter's throwing logic.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';

const CG_ID = 'no-funded-wallet-cg';
const ASSERTION_NAME = 'paid-asset';
const FUNDS_MESSAGE =
  'No operational wallet has enough funds to publish to Verifiable Memory — each publish needs native gas AND TRAC on the same wallet. ' +
  'Operational wallet balances:\n  0xAAA: 0.0 TRAC, 0.0 gas\nFund one of these wallets (run `dkg wallets` to list addresses) and retry the publish.';

describe('POST /api/knowledge-assets/:name/vm/publish — NO_FUNDED_PUBLISHER_WALLET envelope', () => {
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

  async function startWithPublishImpl(
    publishFromFinalizedAssertion: (cgId: string, name: string, opts: unknown) => Promise<unknown>,
  ) {
    const agent = {
      async listContextGraphs() {
        return [{ id: CG_ID, uri: `did:dkg:context-graph:${CG_ID}`, name: CG_ID, subscribed: true, synced: true }];
      },
      async contextGraphExists(cgId: string) {
        return cgId === CG_ID;
      },
      resolveAgentByToken: () => undefined,
      publishFromFinalizedAssertion,
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
          url, path: url.pathname, requestToken: undefined, requestAgentAddress: 'did:dkg:agent:test',
          requestPrincipal: { kind: 'anonymous' },
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
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it('maps a NO_FUNDED_PUBLISHER_WALLET error to HTTP 400 with { code, error } (code-first)', async () => {
    await startWithPublishImpl(async () => {
      const err = new Error(FUNDS_MESSAGE) as Error & { code?: string };
      err.code = 'NO_FUNDED_PUBLISHER_WALLET';
      throw err;
    });

    const res = await postPublish();
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe('NO_FUNDED_PUBLISHER_WALLET');
    expect(res.body?.error).toContain('No operational wallet has enough funds');
  });

  it('maps the funds error to 400 by message marker even when .code is dropped by a re-wrap', async () => {
    await startWithPublishImpl(async () => {
      throw new Error(FUNDS_MESSAGE); // no .code
    });

    const res = await postPublish();
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe('NO_FUNDED_PUBLISHER_WALLET');
    expect(res.body?.error).toContain('No operational wallet has enough funds');
  });
});
