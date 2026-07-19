import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReconciliationBenchmarkResult } from '../benchmarks/scenario.js';

interface RotatedBenchmarkResult extends ReconciliationBenchmarkResult {
  repetition: number;
  heapLimitMiB: number;
}

interface Distribution {
  minimum: number;
  median: number;
  p95: number;
  maximum: number;
}

interface BenchmarkSummary {
  setSize: number;
  samples: number;
  scenarioBuildMs: Distribution;
  encoderSetupMs: Distribution;
  decoderSetupMs: Distribution;
  setupMs: Distribution;
  streamMs: Distribution;
  totalMs: Distribution;
  maxRssBytes: Distribution;
}

interface BenchmarkReport {
  schema: 'dkg-wal-reconciliation-benchmark-v2';
  recordedAt: string;
  runtime: { node: string; platform: string; arch: string };
  host: { cpuModel: string; logicalCpuCount: number; totalMemoryBytes: number };
  executionModel: 'fresh-process-per-size';
  sizes: number[];
  repetitions: number;
  eachSideDifference: number;
  maximumTotalTimeRegressionRatio: number;
  results: RotatedBenchmarkResult[];
  summaries: BenchmarkSummary[];
}

function integerArgument(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (argument === undefined) return fallback;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function parseSizes(): number[] {
  const argument = process.argv.find((value) => value.startsWith('--sizes='));
  if (argument === undefined) return process.argv.includes('--matrix')
    ? [10_000, 100_000, 1_000_000, 10_000_000]
    : [10_000, 100_000];
  const sizes = argument.slice('--sizes='.length).split(',').map(Number);
  if (sizes.length === 0 || sizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) {
    throw new Error('sizes must be a comma-separated list of positive safe integers');
  }
  return sizes;
}

function heapLimitMiB(setSize: number): number {
  if (setSize >= 10_000_000) return 12_288;
  if (setSize >= 1_000_000) return 4_096;
  if (setSize >= 100_000) return 2_048;
  return 1_024;
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  const split = offset % values.length;
  return [...values.slice(split), ...values.slice(0, split)];
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) throw new Error('cannot summarize an empty benchmark result');
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
  return {
    minimum: ordered[0],
    median,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
    maximum: ordered.at(-1)!
  };
}

function summariesFor(targetSizes: number[], values: RotatedBenchmarkResult[]): BenchmarkSummary[] {
  return targetSizes.map((setSize) => {
    const samples = values.filter((value) => value.setSize === setSize);
    return {
      setSize,
      samples: samples.length,
      scenarioBuildMs: distribution(samples.map((sample) => sample.scenarioBuildMs)),
      encoderSetupMs: distribution(samples.map((sample) => sample.encoderSetupMs)),
      decoderSetupMs: distribution(samples.map((sample) => sample.decoderSetupMs)),
      setupMs: distribution(samples.map((sample) => sample.setupMs)),
      streamMs: distribution(samples.map((sample) => sample.streamMs)),
      totalMs: distribution(samples.map((sample) => sample.totalMs)),
      maxRssBytes: distribution(samples.map((sample) => sample.memory.maxRssBytes))
    };
  });
}

const args = new Set(process.argv.slice(2));
const writeBaseline = args.has('--write-baseline');
const checkBaseline = args.has('--check');
const sizes = parseSizes();
const repetitions = integerArgument('repetitions', 1);
const eachSideDifference = integerArgument('each-side-difference', 16);
const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, 'benchmark-worker.ts');
const baselinePath = resolve(here, '../benchmarks/reconciliation-baseline.json');
const results: RotatedBenchmarkResult[] = [];

for (let repetition = 0; repetition < repetitions; repetition += 1) {
  for (const setSize of rotate(sizes, repetition)) {
    const heapLimit = heapLimitMiB(setSize);
    const output = execFileSync(process.execPath, [
      `--max-old-space-size=${heapLimit}`,
      '--expose-gc',
      '--import',
      'tsx',
      workerPath,
      `--size=${setSize}`,
      `--each-side-difference=${eachSideDifference}`
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    results.push({
      ...(JSON.parse(output) as ReconciliationBenchmarkResult),
      repetition,
      heapLimitMiB: heapLimit
    });
  }
}

const report: BenchmarkReport = {
  schema: 'dkg-wal-reconciliation-benchmark-v2',
  recordedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  host: {
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem()
  },
  executionModel: 'fresh-process-per-size',
  sizes,
  repetitions,
  eachSideDifference,
  maximumTotalTimeRegressionRatio: 1.5,
  results,
  summaries: summariesFor(sizes, results)
};

if (checkBaseline) {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as BenchmarkReport;
  for (const result of results) {
    const prior = baseline.results.find((candidate) => candidate.setSize === result.setSize);
    if (prior === undefined) throw new Error(`baseline has no N=${result.setSize}`);
    const ratio = result.totalMs / prior.totalMs;
    if (ratio > baseline.maximumTotalTimeRegressionRatio) {
      throw new Error(
        `N=${result.setSize} total time regressed by ${ratio.toFixed(3)}x; ` +
        `limit is ${baseline.maximumTotalTimeRegressionRatio.toFixed(3)}x`
      );
    }
  }
}

if (writeBaseline) await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
