import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const benchmark = require('../scripts/swm-large-payload-benchmark.cjs') as {
  buildBenchmarkPlan: (config: Record<string, unknown>) => {
    payloadBytesPerNode: number;
    chunkBytes: number;
    chunksPerNode: number;
    totalOperations: number;
    totalPayloadBytes: number;
    totalPayloadMiB: number;
    rootPrefix: string;
    metadataGraph: string;
  };
  makePayload: (runId: string, nodeNumber: number, chunkNumber: number, sizeBytes: number) => string;
  parseBenchmarkArgs: (argv: string[], env: Record<string, string | undefined>) => Record<string, unknown>;
  payloadBytesForChunk: (plan: { payloadBytesPerNode: number; chunkBytes: number }, chunkNumber: number) => number;
};

describe('swm large payload benchmark', () => {
  it('parses live-devnet benchmark arguments and hides auth from the sanitized config', () => {
    const config = benchmark.parseBenchmarkArgs([
      '--',
      '--ports',
      '19101,19102,19103',
      '--context-graph-id',
      'devnet-test',
      '--payload-mib-per-node',
      '12.5',
      '--chunk-mib',
      '0.25',
      '--write-concurrency',
      '2',
      '--replication-timeout-ms',
      '1000',
      '--poll-interval-ms',
      '100',
      '--request-timeout-ms',
      '2000',
      '--query-timeout-ms',
      '3000',
      '--run-id',
      'fixed-run',
      '--namespace',
      'swm-regression',
      '--predicate',
      'urn:test:payload',
      '--progress-every',
      '5',
      '--no-scan-logs',
      '--auth-token',
      'secret-token',
    ], {});

    expect(config).toMatchObject({
      ports: [19101, 19102, 19103],
      nodes: 3,
      contextGraphId: 'devnet-test',
      payloadMiBPerNode: 12.5,
      chunkMiB: 0.25,
      writeConcurrency: 2,
      replicationTimeoutMs: 1000,
      pollIntervalMs: 100,
      requestTimeoutMs: 2000,
      queryTimeoutMs: 3000,
      runId: 'fixed-run',
      namespace: 'swm-regression',
      predicate: 'urn:test:payload',
      progressEvery: 5,
      scanLogs: false,
      authToken: 'secret-token',
    });
  });

  it('derives ports and auth from environment defaults', () => {
    const config = benchmark.parseBenchmarkArgs([], {
      DKG_BENCH_SWM_API_PORT_BASE: '18101',
      DKG_BENCH_SWM_NODES: '2',
      DKG_BENCH_SWM_PAYLOAD_MIB_PER_NODE: '1',
      DKG_BENCH_SWM_CHUNK_MIB: '0.5',
      DKG_BENCH_AUTH_TOKEN: 'env-token',
      DKG_BENCH_SWM_SCAN_LOGS: '0',
    });

    expect(config).toMatchObject({
      ports: [18101, 18102],
      nodes: 2,
      payloadMiBPerNode: 1,
      chunkMiB: 0.5,
      authToken: 'env-token',
      scanLogs: false,
    });
  });

  it('plans exact chunk counts and a smaller final chunk when needed', () => {
    const plan = benchmark.buildBenchmarkPlan({
      contextGraphId: 'devnet-test',
      ports: [9201, 9202],
      payloadMiBPerNode: 1.25,
      chunkMiB: 0.5,
      runId: 'plan-run',
      namespace: 'swm-large-payload',
    });

    expect(plan).toMatchObject({
      payloadBytesPerNode: 1.25 * 1024 * 1024,
      chunkBytes: 0.5 * 1024 * 1024,
      chunksPerNode: 3,
      totalOperations: 6,
      totalPayloadBytes: 2.5 * 1024 * 1024,
      totalPayloadMiB: 2.5,
      rootPrefix: 'urn:dkg:benchmark:swm-large-payload:plan-run:',
      metadataGraph: 'did:dkg:context-graph:devnet-test/_shared_memory_meta',
    });
    expect(benchmark.payloadBytesForChunk(plan, 1)).toBe(512 * 1024);
    expect(benchmark.payloadBytesForChunk(plan, 2)).toBe(512 * 1024);
    expect(benchmark.payloadBytesForChunk(plan, 3)).toBe(256 * 1024);
  });

  it('generates payload literals at the requested byte size', () => {
    const payload = benchmark.makePayload('payload-run', 5, 7, 1024);

    expect(Buffer.byteLength(payload, 'utf8')).toBe(1024);
    expect(payload).toContain('run=payload-run node=5 chunk=7');
  });
});
