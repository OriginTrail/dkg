import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/handle-request.js';

/**
 * GH#2270 follow-up (🔴 3823952704) — who may force-clear a job whose transaction may still land.
 *
 * The by-id clear is the stated exit for a held UPDATE, but `/api/publisher/clear-job` is reachable
 * by every registered agent token and does no ownership check of its own. Widening the predicate
 * for all callers therefore let one agent delete another lifecycle's only chain-recovery record —
 * and if that transaction later landed, or the owner resubmitted, the node could publish twice.
 *
 * Two conditions are required, and these rows pin each one independently.
 */
describe('clear-job pending-transaction override authorization', () => {
  const OWNER = '0xAAaAAa00000000000000000000000000000000Aa';
  const OTHER = '0xBBbBBb00000000000000000000000000000000Bb';

  function post(body: unknown, requestAgentAddress: string) {
    const calls: Array<{ jobId: string; allowPendingTransaction?: boolean }> = [];
    const path = '/api/publisher/clear-job';
    const req = Readable.from([]);
    Object.assign(req, {
      method: 'POST', url: path, headers: { host: '127.0.0.1' },
      __dkgPrebufferedBody: Buffer.from(JSON.stringify(body), 'utf8'),
    });
    const res = {
      statusCode: 0, body: '', writableEnded: false,
      writeHead(status: number) { this.statusCode = status; return this; },
      end(b?: string) { this.body = b ?? ''; this.writableEnded = true; return this; },
    };
    const publisherControl = {
      // The job under test belongs to OWNER.
      getStatus: async () => ({
        status: 'failed',
        request: { knowledgeAssetVmPublish: { agentAddress: OWNER } },
      }),
      clearTerminalJob: async (
        jobId: string,
        options?: { allowPendingTransaction?: boolean },
      ) => {
        calls.push({ jobId, allowPendingTransaction: options?.allowPendingTransaction });
        return { outcome: 'cleared' as const };
      },
    } as unknown as RequestContext['publisherControl'];

    const ctx = {
      req: req as RequestContext['req'],
      res: res as unknown as ServerResponse,
      url: new URL(`http://127.0.0.1${path}`),
      path,
      requestToken: 'dkg_at_test',
      requestAgentAddress,
      publisherControl,
    } as unknown as RequestContext;

    return { run: () => handlePublisherRoutes(ctx), calls, res };
  }

  it('does NOT grant the override to an agent that does not own the job', async () => {
    // The reviewer's scenario: agent B force-clearing agent A's held job.
    const { run, calls } = post({ jobId: 'job-1', allowPendingTransaction: true }, OTHER);
    await run();
    expect(calls).toEqual([{ jobId: 'job-1', allowPendingTransaction: false }]);
  });

  it('grants it to the owning agent that explicitly asks', async () => {
    // The discriminating half — without it, refusing everyone would pass the row above.
    const { run, calls } = post({ jobId: 'job-1', allowPendingTransaction: true }, OWNER);
    await run();
    expect(calls).toEqual([{ jobId: 'job-1', allowPendingTransaction: true }]);
  });

  it('does NOT grant it to the owner who did not ask for it', async () => {
    // Ownership alone is not consent: an ordinary terminal clear must stay ordinary.
    const { run, calls } = post({ jobId: 'job-1' }, OWNER);
    await run();
    expect(calls).toEqual([{ jobId: 'job-1', allowPendingTransaction: false }]);
  });
});
