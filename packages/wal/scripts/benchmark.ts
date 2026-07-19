import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReconciliationBenchmark, type ReconciliationBenchmarkResult } from '../benchmarks/scenario.js';

interface BenchmarkReport {
  schema: 'dkg-wal-reconciliation-benchmark-v1';
  recordedAt: string;
  runtime: { node: string; platform: string; arch: string };
  eachSideDifference: number;
  maximumTotalTimeRegressionRatio: number;
  results: ReconciliationBenchmarkResult[];
}

const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const writeBaseline = args.has('--write-baseline');
const checkBaseline = args.has('--check');
const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = resolve(here, '../benchmarks/reconciliation-baseline.json');
const sizes = full ? [10_000, 100_000, 1_000_000] : [10_000, 100_000];
const eachSideDifference = 16;
const results = sizes.map((size) => runReconciliationBenchmark(size, eachSideDifference));
const report: BenchmarkReport = {
  schema: 'dkg-wal-reconciliation-benchmark-v1',
  recordedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  eachSideDifference,
  maximumTotalTimeRegressionRatio: 1.5,
  results
};

if (checkBaseline) {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as BenchmarkReport;
  for (const result of results) {
    const prior = baseline.results.find((candidate) => candidate.setSize === result.setSize);
    if (prior === undefined) throw new Error(`baseline has no N=${result.setSize} result`);
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
