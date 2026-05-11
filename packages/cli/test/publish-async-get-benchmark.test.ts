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
const originalEsbenchPayloadSizes = process.env.DKG_ESBENCH_PAYLOAD_SIZES;

type FocusedBenchmarkRecord = {
  baseline: unknown;
  notes: unknown;
  paramDef: unknown;
  scenes: Array<Record<string, unknown>>;
};

type EsbenchConfigForTest = {
  addLinkedReportNavigation: (
    html: string,
    currentFile: string,
    targets: Array<[string, string]>,
  ) => string;
  filterResultByCase: (
    result: Record<string, unknown>,
    caseName: string,
  ) => Record<string, FocusedBenchmarkRecord[]>;
  publishAsyncGetPages: Array<[string, string]>;
  publishAsyncGetSuite: string;
};

type EsbenchSuiteForTest = {
  default: {
    params?: {
      payloadSize?: string[];
    };
  };
  GENERATED_PAYLOAD_SIZES: Array<{ label: string; bytes: number }>;
};

type CpuProfileReportForTest = {
  renderCpuProfileFlamegraphHtml: (profile: unknown, options?: Record<string, unknown>) => string;
};

type MethodAnalysisForTest = {
  renderMethodAnalysisHtml: (report: {
    benchmark: 'publish-async-get-method-analysis';
    generatedAt: string;
    payloadSizes: string[];
    flows: Array<{
      flow: string;
      payloadSize: string;
      totalMs: number;
      measuredMs: number;
      traces: Array<{
        flow: string;
        payloadSize: string;
        phase: string;
        method: string;
        invokes: string[];
        detail: string;
        durationMs: number;
        success: boolean;
        context: Record<string, unknown>;
      }>;
    }>;
  }) => string;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDkgHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = originalDkgHome;
  if (originalEsbenchPayloadSizes === undefined) delete process.env.DKG_ESBENCH_PAYLOAD_SIZES;
  else process.env.DKG_ESBENCH_PAYLOAD_SIZES = originalEsbenchPayloadSizes;
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
      '10kb',
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
      payloadSizeBytes: 10 * 1024,
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
      DKG_BENCH_PAYLOAD_SIZE: '100kb',
    });

    expect(config).toMatchObject({
      contextGraphId: 'env-cg',
      repeat: 30,
      warmups: 4,
      payloadSizeBytes: 100 * 1024,
      outputFormat: 'json',
    });
  });

  it('parses generated payload sizes with mb units', () => {
    expect(parseBenchmarkArgs(['--context-graph-id', 'bench-cg', '--payload-size', '2mb'], {}).payloadSizeBytes)
      .toBe(2 * 1024 * 1024);
    expect(parseBenchmarkArgs(['--context-graph-id', 'bench-cg', '--payload-size', '200mb'], {}).payloadSizeBytes)
      .toBe(200 * 1024 * 1024);
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

  it('runs the ESBench suite across the generated payload-size matrix', async () => {
    delete process.env.DKG_ESBENCH_PAYLOAD_SIZES;
    const suite = await import('../../../bench/publish-async-get.bench.ts') as EsbenchSuiteForTest;

    expect(suite.GENERATED_PAYLOAD_SIZES).toEqual([
      { label: '10kb', bytes: 10 * 1024 },
      { label: '100kb', bytes: 100 * 1024 },
      { label: '2mb', bytes: 2 * 1024 * 1024 },
      { label: '200mb', bytes: 200 * 1024 * 1024 },
    ]);
    expect(suite.default.params?.payloadSize).toEqual(['10kb', '100kb', '2mb', '200mb']);
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
          paramDef: [['payloadSize', ['10kb', '100kb', '2mb', '200mb']]],
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
    expect(record.paramDef).toEqual([['payloadSize', ['10kb', '100kb', '2mb', '200mb']]]);
    expect(record.baseline).toEqual({ type: 'Name', value: caseName });
    expect(record.notes).toEqual([]);
    expect(record.scenes).toHaveLength(2);
    expect(record.scenes[0]).toEqual({});
    expect(record.scenes[1]).toEqual({ [caseName]: { time: [3] } });
  });

  it('links the combined ESBench report and focused HTML pages together', async () => {
    const {
      addLinkedReportNavigation,
      publishAsyncGetPages,
    } = await import('../../../esbench.config.mjs') as EsbenchConfigForTest;
    const targets: Array<[string, string]> = [
      ['Combined report', 'bench/results/latest.html'],
      ...publishAsyncGetPages,
    ];

    const html = addLinkedReportNavigation(
      '<!doctype html><html><head><title>Benchmark</title></head><body><main></main></body></html>',
      'bench/results/publish-async-get/get-read-retrieval.html',
      targets,
    );
    const repeated = addLinkedReportNavigation(
      html,
      'bench/results/publish-async-get/get-read-retrieval.html',
      targets,
    );

    expect(html).toContain('dkg-benchmark-report-nav');
    expect(html).toContain('../latest.html');
    expect(html).toContain('sync-publish-finalization.html');
    expect(html).toContain('asynchronous publish enqueue and finalization');
    expect(html).toContain('aria-current=\\"page\\"');
    expect(html).toContain('DOMContentLoaded');
    expect(repeated.match(/dkg-benchmark-report-nav:start/g)).toHaveLength(1);
  });

  it('renders a CPU profile flamegraph HTML report for benchmark analysis', async () => {
    const { renderCpuProfileFlamegraphHtml } = await import('../../../bench/support/cpu-profile-report.mjs') as CpuProfileReportForTest;
    const html = renderCpuProfileFlamegraphHtml({
      nodes: [
        {
          id: 1,
          callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 },
          children: [2],
        },
        {
          id: 2,
          callFrame: {
            functionName: 'publishFromSharedMemory',
            url: 'file:///repo/packages/publisher/src/index.ts',
            lineNumber: 41,
            columnNumber: 1,
          },
          children: [3],
        },
        {
          id: 3,
          callFrame: {
            functionName: 'finalizePublish',
            url: 'file:///repo/packages/agent/src/publisher.ts',
            lineNumber: 8,
            columnNumber: 1,
          },
        },
      ],
      samples: [2, 3, 3],
      timeDeltas: [1000, 2000, 3000],
    }, {
      profileName: 'publish-async-get-test.cpuprofile',
      generatedAt: '2026-05-06T00:00:00.000Z',
    });

    expect(html).toContain('<svg');
    expect(html).toContain('publishFromSharedMemory');
    expect(html).toContain('finalizePublish');
    expect(html).toContain('6.00 ms');
    expect(html).toContain('Raw .cpuprofile');
  });

  it('renders method analysis with invoked methods and per-step timing', async () => {
    const { renderMethodAnalysisHtml } = await import('../../../bench/analyze-publish-async-get.ts') as MethodAnalysisForTest;
    const html = renderMethodAnalysisHtml({
      benchmark: 'publish-async-get-method-analysis',
      generatedAt: '2026-05-06T00:00:00.000Z',
      payloadSizes: ['200mb'],
      flows: [
        {
          flow: 'asynchronous publish enqueue and finalization',
          payloadSize: '200mb',
          totalMs: 12,
          measuredMs: 7,
          traces: [
            {
              flow: 'asynchronous publish enqueue and finalization',
              payloadSize: '200mb',
              phase: 'measured',
              method: 'publisherEnqueue',
              invokes: ['publisherJobs.set'],
              detail: 'Enqueue the publish request through the publisher runtime path.',
              durationMs: 2,
              success: true,
              context: { rootEntity: 'urn:test:root', quadCount: 1 },
            },
            {
              flow: 'asynchronous publish enqueue and finalization',
              payloadSize: '200mb',
              phase: 'measured',
              method: 'publisherJob',
              invokes: ['promoteSharedRoot'],
              detail: 'Poll the publisher job and finalize queued content.',
              durationMs: 5,
              success: true,
              context: { jobId: 'job-1' },
            },
          ],
        },
      ],
    });

    expect(html).toContain('DKG Benchmark Method Analysis');
    expect(html).toContain('asynchronous publish enqueue and finalization');
    expect(html).toContain('publisherEnqueue');
    expect(html).toContain('publisherJob');
    expect(html).toContain('promoteSharedRoot');
    expect(html).toContain('2.000 ms');
    expect(html).toContain('5.000 ms');
  });

  it('keeps focused ESBench HTML pages wired into the documented benchmark script', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const benchHtml = packageJson.scripts?.['bench:html'];
    const benchAnalysis = packageJson.scripts?.['bench:analysis'];
    const benchProfile = packageJson.scripts?.['bench:profile'];

    expect(benchHtml).toContain('ESBENCH_HTML=1');
    expect(benchHtml).toContain('ESBENCH_PUBLISH_ASYNC_GET_HTML=1');
    expect(benchHtml).toContain('esbench --config esbench.config.mjs');
    expect(benchAnalysis).toBe('node --experimental-strip-types bench/analyze-publish-async-get.ts');
    expect(benchProfile).toBe('node bench/profile-publish-async-get.mjs');
  });
});
