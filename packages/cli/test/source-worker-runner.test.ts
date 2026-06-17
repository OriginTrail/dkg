/**
 * Source-worker runner — REAL daemon round-trip, NO mocks.
 *
 * The retired version replaced `globalThis.fetch` with a stub returning
 * canned `swm-1` / `job-1` bodies and asserted the OUTGOING request shapes.
 * That pinned the wire format against a double — a daemon-side rename or a
 * rejected body would keep it green.
 *
 * This version keeps everything that was already real (the runner's dynamic
 * handler import, context wiring, state-file persistence) and points
 * `daemonUrl` at a REAL edge daemon: the handler's `sharedMemory.share()`
 * lands real quads in a real context graph and `asyncLift.lift()` enqueues a
 * real job in the daemon's persistent publisher queue. The daemon ACCEPTING
 * both calls (auth header included — auth is enabled, a wrong token would
 * 401) and the state file recording the REAL daemon-issued ids is the proof
 * the old request-capture only simulated.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runConfiguredSourceWorker } from '../src/source-worker-runner.js';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from './helpers/live-daemon.js';

declare global {
  // eslint-disable-next-line no-var
  var __sourceWorkerRunnerContext: any;
  // eslint-disable-next-line no-var
  var __sourceWorkerRunnerProcessed: any;
}

const CG = `swr-${Date.now().toString(36)}`;
const cleanup: string[] = [];

// Silence the runner's progress logging with a hand-rolled save/restore (no
// vitest mock API — nothing under test is faked).
const originalConsoleLog = console.log;

describe('source worker runner (real daemon)', () => {
  let daemon: LiveDaemon;

  beforeAll(async () => {
    console.log = () => undefined;
    daemon = await startLiveDaemon();
    const created = await postJson(daemon, '/api/context-graph/create', { id: CG, name: CG, accessPolicy: 0 });
    expect(created.status, `CG create failed: ${JSON.stringify(created.body)}`).toBeLessThan(300);
    const sg = await postJson(daemon, '/api/sub-graph/create', { contextGraphId: CG, subGraphName: 'sg-1' });
    expect(sg.status, `sub-graph create failed: ${JSON.stringify(sg.body)}`).toBeLessThan(500);
  }, 120_000);

  afterAll(async () => {
    console.log = originalConsoleLog;
    await stopLiveDaemon(daemon);
  });

  afterEach(async () => {
    delete globalThis.__sourceWorkerRunnerContext;
    delete globalThis.__sourceWorkerRunnerProcessed;
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('dynamically imports the handler, wires REAL daemon clients, and persists the real job state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-runner-'));
    cleanup.push(dir);
    const configPath = join(dir, 'worker.json');
    const handlerPath = join(dir, 'handler.mjs');
    const statePath = join(dir, 'state.json');

    await writeFile(handlerPath, `
export const namedHandler = {
  createSourceWorkerDeps(context) {
    globalThis.__sourceWorkerRunnerContext = {
      daemonUrl: context.config.daemonUrl,
      daemonToken: context.config.daemonToken,
      stateFile: context.config.stateFile,
      sourceIds: context.config.sources.map((source) => source.id),
      hasSharedMemory: typeof context.sharedMemory.share === 'function',
      hasAsyncLift: typeof context.asyncLift.lift === 'function',
    };
    return {
      getFingerprint: async (source) => \`fp-\${source.version}\`,
      processSource: async (source, fingerprint) => {
        const share = await context.sharedMemory.share('${CG}', [
          { subject: 'urn:src', predicate: 'urn:hasId', object: \`"\${source.id}"\` },
        ], { subGraphName: 'sg-1' });
        const jobId = await context.asyncLift.lift({
          swmId: 'swm-live',
          shareOperationId: share.shareOperationId,
          roots: ['urn:src'],
          contextGraphId: '${CG}',
          namespace: 'ns',
          scope: 'scope',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof' },
        });
        globalThis.__sourceWorkerRunnerProcessed = {
          sourceId: source.id,
          fingerprint,
          shareOperationId: share.shareOperationId,
          jobId,
        };
        return {
          sourceId: source.id,
          skipped: false,
          jobIds: [jobId],
          jobStatuses: { [jobId]: 'queued' },
          status: 'queued',
          nextState: {
            fingerprint,
            lastStatus: 'queued',
            lastJobIds: [jobId],
            lastJobStatuses: { [jobId]: 'queued' },
          },
        };
      },
    };
  },
};
`, 'utf8');
    await writeFile(configPath, JSON.stringify({
      pollIntervalMs: 1,
      stateFile: 'state.json',
      daemonUrl: `${daemon.base}/`,
      daemonToken: daemon.token,
      handlerModule: 'handler.mjs',
      handlerExport: 'namedHandler',
      sources: [{ id: 'src-1', version: 'v1' }],
    }), 'utf8');

    await runConfiguredSourceWorker(configPath, { once: true });

    expect(globalThis.__sourceWorkerRunnerContext).toMatchObject({
      daemonUrl: daemon.base,
      daemonToken: daemon.token,
      stateFile: statePath,
      sourceIds: ['src-1'],
      hasSharedMemory: true,
      hasAsyncLift: true,
    });

    // The handler ran against the REAL daemon: real swm-* share id, real UUID
    // job id (canned 'swm-1'/'job-1' constants would prove nothing).
    const processed = globalThis.__sourceWorkerRunnerProcessed;
    expect(processed.sourceId).toBe('src-1');
    expect(processed.fingerprint).toBe('fp-v1');
    expect(processed.shareOperationId).toMatch(/^swm-/);
    expect(processed.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // The job REALLY exists in the daemon's queue.
    const jobRes = await fetch(`${daemon.base}/api/publisher/job?id=${processed.jobId}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(jobRes.status).toBe(200);
    const jobBody: any = await jobRes.json();
    expect(jobBody.job.request.contextGraphId).toBe(CG);

    // State persistence recorded the REAL ids.
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.sources['src-1']).toMatchObject({
      fingerprint: 'fp-v1',
      lastStatus: 'queued',
      lastJobIds: [processed.jobId],
    });
  });
});
