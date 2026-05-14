import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const benchmark = require('../scripts/swm-triple-volume-benchmark.cjs') as {
  buildBenchmarkPlan: (config: Record<string, unknown>) => {
    targetBytesPerNode: number;
    estimatedBytesPerWrite: number;
    writesPerNode: number;
    totalWrites: number;
    triplesPerNode: number;
    totalTriples: number;
    estimatedBytesPerNode: number;
    rootPrefix: string;
  };
  buildWriteTasks: (
    config: { ports: number[]; maxWrites?: number },
    plan: { writesPerNode: number },
  ) => Array<{ nodeIndex: number; writeNumber: number }>;
  analyzeThroughput: (result: Record<string, unknown>) => Record<string, unknown>;
  renderAnalysisMarkdown: (result: Record<string, unknown>) => string;
  estimateQuadsNQuadBytes: (quads: Array<{ subject: string; predicate: string; object: string; graph: string }>) => number;
  makeObjectLexical: (
    runId: string,
    nodeNumber: number,
    writeNumber: number,
    tripleIndex: number,
    objectBytes: number,
  ) => string;
  makeQuads: (
    config: Record<string, unknown>,
    plan: { rootPrefix: string },
    nodeNumber: number,
    writeNumber: number,
    tripleCount?: number,
  ) => Array<{ subject: string; predicate: string; object: string; graph: string }>;
  parseBenchmarkArgs: (argv: string[], env: Record<string, string | undefined>) => Record<string, unknown>;
};

describe('swm triple volume benchmark', () => {
  it('parses 1 GiB per-node benchmark arguments', () => {
    const config = benchmark.parseBenchmarkArgs([
      '--',
      '--ports',
      '20101,20102',
      '--target-gib-per-node',
      '1',
      '--triples-per-write',
      '250',
      '--object-bytes',
      '48',
      '--predicate-count',
      '4',
      '--write-concurrency',
      '2',
      '--max-writes',
      '125',
      '--diagnostic-interval-ms',
      '5000',
      '--replication-timeout-ms',
      '1000',
      '--poll-interval-ms',
      '100',
      '--request-timeout-ms',
      '2000',
      '--query-timeout-ms',
      '3000',
      '--run-id',
      'triple-run',
      '--namespace',
      'triple-volume',
      '--predicate-base',
      'urn:test:p',
      '--output',
      'bench/results/triples.json',
      '--analysis-output',
      'bench/results/triples.analysis.md',
      '--devnet-dir',
      '.devnet',
      '--no-scan-logs',
      '--no-diagnostics',
      '--auth-token',
      'secret-token',
    ], {});

    expect(config).toMatchObject({
      ports: [20101, 20102],
      nodes: 2,
      targetMiBPerNode: 1024,
      triplesPerWrite: 250,
      objectBytes: 48,
      predicateCount: 4,
      writeConcurrency: 2,
      maxWrites: 125,
      diagnosticIntervalMs: 5000,
      diagnostics: false,
      replicationTimeoutMs: 1000,
      pollIntervalMs: 100,
      requestTimeoutMs: 2000,
      queryTimeoutMs: 3000,
      runId: 'triple-run',
      namespace: 'triple-volume',
      predicateBase: 'urn:test:p',
      scanLogs: false,
      authToken: 'secret-token',
      output: resolve(process.env.INIT_CWD ?? process.cwd(), 'bench/results/triples.json'),
      analysisOutput: resolve(process.env.INIT_CWD ?? process.cwd(), 'bench/results/triples.analysis.md'),
      devnetDir: resolve(process.env.INIT_CWD ?? process.cwd(), '.devnet'),
    });
  });

  it('uses a default object size that fits generated run ids', () => {
    const config = benchmark.parseBenchmarkArgs(['--run-id', '1760000000000-abcdefgh'], {});

    expect(config).toMatchObject({ objectBytes: 64 });
    expect(() => benchmark.buildBenchmarkPlan(config)).not.toThrow();
  });

  it('builds root-scoped quads so one write stays one SWM root', () => {
    const config = {
      runId: 'run-a',
      namespace: 'swm-triple-volume',
      predicateBase: 'urn:test:p',
      predicateCount: 2,
      objectBytes: 32,
      triplesPerWrite: 4,
    };
    const quads = benchmark.makeQuads(
      config,
      { rootPrefix: 'urn:dkg:benchmark:swm-triple-volume:run-a:' },
      3,
      7,
    );

    expect(quads).toHaveLength(4);
    expect(quads[0].subject).toBe('urn:dkg:benchmark:swm-triple-volume:run-a:node:3:write:7');
    expect(quads.slice(1).every((quad) => quad.subject.startsWith(`${quads[0].subject}/.well-known/genid/`))).toBe(true);
    expect(quads.map((quad) => quad.predicate)).toContain('urn:test:p:1');
  });

  it('generates fixed-size literal lexical values', () => {
    const value = benchmark.makeObjectLexical('run-a', 1, 2, 3, 64);
    expect(Buffer.byteLength(value, 'utf8')).toBe(64);
    expect(value).toContain('r=run-a;n=1;w=2;t=3;');
  });

  it('plans enough writes to meet the target estimated byte volume', () => {
    const config = {
      contextGraphId: 'devnet-test',
      ports: [9201, 9202],
      targetMiBPerNode: 1,
      triplesPerWrite: 10,
      objectBytes: 32,
      predicateCount: 4,
      runId: 'plan-run',
      namespace: 'swm-triple-volume',
      predicateBase: 'urn:test:p',
    };
    const plan = benchmark.buildBenchmarkPlan(config);

    expect(plan.targetBytesPerNode).toBe(1024 * 1024);
    expect(plan.estimatedBytesPerWrite).toBeGreaterThan(0);
    expect(plan.estimatedBytesPerNode).toBeGreaterThanOrEqual(plan.targetBytesPerNode);
    expect(plan.totalWrites).toBe(plan.writesPerNode * 2);
    expect(plan.triplesPerNode).toBe(plan.writesPerNode * 10);
    expect(plan.totalTriples).toBe(plan.triplesPerNode * 2);
  });

  it('interleaves write tasks across nodes', () => {
    expect(benchmark.buildWriteTasks({ ports: [9201, 9202, 9203] }, { writesPerNode: 2 })).toEqual([
      { nodeIndex: 0, writeNumber: 1 },
      { nodeIndex: 1, writeNumber: 1 },
      { nodeIndex: 2, writeNumber: 1 },
      { nodeIndex: 0, writeNumber: 2 },
      { nodeIndex: 1, writeNumber: 2 },
      { nodeIndex: 2, writeNumber: 2 },
    ]);
  });

  it('can cap write tasks for diagnostic runs', () => {
    expect(benchmark.buildWriteTasks({ ports: [9201, 9202, 9203], maxWrites: 4 }, { writesPerNode: 3 })).toEqual([
      { nodeIndex: 0, writeNumber: 1 },
      { nodeIndex: 1, writeNumber: 1 },
      { nodeIndex: 2, writeNumber: 1 },
      { nodeIndex: 0, writeNumber: 2 },
    ]);
  });

  it('estimates serialized N-Quad bytes for generated triples', () => {
    const quads = benchmark.makeQuads(
      {
        runId: 'run-a',
        namespace: 'swm-triple-volume',
        predicateBase: 'urn:test:p',
        predicateCount: 2,
        objectBytes: 32,
        triplesPerWrite: 3,
      },
      { rootPrefix: 'urn:dkg:benchmark:swm-triple-volume:run-a:' },
      1,
      1,
    );

    expect(benchmark.estimateQuadsNQuadBytes(quads)).toBeGreaterThan(0);
  });

  it('analyzes throughput drops with runtime log signals', () => {
    const result = {
      ok: false,
      config: { runId: 'analysis-run' },
      write: {
        attemptedWrites: 100,
        completedWrites: 80,
        error: { message: 'fetch failed' },
        intervals: [
          { atMs: 1000, completed: 25, writesPerSec: 20, miBPerSec: 2, latencyMs: { p95: 250, max: 300 } },
          { atMs: 2000, completed: 50, writesPerSec: 25, miBPerSec: 2.5, latencyMs: { p95: 300, max: 350 } },
          { atMs: 3000, completed: 75, writesPerSec: 5, miBPerSec: 0.5, latencyMs: { p95: 1800, max: 2100 } },
        ],
        diagnostics: [{
          atMs: 3200,
          logCounters: {
            totals: {
              syncTimeout: 2,
              syncingFromPeer: 3,
              queryAllContextGraph: 1,
              socketHangUp: 1,
            },
          },
          nodes: [{
            nodeName: 'node1',
            port: 9201,
            storeNqMiB: 512,
            daemonLogMiB: 8,
            publicSnapshotStore: { files: 80, mib: 1.5 },
            process: { rssMiB: 1024, cpuPercent: 80, processes: 3 },
          }],
        }],
      },
    };

    const analysis = benchmark.analyzeThroughput(result);
    expect(analysis).toMatchObject({
      completedWrites: 80,
      attemptedWrites: 100,
      dropFromPeak: 0.8,
    });
    expect(String(JSON.stringify(analysis))).toContain('sync-backpressure');
    expect(String(JSON.stringify(analysis))).toContain('rpc-instability');
    expect(benchmark.renderAnalysisMarkdown({ ...result, analysis })).toContain('SWM Triple-Volume Throughput Analysis');
  });
});
