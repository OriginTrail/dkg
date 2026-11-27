/**
 * Source-worker runner - REAL daemon round-trip, NO mocks.
 *
 * The dynamic handler receives the lifecycle client and drives a real named KA
 * create/share plus named async VM publish through the daemon.
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
const originalConsoleLog = console.log;

describe('source worker runner (real daemon)', () => {
  let daemon: LiveDaemon;

  beforeAll(async () => {
    console.log = () => undefined;
    daemon = await startLiveDaemon({ publisherEnabled: true });
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

  it('dynamically imports the handler, wires REAL lifecycle clients, and persists the real job state', async () => {
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
      hasKnowledgeAssets: typeof context.knowledgeAssets.createAndShare === 'function'
        && typeof context.knowledgeAssets.publishAsync === 'function',
    };
    return {
      getFingerprint: async (source) => \`fp-\${source.version}\`,
      processSource: async (source, fingerprint) => {
        const name = \`source-worker-\${source.id}\`;
        const share = await context.knowledgeAssets.createAndShare('${CG}', name, [
          { subject: 'urn:src', predicate: 'urn:hasId', object: \`"\${source.id}"\`, graph: '' },
        ], { subGraphName: 'sg-1' });
        const publish = await context.knowledgeAssets.publishAsync('${CG}', name, { subGraphName: 'sg-1' });
        const jobId = publish.jobId;
        globalThis.__sourceWorkerRunnerProcessed = {
          sourceId: source.id,
          fingerprint,
          name,
          shareOperationId: share.shareOperationId,
          intentKey: publish.intentKey,
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
            assertionName: name,
            shareOperationId: share.shareOperationId,
            intentKey: publish.intentKey,
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
      hasKnowledgeAssets: true,
    });

    const processed = globalThis.__sourceWorkerRunnerProcessed;
    expect(processed.sourceId).toBe('src-1');
    expect(processed.fingerprint).toBe('fp-v1');
    expect(processed.name).toBe('source-worker-src-1');
    expect(processed.shareOperationId).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    expect(processed.intentKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(processed.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const jobRes = await fetch(`${daemon.base}/api/publisher/job?id=${processed.jobId}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(jobRes.status).toBe(200);
    const jobBody: any = await jobRes.json();
    expect(jobBody.job.request.jobType).toBe('knowledge-asset-vm-publish');
    expect(jobBody.job.request.knowledgeAssetVmPublish.contextGraphId).toBe(CG);
    expect(jobBody.job.request.knowledgeAssetVmPublish.name).toBe(processed.name);
    expect(jobBody.job.request.knowledgeAssetVmPublish.shareOperationId).toBe(processed.shareOperationId);
    expect(jobBody.job.request.knowledgeAssetVmPublish.intentKey).toBe(processed.intentKey);

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.sources['src-1']).toMatchObject({
      fingerprint: 'fp-v1',
      assertionName: 'source-worker-src-1',
      shareOperationId: processed.shareOperationId,
      intentKey: processed.intentKey,
      lastStatus: 'queued',
      lastJobIds: [processed.jobId],
    });
  });
});
