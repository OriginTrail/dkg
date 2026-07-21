import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoreBenchmarkResult } from '../benchmarks/store-scenario.js';

interface Run extends StoreBenchmarkResult { repetition: number; heapLimitMiB: number; cleanupMs: number }
interface Distribution { minimum: number; median: number; p95: number; maximum: number }
interface Summary {
  objectCount: number;
  samples: number;
  inventoryPreparationMs: Distribution;
  enumerateMs: Distribution;
  hasHitP95Ms: Distribution;
  fullReadMebibytesPerSecond: Distribution;
  verifiedAdmissionP95Ms: Distribution;
  largePutMebibytesPerSecond: Distribution;
  largeReadMebibytesPerSecond: Distribution;
  rangeReassemblyMebibytesPerSecond: Distribution;
  totalMs: Distribution;
  maxRssBytes: Distribution;
}
interface Report {
  schema: 'dkg-wal-packed-object-store-benchmark-v1';
  recordedAt: string;
  runtime: { node: string; platform: string; arch: string };
  host: { cpuModel: string; logicalCpuCount: number; totalMemoryBytes: number };
  executionModel: 'fresh-process-per-size';
  fixturePolicy: 'sqlite-index-cardinality-fixture; canonical-verified-admission-and-transfer';
  sizes: number[];
  repetitions: number;
  maximumTimeRegressionRatio: number;
  results: Run[];
  summaries: Summary[];
}

function integerArgument(name: string, fallback: number): number {
  const argument = process.argv.find(value => value.startsWith(`--${name}=`));
  if (argument === undefined) return fallback;
  const value = Number(argument.slice(name.length + 3));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function sizes(): number[] {
  const argument = process.argv.find(value => value.startsWith('--sizes='));
  if (argument === undefined) return process.argv.includes('--matrix')
    ? [10_000, 100_000, 1_000_000, 10_000_000]
    : [10_000, 100_000];
  const values = argument.slice(8).split(',').map(Number);
  if (values.some(value => !Number.isSafeInteger(value) || value < 2)) throw new Error('sizes must contain integers >= 2');
  return values;
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  const split = offset % values.length;
  return [...values.slice(split), ...values.slice(0, split)];
}

function distribution(values: number[]): Distribution {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return {
    minimum: ordered[0]!,
    median: ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1]!,
    maximum: ordered.at(-1)!,
  };
}

function summarize(matrix: number[], results: Run[]): Summary[] {
  return matrix.map((objectCount) => {
    const runs = results.filter(result => result.objectCount === objectCount);
    return {
      objectCount,
      samples: runs.length,
      inventoryPreparationMs: distribution(runs.map(run => run.inventoryPreparationMs)),
      enumerateMs: distribution(runs.map(run => run.enumerate.totalMs)),
      hasHitP95Ms: distribution(runs.map(run => run.hasHit.p95Ms)),
      fullReadMebibytesPerSecond: distribution(runs.map(run => run.fullRead.mebibytesPerSecond)),
      verifiedAdmissionP95Ms: distribution(runs.map(run => run.verifiedAdmission.p95Ms)),
      largePutMebibytesPerSecond: distribution(runs.map(run => run.largeObject.putMebibytesPerSecond)),
      largeReadMebibytesPerSecond: distribution(runs.map(run => run.largeObject.fullReadMebibytesPerSecond)),
      rangeReassemblyMebibytesPerSecond: distribution(runs.map(run => run.rangeReassembly.mebibytesPerSecond)),
      totalMs: distribution(runs.map(run => run.totalMs)),
      maxRssBytes: distribution(runs.map(run => run.memory.maxRssBytes)),
    };
  });
}

const matrix = sizes();
const repetitions = integerArgument('repetitions', 1);
const args = new Set(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, 'store-benchmark-worker.ts');
const baselinePath = resolve(here, '../benchmarks/store-baseline.json');
const forwarded = ['operation-samples', 'read-samples', 'admission-samples', 'large-payload-bytes']
  .map(name => process.argv.find(value => value.startsWith(`--${name}=`)))
  .filter((value): value is string => value !== undefined);
const results: Run[] = [];
for (let repetition = 0; repetition < repetitions; repetition += 1) {
  for (const objectCount of rotate(matrix, repetition)) {
    const heapLimitMiB = objectCount >= 10_000_000 ? 4_096 : objectCount >= 1_000_000 ? 2_048 : 1_024;
    process.stderr.write(`packed store benchmark: starting N=${objectCount} repetition=${repetition + 1}/${repetitions}\n`);
    const output = execFileSync(process.execPath, [
      `--max-old-space-size=${heapLimitMiB}`,
      '--expose-gc',
      '--import',
      'tsx',
      worker,
      `--size=${objectCount}`,
      ...forwarded,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const result = { ...(JSON.parse(output) as StoreBenchmarkResult & { cleanupMs: number }), repetition, heapLimitMiB };
    results.push(result);
    process.stderr.write(
      `packed store benchmark: finished N=${objectCount}; preparation=${result.inventoryPreparationMs.toFixed(1)}ms `
      + `(excluded); enumerate=${result.enumerate.totalMs.toFixed(1)}ms; measured=${result.totalMs.toFixed(1)}ms; `
      + `cleanup=${result.cleanupMs.toFixed(1)}ms\n`,
    );
  }
}
const report: Report = {
  schema: 'dkg-wal-packed-object-store-benchmark-v1',
  recordedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  host: { cpuModel: cpus()[0]?.model ?? 'unknown', logicalCpuCount: cpus().length, totalMemoryBytes: totalmem() },
  executionModel: 'fresh-process-per-size',
  fixturePolicy: 'sqlite-index-cardinality-fixture; canonical-verified-admission-and-transfer',
  sizes: matrix,
  repetitions,
  maximumTimeRegressionRatio: 2,
  results,
  summaries: summarize(matrix, results),
};
if (args.has('--check')) {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Report;
  for (const result of results) {
    const prior = baseline.results.find(candidate => candidate.objectCount === result.objectCount);
    if (prior === undefined) throw new Error(`store baseline has no N=${result.objectCount}`);
    for (const [label, current, previous] of [
      ['enumeration', result.enumerate.totalMs, prior.enumerate.totalMs],
      ['verified admission', result.verifiedAdmission.totalMs, prior.verifiedAdmission.totalMs],
      ['large-object put', result.largeObject.putMs, prior.largeObject.putMs],
    ] as const) {
      const ratio = current / previous;
      if (ratio > baseline.maximumTimeRegressionRatio) {
        throw new Error(`${label} at N=${result.objectCount} regressed ${ratio.toFixed(3)}x`);
      }
    }
  }
}
if (args.has('--write-baseline')) await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
