import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  createOperationContext,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { DKGPublisher, type PublisherWalShadowWriter } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  PackedWalObjectStore,
  RDF_POLICY_MEDIA_TYPE_V1,
  WalControlStore,
  WalLocalCommitter,
  createRdfPolicyV1,
  encodePublicDkgPayload,
  encodeRdfPolicyV1,
  type RdfPolicyAdmissionV1,
} from '@origintrail-official/dkg-wal';
import { ethers } from 'ethers';
import { DkgWalPublisherShadowWriter } from '../src/wal/local-commit.js';

const RESULT_PREFIX = 'WAL_SHADOW_WRITE_BENCHMARK_RESULT=';
const WAL_WRITER = new ethers.Wallet(`0x${'75'.repeat(32)}`);
const POLICY_WRITER = new ethers.Wallet(`0x${'76'.repeat(32)}`);
const NAMESPACE_ID = new Uint8Array(32).fill(0x71);
const POLICY_REQUEST_DIGEST = new Uint8Array(32).fill(0x72);
const MEMBERSHIP_CHECKPOINT_ID = new Uint8Array(32).fill(0x73);
const CONTEXT_GRAPH_ID = 'wal-shadow-write-benchmark';
const GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory`;
const TRACKED_GRAPH_METHODS = [
  'query',
  'insert',
  'deleteByPattern',
  'deleteBySubjectPrefix',
  'dropGraph',
  'createGraph',
] as const;

type Arm = 'current-sync-authoritative' | 'parallel-shadow-wal';

interface ChildResult {
  schema: 'dkg-wal-013-write-arm-v1';
  arm: Arm;
  operations: number;
  warmupOperations: number;
  quadsPerOperation: number;
  latencyMs: number[];
  cpuSeconds: number;
  peakRssBytes: number;
  rssIncreaseBytes: number;
  graphOperations: Record<string, number>;
  durableWalObjects: number;
  durableCheckpoints: number;
  propagationClaims: number;
}

interface Summary {
  samples: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maximumMs: number;
  medianCpuSeconds: number;
  medianPeakRssBytes: number;
  medianRssIncreaseBytes: number;
  totalGraphOperations: Record<string, number>;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) throw new Error('cannot summarize an empty sample');
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function summarize(runs: readonly ChildResult[]): Summary {
  const latency = runs.flatMap(run => run.latencyMs).sort((left, right) => left - right);
  const totalGraphOperations: Record<string, number> = {};
  for (const run of runs) {
    for (const [method, count] of Object.entries(run.graphOperations)) {
      totalGraphOperations[method] = (totalGraphOperations[method] ?? 0) + count;
    }
  }
  return {
    samples: latency.length,
    medianMs: percentile(latency, 50),
    p95Ms: percentile(latency, 95),
    p99Ms: percentile(latency, 99),
    maximumMs: latency.at(-1)!,
    medianCpuSeconds: median(runs.map(run => run.cpuSeconds)),
    medianPeakRssBytes: median(runs.map(run => run.peakRssBytes)),
    medianRssIncreaseBytes: median(runs.map(run => run.rssIncreaseBytes)),
    totalGraphOperations,
  };
}

function overheadPercent(current: number, parallel: number): number {
  return current === 0 ? Number.POSITIVE_INFINITY : ((parallel - current) / current) * 100;
}

function quads(index: number, count: number): Quad[] {
  const subject = `urn:wal:benchmark:root:${index}`;
  return Array.from({ length: count }, (_, quadIndex) => ({
    subject,
    predicate: `https://schema.org/benchmarkValue/${quadIndex}`,
    object: `"value-${index}-${quadIndex}"`,
    graph: '',
  }));
}

function instrumentGraphStore(store: OxigraphStore): Record<string, number> {
  const counts: Record<string, number> = {};
  const methods = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of TRACKED_GRAPH_METHODS) {
    const original = methods[name];
    if (typeof original !== 'function') continue;
    counts[name] = 0;
    methods[name] = (...args: unknown[]) => {
      counts[name] = counts[name]! + 1;
      return original.apply(store, args);
    };
  }
  return counts;
}

function policyAdmission(
  policyObjectId: Uint8Array,
  policy: ReturnType<typeof createRdfPolicyV1>,
): RdfPolicyAdmissionV1 {
  return {
    policyObjectId,
    policy,
    membershipCheckpointId: MEMBERSHIP_CHECKPOINT_ID,
    namespaceId: NAMESPACE_ID,
    policyNamespaceId: NAMESPACE_ID,
    writerId: ethers.getBytes(POLICY_WRITER.address),
    // The signed-bundle admission path verifies these bytes before constructing
    // this context. They are not re-read by the measured local commit.
    canonicalWalObjectBytes: new Uint8Array([0]),
  };
}

async function runChild(
  arm: Arm,
  operations: number,
  warmupOperations: number,
  quadsPerOperation: number,
): Promise<ChildResult> {
  const root = mkdtempSync(join(tmpdir(), 'dkg-wal-013-write-bench-'));
  let control: WalControlStore | undefined;
  let objectStore: PackedWalObjectStore | undefined;
  const store = new OxigraphStore();
  const graphOperations = instrumentGraphStore(store);
  try {
    let walShadowWriter: PublisherWalShadowWriter | undefined;
    if (arm === 'parallel-shadow-wal') {
      objectStore = new PackedWalObjectStore({ root });
      control = new WalControlStore({ root });
      const policy = createRdfPolicyV1({
        allowedGraphPrefixes: ['did:dkg:context-graph:'],
        maxQuadsPerMutation: 1_000_000n,
        maxWalObjectBytes: 1_073_741_824n,
        allowedPayloadKinds: [0n, 1n],
      });
      const policyPayload = encodePublicDkgPayload({
        payloadKind: 1n,
        codec: 0n,
        mediaType: RDF_POLICY_MEDIA_TYPE_V1,
        contentBytes: encodeRdfPolicyV1(policy),
      });
      const committedPolicy = await control.commitLocal({
        namespaceId: NAMESPACE_ID,
        writerId: ethers.getBytes(POLICY_WRITER.address),
        writerEpoch: 0n,
        payloadBytes: policyPayload.canonicalBytes,
        signer: {
          address: POLICY_WRITER.address,
          signMessage: bytes => POLICY_WRITER.signMessage(bytes),
        },
        idempotencyKey: 'wal-013-benchmark-policy',
        requestDigest: POLICY_REQUEST_DIGEST,
      });
      const admittedPolicy = policyAdmission(committedPolicy.objectId, policy);
      const durableWriter = new DkgWalPublisherShadowWriter({
        committer: new WalLocalCommitter({ control }),
        contextResolver: {
          resolve: async () => ({
            policyAdmission: admittedPolicy,
            writerEpoch: 0n,
            memberWriterIds: [ethers.getBytes(WAL_WRITER.address)],
          }),
        },
      });
      walShadowWriter = {
        write: async mutation => {
          try {
            return await durableWriter.write(mutation);
          } catch (error) {
            const cause = error instanceof Error ? error.cause : undefined;
            process.stderr.write(
              `WAL benchmark durable write failed: ${String(error)}${cause === undefined ? '' : `; cause=${String(cause)}`}\n`,
            );
            throw error;
          }
        },
      };
    }
    const publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: WAL_WRITER.privateKey,
      ...(walShadowWriter === undefined ? {} : { walShadowWriter }),
    });
    let peakRssBytes = process.memoryUsage().rss;
    for (let index = 0; index < warmupOperations; index += 1) {
      await publisher.share(CONTEXT_GRAPH_ID, quads(index, quadsPerOperation), {
        localOnly: true,
        publisherPeerId: 'wal-benchmark-peer',
        operationCtx: {
          ...createOperationContext('share'),
          operationId: `warmup-${arm}-${index}`,
        },
      });
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
    globalThis.gc?.();
    const rssBefore = process.memoryUsage().rss;
    peakRssBytes = Math.max(peakRssBytes, rssBefore);
    const cpuBefore = process.cpuUsage();
    const latencyMs: number[] = [];
    let propagationClaims = 0;
    for (let index = 0; index < operations; index += 1) {
      const logicalIndex = warmupOperations + index;
      const startedAt = performance.now();
      const result = await publisher.share(
        CONTEXT_GRAPH_ID,
        quads(logicalIndex, quadsPerOperation),
        {
          localOnly: true,
          publisherPeerId: 'wal-benchmark-peer',
          operationCtx: {
            ...createOperationContext('share'),
            operationId: `measured-${arm}-${logicalIndex}`,
          },
        },
      );
      latencyMs.push(performance.now() - startedAt);
      if (arm === 'current-sync-authoritative') {
        if (result.wal !== undefined) throw new Error('current-sync arm unexpectedly produced WAL state');
      } else {
        if (result.wal?.status !== 'committed' || result.wal.objects.length !== 1) {
          throw new Error(`parallel arm did not commit exactly one WAL object: ${JSON.stringify(result.wal)}`);
        }
        if (result.wal.propagationStatus !== 'not-claimed') propagationClaims += 1;
      }
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
    const cpu = process.cpuUsage(cpuBefore);
    const integrity = control?.integrityScan();
    return {
      schema: 'dkg-wal-013-write-arm-v1',
      arm,
      operations,
      warmupOperations,
      quadsPerOperation,
      latencyMs,
      cpuSeconds: (cpu.user + cpu.system) / 1_000_000,
      peakRssBytes,
      rssIncreaseBytes: Math.max(0, peakRssBytes - rssBefore),
      graphOperations,
      // The signed policy carrier/checkpoint is setup state, not a measured
      // content mutation. Subtract that one fixed lane entry.
      durableWalObjects: Math.max(0, (integrity?.objects ?? 0) - 1),
      durableCheckpoints: Math.max(0, (integrity?.checkpoints ?? 0) - 1),
      propagationClaims,
    };
  } finally {
    control?.close();
    objectStore?.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function runArmProcess(
  arm: Arm,
  operations: number,
  warmupOperations: number,
  quadsPerOperation: number,
): ChildResult {
  const script = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, [
    '--expose-gc',
    '--import',
    'tsx',
    script,
    `--arm=${arm}`,
    `--operations=${operations}`,
    `--warmup=${warmupOperations}`,
    `--quads-per-operation=${quadsPerOperation}`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(`benchmark arm ${arm} failed:\n${child.stdout}\n${child.stderr}`);
  }
  const line = child.stdout.split('\n').find(value => value.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`benchmark arm ${arm} emitted no machine result`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as ChildResult;
}

async function main(): Promise<void> {
  const arm = argument('arm') as Arm | undefined;
  const operations = positiveInteger('operations', 250);
  const warmupOperations = positiveInteger('warmup', 25);
  const quadsPerOperation = positiveInteger('quads-per-operation', 100);
  if (arm !== undefined) {
    if (arm !== 'current-sync-authoritative' && arm !== 'parallel-shadow-wal') {
      throw new Error(`unsupported arm: ${arm}`);
    }
    const result = await runChild(arm, operations, warmupOperations, quadsPerOperation);
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
    return;
  }

  const repetitions = positiveInteger('repetitions', 3);
  if (repetitions < 3 && process.argv.includes('--check')) {
    throw new Error('--check requires at least three repetitions');
  }
  const runs: ChildResult[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const order: readonly Arm[] = repetition % 2 === 0
      ? ['current-sync-authoritative', 'parallel-shadow-wal']
      : ['parallel-shadow-wal', 'current-sync-authoritative'];
    for (const currentArm of order) {
      runs.push(runArmProcess(currentArm, operations, warmupOperations, quadsPerOperation));
    }
  }
  const current = summarize(runs.filter(run => run.arm === 'current-sync-authoritative'));
  const parallel = summarize(runs.filter(run => run.arm === 'parallel-shadow-wal'));
  const overhead = {
    p95LatencyPercent: overheadPercent(current.p95Ms, parallel.p95Ms),
    p99LatencyPercent: overheadPercent(current.p99Ms, parallel.p99Ms),
    cpuSecondsPercent: overheadPercent(current.medianCpuSeconds, parallel.medianCpuSeconds),
    peakRssPercent: overheadPercent(current.medianPeakRssBytes, parallel.medianPeakRssBytes),
  };
  const gates = {
    p95Latency: overhead.p95LatencyPercent <= 20,
    p99Latency: overhead.p99LatencyPercent <= 30,
    cpuOrPeakRss: overhead.cpuSecondsPercent <= 25 || overhead.peakRssPercent <= 25,
    oneObjectAndCheckpointPerOperation: runs
      .filter(run => run.arm === 'parallel-shadow-wal')
      .every(run => run.durableWalObjects === operations + warmupOperations
        && run.durableCheckpoints === operations + warmupOperations),
    noPropagationClaim: runs.every(run => run.propagationClaims === 0),
  };
  const report = {
    schema: 'dkg-wal-013-write-benchmark-v1',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    repetitions,
    operationsPerRepetition: operations,
    warmupOperations,
    quadsPerOperation,
    current,
    parallel,
    overhead,
    gates,
    passed: Object.values(gates).every(Boolean),
    runs,
  };
  const output = argument('output');
  if (output !== undefined) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const { runs: _rawRuns, ...summary } = report;
  const boundedResult = {
    ...summary,
    rawRunCount: report.runs.length,
    ...(output === undefined ? {} : { receipt: output }),
  };
  process.stdout.write(`${JSON.stringify(boundedResult, null, 2)}\n`);
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(boundedResult)}\n`);
  if (process.argv.includes('--check') && !report.passed) process.exitCode = 1;
}

await main();
