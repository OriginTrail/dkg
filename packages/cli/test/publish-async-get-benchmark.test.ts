import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBenchmarkClient,
  formatResult,
  isLoopbackApiUrl,
  parseBenchmarkArgs,
  resolveTokenForApiUrl,
  runPublishAsyncGetBenchmark,
  summarizeOperations,
} from '../src/benchmark/publish-get/index.js';
import {
  baseConfig,
  MockBenchmarkClient,
  monotonicClock,
  timing,
  trackingFetch,
} from './helpers/publish-async-get-benchmark.js';

const originalFetch = globalThis.fetch;
const originalDkgHome = process.env.DKG_HOME;

type FocusedBenchmarkRecord = {
  baseline: unknown;
  notes: unknown;
  paramDef: unknown;
  scenes: Array<Record<string, unknown>>;
};

type EsbenchConfigForTest = {
  filterResultByCase: (
    result: Record<string, unknown>,
    caseName: string,
  ) => Record<string, FocusedBenchmarkRecord[]>;
  publishAsyncGetPages: Array<[string, string]>;
  publishAsyncGetSuite: string;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDkgHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = originalDkgHome;
});

describe('publish async get benchmark', () => {
  it('parses benchmark arguments with defaults and overrides', () => {
    const config = parseBenchmarkArgs([
      '--context-graph-id',
      'bench-cg',
      '--repeat=7',
      '--warmups',
      '2',
      '--timeout-ms',
      '5000',
      '--payload-size',
      '256',
      '--fixture',
      'minimal',
      '--output-format',
      'ndjson',
      '--api-url',
      'http://127.0.0.1:9200',
      '--auth-token',
      'token-a',
    ], {});

    expect(config).toMatchObject({
      contextGraphId: 'bench-cg',
      repeat: 7,
      warmups: 2,
      timeoutMs: 5000,
      payloadSizeBytes: 256,
      fixture: 'minimal',
      outputFormat: 'ndjson',
      apiUrl: 'http://127.0.0.1:9200',
      authToken: 'token-a',
    });
  });

  it('uses the default repeat count and environment configuration', () => {
    const config = parseBenchmarkArgs([], {
      DKG_BENCH_CONTEXT_GRAPH_ID: 'env-cg',
      DKG_BENCH_WARMUPS: '4',
      DKG_BENCH_OUTPUT_FORMAT: 'json',
      DKG_BENCH_PAYLOAD_SIZE: '512',
    });

    expect(config).toMatchObject({
      contextGraphId: 'env-cg',
      repeat: 30,
      warmups: 4,
      payloadSizeBytes: 512,
      outputFormat: 'json',
    });
  });

  it('aggregates measured timings while excluding warmups', () => {
    const summaries = summarizeOperations([
      timing('syncPublish', 1, true, true, 100),
      timing('syncPublish', 1, false, true, 10),
      timing('syncPublish', 2, false, true, 20),
      timing('syncPublish', 3, false, false, 30, 'boom'),
      timing('get', 1, false, true, 5),
    ]);

    expect(summaries.syncPublish).toMatchObject({
      count: 3,
      successCount: 2,
      failureCount: 1,
      minMs: 10,
      maxMs: 20,
      meanMs: 15,
      medianMs: 10,
      p50Ms: 10,
      p95Ms: 20,
    });
    expect(summaries.get).toMatchObject({ count: 1, successCount: 1, failureCount: 0 });
  });

  it('uses unique roots for warmup and measured payloads and does not clear shared memory on sync publish', async () => {
    const client = new MockBenchmarkClient();
    const result = await runPublishAsyncGetBenchmark({ ...baseConfig(), repeat: 1, warmups: 1 }, client, monotonicClock());

    expect(result.summaries.syncPublish.count).toBe(1);
    expect(result.operations.filter((op) => op.warmup)).toHaveLength(4);
    expect(client.publishCalls).toHaveLength(2);
    expect(client.publishCalls.every((call) => call.clearAfter === false)).toBe(true);

    const roots = [
      ...client.publishCalls.flatMap((call) => call.roots),
      ...client.enqueueCalls.flatMap((call) => call.roots),
    ];
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots.some((root) => root.includes(':warmup-1:'))).toBe(true);
    expect(roots.some((root) => root.includes(':measured-1:'))).toBe(true);
  });

  it('reports measured failures with operation, iteration, error, and reproduction context', async () => {
    const client = new MockBenchmarkClient({ jobStatus: 'failed', jobError: 'chain rejected' });
    const result = await runPublishAsyncGetBenchmark({ ...baseConfig(), repeat: 1, warmups: 0 }, client, monotonicClock());

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      operation: 'asyncCompletion',
      iteration: 1,
      error: expect.stringContaining('chain rejected'),
    });
    expect(result.failures[0].context).toMatchObject({
      contextGraphId: 'bench-cg',
      flow: 'async',
      jobId: 'job-1',
    });
  });

  it('reports get validation failures when returned content does not include the marker', async () => {
    const client = new MockBenchmarkClient({ queryMarkerOverride: '"wrong-marker"' });
    const result = await runPublishAsyncGetBenchmark({ ...baseConfig(), repeat: 1, warmups: 0 }, client, monotonicClock());

    expect(result.summaries.get).toMatchObject({ count: 1, successCount: 0, failureCount: 1 });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      operation: 'get',
      iteration: 1,
      error: expect.stringContaining('Get query did not return benchmark marker'),
    });
    expect(result.failures[0].context).toMatchObject({
      contextGraphId: 'bench-cg',
      flow: 'get',
    });
  });

  it('reports async enqueue failures and skipped completion context', async () => {
    const client = new MockBenchmarkClient({ enqueueError: 'publisher queue disabled' });
    const result = await runPublishAsyncGetBenchmark({ ...baseConfig(), repeat: 1, warmups: 0 }, client, monotonicClock());

    expect(result.failures.map((failure) => failure.operation)).toEqual(['asyncEnqueue', 'asyncCompletion']);
    expect(result.failures[0]).toMatchObject({
      iteration: 1,
      error: expect.stringContaining('publisher queue disabled'),
    });
    expect(result.failures[0].context).toMatchObject({
      contextGraphId: 'bench-cg',
      flow: 'async',
      shareOperationId: 'share-2',
    });
    expect(result.failures[1].context).toMatchObject({
      skippedAfter: 'asyncEnqueue',
      shareOperationId: 'share-2',
    });
  });

  it('formats ndjson output with operation rows, a summary row, and sanitized config', async () => {
    const config = baseConfig({ authToken: 'secret-token', outputFormat: 'ndjson' });
    const result = await runPublishAsyncGetBenchmark(config, new MockBenchmarkClient(), monotonicClock());
    const rows = formatResult(result, 'ndjson').split('\n').map((line) => JSON.parse(line));

    expect(rows).toHaveLength(result.operations.length + 1);
    expect(rows.slice(0, -1).every((row) => row.type === 'operation')).toBe(true);
    expect(rows.at(-1)).toMatchObject({
      type: 'summary',
      summaries: { syncPublish: { count: 1, successCount: 1, failureCount: 0 } },
    });
    expect(JSON.stringify(rows)).not.toContain('secret-token');
  });

  it('auto-loads local tokens for DKG_API_PORT targets', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'dkg-bench-auth-'));
    process.env.DKG_HOME = tempDir;
    await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = trackingFetch(calls, { name: 'dkg', peerId: 'p', uptimeMs: 1, connectedPeers: 0, relayConnected: false, multiaddrs: [] });

    try {
      const client = await createBenchmarkClient({ ...baseConfig(), apiPort: 9300, authToken: undefined });
      await client.status();
      expect(calls[0].url).toBe('http://127.0.0.1:9300/api/status');
      expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer local-token');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('auto-loads local tokens for loopback DKG_API_URL targets', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'dkg-bench-auth-'));
    process.env.DKG_HOME = tempDir;
    await writeFile(join(tempDir, 'auth.token'), 'local-url-token\n', 'utf8');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = trackingFetch(calls, { name: 'dkg', peerId: 'p', uptimeMs: 1, connectedPeers: 0, relayConnected: false, multiaddrs: [] });

    try {
      const client = await createBenchmarkClient({ ...baseConfig(), apiUrl: 'http://localhost:9301', authToken: undefined });
      await client.status();
      expect(calls[0].url).toBe('http://localhost:9301/api/status');
      expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer local-url-token');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not auto-load local auth tokens for non-loopback API URLs', async () => {
    await expect(resolveTokenForApiUrl('https://node.example.test:9200')).rejects.toThrow(/non-loopback API URL/);
    await expect(resolveTokenForApiUrl('https://node.example.test:9200', 'explicit-token')).resolves.toBe('explicit-token');
    expect(isLoopbackApiUrl('http://localhost:9200')).toBe(true);
    expect(isLoopbackApiUrl('http://127.12.0.1:9200')).toBe(true);
    expect(isLoopbackApiUrl('http://192.168.1.50:9200')).toBe(false);
  });

  it('keeps ESBench focused HTML scenes aligned with payload-size params', async () => {
    const {
      filterResultByCase,
      publishAsyncGetPages,
      publishAsyncGetSuite,
    } = await import('../../../esbench.config.mjs') as EsbenchConfigForTest;
    const caseName = 'asynchronous publish enqueue and finalization';
    const result = {
      [publishAsyncGetSuite]: [
        {
          notes: ['not copied'],
          baseline: { type: 'Name', value: 'synchronous publish with finalization' },
          paramDef: [['payloadSizeBytes', ['128', '1024']]],
          scenes: [
            {
              'get/read retrieval': { time: [1] },
              'synchronous publish with finalization': { time: [2] },
            },
            {
              [caseName]: { time: [3] },
              'synchronous publish with finalization': { time: [4] },
            },
          ],
        },
      ],
    };

    const filtered = filterResultByCase(result, caseName);
    const record = filtered[publishAsyncGetSuite][0];

    expect(publishAsyncGetPages).toEqual([
      ['get/read retrieval', 'bench/results/publish-async-get/get-read-retrieval.html'],
      ['synchronous publish with finalization', 'bench/results/publish-async-get/sync-publish-finalization.html'],
      ['asynchronous publish enqueue and finalization', 'bench/results/publish-async-get/async-publish-finalization.html'],
      ['upload payload to local working memory', 'bench/results/publish-async-get/working-memory-upload.html'],
      ['lift local working memory to shared working memory', 'bench/results/publish-async-get/working-to-shared-memory.html'],
    ]);
    expect(record.paramDef).toEqual([['payloadSizeBytes', ['128', '1024']]]);
    expect(record.baseline).toEqual({ type: 'Name', value: caseName });
    expect(record.notes).toEqual([]);
    expect(record.scenes).toHaveLength(2);
    expect(record.scenes[0]).toEqual({});
    expect(record.scenes[1]).toEqual({ [caseName]: { time: [3] } });
  });

  it('keeps focused ESBench HTML pages wired into the documented benchmark script', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const benchHtml = packageJson.scripts?.['bench:html'];

    expect(benchHtml).toContain('ESBENCH_HTML=1');
    expect(benchHtml).toContain('ESBENCH_PUBLISH_ASYNC_GET_HTML=1');
    expect(benchHtml).toContain('esbench --config esbench.config.mjs');
  });
});
