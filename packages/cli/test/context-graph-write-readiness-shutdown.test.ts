// A write that waits for its graph's catch-up (`context-graph-write-readiness.ts`)
// must not outlive the daemon's shutdown or its own request. Graceful shutdown
// closes the HTTP server before it drains catch-up jobs, within a hard deadline
// (15 s by default); a write that waited out its 20 s bound for a running job
// would hold that close until the deadline cut the shutdown off before the
// drain and the cleanup ran. So shutdown ends every wait before its first
// await, and a write whose client disconnects stops waiting too.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  beginWalkCatchupJob,
  drainCatchupJobs,
  releaseCatchupJob,
} from '../src/daemon/catchup-telemetry.js';
import {
  endContextGraphWriteReadinessWaits,
  knownNotWritableAnswer,
  resumeContextGraphWriteReadinessWaits,
  writeReadinessWait,
} from '../src/daemon/context-graph-write-readiness.js';
import { startContextGraphCatchupProgress } from '../src/daemon/context-graph-catchup-progress-sources.js';
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';
import { DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS } from '../src/daemon/shutdown-policy.js';
import { beginGracefulShutdown, runProducerQuiescentTeardown } from '../src/daemon/teardown.js';

const CG = '0x1111111111111111111111111111111111111111/being-caught-up';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The node subscribes the graph, has not proven it yet, and holds nothing of it. */
function nodeCatchingUp() {
  const subscriptions = new Map([[CG, { subscribed: true, synced: false }]]);
  return {
    async listContextGraphs() {
      return [];
    },
    async probeContextGraphWritePreflight() {
      return {
        storeAvailable: true as const,
        exists: true,
        hasLocalContent: false,
        declarationFound: true,
        accessPolicy: 'public' as const,
        inMemorySubscription: { subscribed: true, synced: false },
      };
    },
    getSubscribedContextGraphs: () => subscriptions,
  };
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | undefined;
  at: number;
}

describe('a write that waits for its graph does not outlive shutdown or its request', () => {
  const originalWait = { ...writeReadinessWait };
  const ledger: Array<ReturnType<typeof beginWalkCatchupJob>> = [];
  const servers: Server[] = [];
  let stopProgress = () => {};

  beforeEach(() => {
    // The production bound: a wait that ran it out would show in every timing below.
    Object.assign(writeReadinessWait, originalWait);
    // As the daemon does when its catch-up runner starts.
    stopProgress = startContextGraphCatchupProgress();
  });

  afterEach(async () => {
    stopProgress();
    resumeContextGraphWriteReadinessWaits();
    Object.assign(writeReadinessWait, originalWait);
    for (const entry of ledger.splice(0)) releaseCatchupJob(entry);
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /** A catch-up job for the graph that keeps running. */
  function catchupRunning() {
    const entry = beginWalkCatchupJob({
      jobId: `job-${Math.random().toString(36).slice(2)}`,
      contextGraphId: CG,
      includeWorkspace: true,
      status: 'running',
      queuedAt: Date.now(),
    });
    ledger.push(entry);
    return entry;
  }

  /** The preflight of every write route, behind a real HTTP server. */
  async function writeServer() {
    const agent = nodeCatchingUp();
    const handled: Array<{ accepted: string | null; at: number }> = [];
    const server = createServer(async (_req, res) => {
      const accepted = await resolveRequiredWriteContextGraphId(agent, CG, res);
      handled.push({ accepted, at: Date.now() });
      if (accepted !== null && !res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { server, port, handled };
  }

  /** One write, on a connection of its own. */
  function post(port: number) {
    const request = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/write', agent: false,
      headers: { 'Content-Type': 'application/json' },
    });
    const answered = new Promise<Answer>((resolve, reject) => {
      request.on('response', (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: text ? JSON.parse(text) as Record<string, unknown> : undefined,
          at: Date.now(),
        }));
      });
      request.on('error', reject);
    });
    request.end('{}');
    return { request, answered };
  }

  it('is refused at once when shutdown begins, and the teardown reaches the catch-up drain well inside its deadline', async () => {
    catchupRunning();
    const { server, port, handled } = await writeServer();
    const { answered } = post(port);

    // The write waits for the graph's catch-up, which keeps running.
    await sleep(1_000);
    expect(handled).toEqual([]);

    // Shutdown begins a second later, the way the daemon begins it.
    const shutdownAt = Date.now();
    await beginGracefulShutdown({
      state: { catchupAcceptingJobs: true },
      removeApiPort: async () => {},
      log: () => {},
      endWriteReadinessWaits: endContextGraphWriteReadinessWaits,
    });
    const steps: string[] = [];
    const noop = async () => {};
    const teardown = runProducerQuiescentTeardown({
      closeServer: async () => {
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        servers.splice(servers.indexOf(server), 1);
        steps.push(`closeServer after ${Date.now() - shutdownAt} ms`);
      },
      drainCatchupJobs: async () => {
        const { drained } = await drainCatchupJobs(1_000);
        steps.push(`drainCatchupJobs: ${drained}`);
      },
      closeEntitySearch: noop,
      closeLocalLlm: noop,
      flushTelemetry: noop,
      stopPublisherRuntime: noop,
      stopPromoteWorker: noop,
      closeCatchupRunner: noop,
      stopAgent: noop,
      stopRpcUsageTelemetry: noop,
      stopTelemetry: noop,
    });

    // The waiting write is refused at once, retryable, and never resolved.
    const answer = await answered;
    expect(answer.status).toBe(503);
    expect(answer.headers['retry-after']).toBe('5');
    expect(answer.body).toEqual({
      code: 'CONTEXT_GRAPH_NOT_WRITABLE',
      retryable: true,
      error: `Context graph "${CG}" is not writable yet: this node is shutting down. Retry the write once it is back up.`,
    });
    expect(answer.at - shutdownAt).toBeLessThan(500);
    expect(handled.map(({ accepted }) => accepted)).toEqual([null]);

    // The server closes long before the shutdown deadline, and the drain still runs after it.
    const outcome = await teardown;
    expect(outcome.failures).toEqual([]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatch(/^closeServer after \d+ ms$/);
    expect(Number(/(\d+) ms/.exec(steps[0])![1])).toBeLessThan(1_000);
    expect(steps[1]).toBe('drainCatchupJobs: 1');
    expect(Date.now() - shutdownAt).toBeLessThan(DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS / 5);
  });

  it('does not wait at all once shutdown has begun', async () => {
    catchupRunning();
    endContextGraphWriteReadinessWaits();
    const answer: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      writeHead(status: number) { answer.status = status; return res; },
      end(body?: string) { if (body) answer.body = JSON.parse(body); },
    } as unknown as ServerResponse;
    const startedAt = Date.now();

    const accepted = await resolveRequiredWriteContextGraphId(nodeCatchingUp(), CG, res);

    expect(accepted).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(writeReadinessWait.pollMs);
    expect(answer).toMatchObject({ status: 503, body: { code: 'CONTEXT_GRAPH_NOT_WRITABLE', retryable: true } });
  });

  it('stops waiting when its client disconnects, and is not resolved', async () => {
    catchupRunning();
    const { port, handled } = await writeServer();
    const { request, answered } = post(port);
    answered.catch(() => {});

    await sleep(300);
    expect(handled).toEqual([]);
    const goneAt = Date.now();
    request.destroy();

    await expect.poll(() => handled.length, { timeout: 2_000, interval: 10 }).toBe(1);
    expect(handled[0].accepted).toBeNull();
    expect(handled[0].at - goneAt).toBeLessThan(writeReadinessWait.pollMs * 2);
  });

  it('ends the waits before the first await of shutdown, and carries on when ending them fails', async () => {
    const steps: string[] = [];
    const state = { catchupAcceptingJobs: true };
    let leave!: () => void;
    const held = new Promise<void>((resolve) => { leave = resolve; });
    const started = beginGracefulShutdown({
      state,
      log: (message) => steps.push(`log: ${message}`),
      removeApiPort: async () => { steps.push('remove api.port'); await held; },
      endWriteReadinessWaits: () => steps.push(`end write waits (catch-up open: ${state.catchupAcceptingJobs})`),
    });
    expect(steps).toEqual([
      'end write waits (catch-up open: false)',
      'log: Shutting down...',
      'remove api.port',
    ]);
    leave();
    await started;

    const logs: string[] = [];
    let removed = false;
    await beginGracefulShutdown({
      state: { catchupAcceptingJobs: true },
      log: (message) => logs.push(message),
      removeApiPort: async () => { removed = true; },
      endWriteReadinessWaits: () => { throw new Error('not ready'); },
    });
    expect(logs).toEqual(['Write readiness wait shutdown error: not ready', 'Shutting down...']);
    expect(removed).toBe(true);
  });

  it('answers a write that shutdown or a closed request ended as not writable yet, retryable', () => {
    expect(knownNotWritableAnswer('graph-x', 'shutting-down')).toEqual({
      status: 503,
      body: {
        code: 'CONTEXT_GRAPH_NOT_WRITABLE',
        retryable: true,
        error: 'Context graph "graph-x" is not writable yet: this node is shutting down. Retry the write once it is back up.',
      },
      headers: { 'Retry-After': '5' },
    });
    expect(knownNotWritableAnswer('graph-x', 'abandoned')).toMatchObject({
      status: 503,
      body: { code: 'CONTEXT_GRAPH_NOT_WRITABLE', retryable: true },
    });
  });
});
