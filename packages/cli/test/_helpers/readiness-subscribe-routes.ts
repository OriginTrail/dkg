// The daemon's context-graph routes over a real HTTP server, shared by the
// catch-up readiness suites: subscribe a member Edge to `CG` and follow the
// jobs its catch-up tracker records. The routes are imported on first use, so
// a suite that mocks `node:worker_threads` first keeps its real worker.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import type { CatchupJob, CatchupTracker } from '../../src/daemon/types.js';
import { CG, waitUntil, type memberEdge } from './readiness-member-edge.js';
import { requestAuthentication } from './request-authentication.js';

/** An empty catch-up tracker, as the daemon keeps one. */
export function emptyCatchupTracker(): CatchupTracker {
  return { jobs: new Map(), latestByContextGraph: new Map() };
}

/** The graph's latest job, other than `previousJobId`, once it has finished. */
export function nextFinishedJob(catchupTracker: CatchupTracker, previousJobId?: string): Promise<CatchupJob> {
  return waitUntil(() => {
    const latest = catchupTracker.latestByContextGraph.get(CG);
    const job = latest === undefined || latest === previousJobId ? undefined : catchupTracker.jobs.get(latest);
    return job?.finishedAt ? job : undefined;
  }, 'the next job to finish');
}

/** Serve the routes for `member` on a free local port; the suite closes `servers`. */
export async function startReadinessRoutes(member: ReturnType<typeof memberEdge>, servers: Server[]) {
  const { handleContextGraphRoutes } = await import('../../src/daemon/routes/context-graph.js');
  const catchupTracker = emptyCatchupTracker();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    await handleContextGraphRoutes({
      req,
      res,
      agent: member.agent,
      dashDb: member.store,
      catchupTracker,
      url,
      path: url.pathname,
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
    } as any);
    if (!res.writableEnded) {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    catchupTracker,
    /** Subscribe; resolves with the job once it has finished. */
    async subscribe(includeSharedMemory = true): Promise<CatchupJob> {
      const response = await fetch(`http://127.0.0.1:${port}/api/context-graph/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextGraphId: CG, includeSharedMemory }),
      });
      expect(response.status).toBe(200);
      const { jobId } = ((await response.json()) as { catchup: { jobId: string } }).catchup;
      return waitUntil(() => {
        const job = catchupTracker.jobs.get(jobId);
        return job?.finishedAt ? job : undefined;
      }, `job ${jobId}`);
    },
  };
}
