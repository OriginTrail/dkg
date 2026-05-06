import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runConfiguredSourceWorker } from '../src/source-worker-runner.js';

declare global {
  var __sourceWorkerRunnerContext: any;
  var __sourceWorkerRunnerProcessed: any;
}

const originalFetch = globalThis.fetch;
const cleanup: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete globalThis.__sourceWorkerRunnerContext;
  delete globalThis.__sourceWorkerRunnerProcessed;
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('source worker runner', () => {
  it('dynamically imports the handler and wires daemon clients into its context', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const dir = await mkdtemp(join(tmpdir(), 'source-worker-runner-'));
    cleanup.push(dir);
    const configPath = join(dir, 'worker.json');
    const handlerPath = join(dir, 'handler.mjs');
    const statePath = join(dir, 'state.json');
    const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

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
        const share = await context.sharedMemory.share('cg-1', [
          { subject: 'urn:src', predicate: 'urn:hasId', object: \`"\${source.id}"\` },
        ], { subGraphName: 'sg-1' });
        const jobId = await context.asyncLift.lift({
          swmId: 'swm-1',
          shareOperationId: share.shareOperationId,
          roots: ['urn:src'],
          contextGraphId: 'cg-1',
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
      daemonUrl: 'http://127.0.0.1:9200/',
      daemonToken: 'secret-token',
      handlerModule: 'handler.mjs',
      handlerExport: 'namedHandler',
      sources: [{ id: 'src-1', version: 'v1' }],
    }), 'utf8');

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      requests.push({
        url,
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith('/api/shared-memory/write')) {
        return new Response(JSON.stringify({ shareOperationId: 'swm-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/publisher/enqueue')) {
        return new Response(JSON.stringify({ jobId: 'job-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    await runConfiguredSourceWorker(configPath, { once: true });

    expect(globalThis.__sourceWorkerRunnerContext).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9200',
      daemonToken: 'secret-token',
      stateFile: statePath,
      sourceIds: ['src-1'],
      hasSharedMemory: true,
      hasAsyncLift: true,
    });
    expect(globalThis.__sourceWorkerRunnerProcessed).toEqual({
      sourceId: 'src-1',
      fingerprint: 'fp-v1',
      shareOperationId: 'swm-1',
      jobId: 'job-1',
    });
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:9200/api/shared-memory/write',
      'http://127.0.0.1:9200/api/publisher/enqueue',
    ]);
    expect(requests.every((request) => request.headers.Authorization === 'Bearer secret-token')).toBe(true);
    expect(requests[0].body).toMatchObject({
      contextGraphId: 'cg-1',
      subGraphName: 'sg-1',
      quads: [{ subject: 'urn:src', predicate: 'urn:hasId', object: '"src-1"' }],
    });
    expect(requests[1].body).toMatchObject({
      swmId: 'swm-1',
      shareOperationId: 'swm-1',
      contextGraphId: 'cg-1',
    });

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.sources['src-1']).toMatchObject({
      fingerprint: 'fp-v1',
      lastStatus: 'queued',
      lastJobIds: ['job-1'],
    });
  });
});
