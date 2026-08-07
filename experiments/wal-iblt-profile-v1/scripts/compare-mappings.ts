import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ReconciliationMappingCandidate = 'floating-point' | 'integer-only';

interface ReconciliationBenchmarkResult {
  mappingCandidate: ReconciliationMappingCandidate;
  setSize: number;
  differenceSize: number;
  setupMs: number;
  streamMs: number;
  totalMs: number;
  symbols: number;
  canonicalWireBytes: number;
  memory: { maxRssBytes: number };
}

interface Sample extends ReconciliationBenchmarkResult {
  repetition: number;
  heapLimitMiB: number;
}

interface Distribution {
  minimum: number;
  median: number;
  p95: number;
  maximum: number;
}

interface CandidateSummary {
  mappingCandidate: ReconciliationMappingCandidate;
  setSize: number;
  samples: number;
  setupMs: Distribution;
  streamMs: Distribution;
  totalMs: Distribution;
  symbols: Distribution;
  canonicalWireBytes: Distribution;
  maxRssBytes: Distribution;
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
  const sizes = argument === undefined
    ? [10_000, 100_000, 1_000_000, 10_000_000]
    : argument.slice('--sizes='.length).split(',').map(Number);
  if (sizes.length === 0 || sizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) {
    throw new Error('sizes must be a comma-separated list of positive safe integers');
  }
  return sizes;
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  const split = offset % values.length;
  return [...values.slice(split), ...values.slice(0, split)];
}

function heapLimitMiB(setSize: number): number {
  if (setSize >= 10_000_000) return 12_288;
  if (setSize >= 1_000_000) return 4_096;
  if (setSize >= 100_000) return 2_048;
  return 1_024;
}

function distribution(values: number[]): Distribution {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) throw new Error('cannot summarize an empty sample');
  const middle = Math.floor(ordered.length / 2);
  return {
    minimum: ordered[0],
    median: ordered.length % 2 === 0
      ? (ordered[middle - 1] + ordered[middle]) / 2
      : ordered[middle],
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
    maximum: ordered.at(-1)!
  };
}

function summarize(
  mappings: readonly ReconciliationMappingCandidate[],
  sizes: readonly number[],
  samples: readonly Sample[]
): CandidateSummary[] {
  return mappings.flatMap((mappingCandidate) => sizes.map((setSize) => {
    const selected = samples.filter((sample) => (
      sample.mappingCandidate === mappingCandidate && sample.setSize === setSize
    ));
    return {
      mappingCandidate,
      setSize,
      samples: selected.length,
      setupMs: distribution(selected.map((sample) => sample.setupMs)),
      streamMs: distribution(selected.map((sample) => sample.streamMs)),
      totalMs: distribution(selected.map((sample) => sample.totalMs)),
      symbols: distribution(selected.map((sample) => sample.symbols)),
      canonicalWireBytes: distribution(selected.map((sample) => sample.canonicalWireBytes)),
      maxRssBytes: distribution(selected.map((sample) => sample.memory.maxRssBytes))
    };
  }));
}

const sizes = parseSizes();
const repetitions = integerArgument('repetitions', 3);
const eachSideDifference = integerArgument('each-side-difference', 16);
const mappings: ReconciliationMappingCandidate[] = ['floating-point', 'integer-only'];
const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, '../../../packages/wal/scripts/benchmark-worker.ts');
const outputPath = resolve(here, '../results/mapping-comparison-latest.json');
const samples: Sample[] = [];

for (let repetition = 0; repetition < repetitions; repetition += 1) {
  const rotatedSizes = rotate(sizes, repetition);
  for (const setSize of rotatedSizes) {
    for (const mappingCandidate of rotate(mappings, repetition)) {
      const heapLimit = heapLimitMiB(setSize);
      process.stderr.write(
        `mapping=${mappingCandidate} N=${setSize} repetition=${repetition + 1}/${repetitions}\n`
      );
      const output = execFileSync(process.execPath, [
        `--max-old-space-size=${heapLimit}`,
        '--expose-gc',
        '--import',
        'tsx',
        workerPath,
        `--size=${setSize}`,
        `--each-side-difference=${eachSideDifference}`,
        `--mapping=${mappingCandidate}`
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      samples.push({
        ...(JSON.parse(output) as ReconciliationBenchmarkResult),
        repetition,
        heapLimitMiB: heapLimit
      });
    }
  }
}

const summaries = summarize(mappings, sizes, samples);
const ratios = sizes.map((setSize) => {
  const floating = summaries.find((summary) => (
    summary.mappingCandidate === 'floating-point' && summary.setSize === setSize
  ))!;
  const integer = summaries.find((summary) => (
    summary.mappingCandidate === 'integer-only' && summary.setSize === setSize
  ))!;
  return {
    setSize,
    integerToFloatingSetupRatio: integer.setupMs.median / floating.setupMs.median,
    integerToFloatingStreamRatio: integer.streamMs.median / floating.streamMs.median,
    integerToFloatingTotalRatio: integer.totalMs.median / floating.totalMs.median,
    integerToFloatingSymbolRatio: integer.symbols.median / floating.symbols.median,
    integerToFloatingWireByteRatio: integer.canonicalWireBytes.median / floating.canonicalWireBytes.median
  };
});

const report = {
  schema: 'dkg-wal-iblt-mapping-comparison-v1',
  recordedAt: new Date().toISOString(),
  revision: process.env.GIT_COMMIT ?? 'working-tree',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  host: {
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem()
  },
  executionModel: 'fresh-process-per-candidate-and-size',
  rotation: 'size order rotates by repetition; candidate order reverses on each repetition',
  sizes,
  repetitions,
  eachSideDifference,
  summaries,
  ratios,
  samples
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, ratios, summaries }, null, 2)}\n`);
