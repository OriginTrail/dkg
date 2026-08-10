#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const WARMUPS = 10;
const TRIALS = 30;
const REPETITIONS = 3;
const REGRESSION_LIMIT_PERCENT = 10;

const fixture = Object.freeze({
  kind: 'delete-subjects',
  input: Object.freeze({
    graphUri: 'urn:benchmark:structured-mutation',
    subjects: Object.freeze(Array.from(
      { length: 100_000 },
      (_, index) => `urn:benchmark:subject:${index.toString().padStart(6, '0')}`,
    )),
  }),
});
const fixtureDigest = createHash('sha256')
  .update(JSON.stringify(fixture))
  .digest('hex');

if (process.argv.includes('--child')) {
  await runChild();
} else {
  runParent();
}

async function runChild() {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('benchmark child requires --expose-gc');
  }
  const bounded = await import('../dist/bounded-structured-mutation.js');
  const root = await import('../dist/index.js');
  let prepare;
  if (typeof root.captureStructuredMutationSnapshot === 'function') {
    const materialization = await import('../dist/structured-mutation-materialization-internal.js');
    prepare = () => {
      const result = materialization.materializeStructuredMutation(
        root.captureStructuredMutationSnapshot(fixture),
      );
      // Match the pre-change path's returned lifetime: retain only the generated
      // update, not the new API's diagnostic reference back to its input snapshot.
      return result.outcome === 'execute' ? result.update : undefined;
    };
  } else {
    prepare = () => {
      const normalized = bounded.normalizeStructuredMutation(fixture);
      bounded.captureStructuredMutationEffects(normalized);
      return bounded.buildStructuredMutationUpdate(normalized);
    };
  }

  for (let index = 0; index < WARMUPS; index += 1) prepare();
  globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  let witness = 0;
  for (let index = 0; index < TRIALS; index += 1) {
    const result = prepare();
    witness += typeof result === 'string' ? result.length : 0;
  }
  const cpu = process.cpuUsage(cpuBefore);
  globalThis.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const maxRss = process.resourceUsage().maxRSS;
  process.stdout.write(`${JSON.stringify({
    cpuMicros: cpu.user + cpu.system,
    retainedHeapBytes: Math.max(0, heapAfter - heapBefore),
    maxRssBytes: process.platform === 'darwin' ? maxRss : maxRss * 1024,
    witness,
  })}\n`);
}

function runParent() {
  const options = parseArgs(process.argv.slice(2));
  assertNode22();
  if (existsSync(options.output)) {
    throw new Error(`refusing to overwrite benchmark output ${options.output}`);
  }
  const repetitions = Array.from({ length: REPETITIONS }, () => runFreshChild());
  const metrics = Object.freeze({
    cpuMicros: median(repetitions.map(({ cpuMicros }) => cpuMicros)),
    retainedHeapBytes: median(repetitions.map(({ retainedHeapBytes }) => retainedHeapBytes)),
    maxRssBytes: median(repetitions.map(({ maxRssBytes }) => maxRssBytes)),
  });
  const metadata = environmentMetadata();
  let comparison;
  if (options.mode === 'compare') {
    const baseline = readBenchmark(options.baseline);
    assertComparable(baseline, metadata);
    comparison = Object.freeze({
      baseline: options.baseline,
      cpuPercent: percentage(metrics.cpuMicros, baseline.metrics.cpuMicros),
      retainedHeapPercent: percentage(
        metrics.retainedHeapBytes,
        baseline.metrics.retainedHeapBytes,
      ),
      maxRssPercent: percentage(metrics.maxRssBytes, baseline.metrics.maxRssBytes),
    });
  }
  const result = Object.freeze({
    schemaVersion: 1,
    mode: options.mode,
    metadata,
    fixture: Object.freeze({
      digest: fixtureDigest,
      mutationKind: fixture.kind,
      subjects: fixture.input.subjects.length,
      warmups: WARMUPS,
      trials: TRIALS,
      repetitions: REPETITIONS,
    }),
    metrics,
    repetitions,
    ...(comparison === undefined ? {} : { comparison }),
  });
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (comparison !== undefined && Object.entries(comparison).some(
    ([key, value]) => key.endsWith('Percent') && value > REGRESSION_LIMIT_PERCENT,
  )) {
    process.exitCode = 2;
  }
}

function parseArgs(args) {
  let mode;
  let output;
  let baseline;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === '--') continue;
    if (flag === '--mode') mode = value;
    else if (flag === '--output') output = value;
    else if (flag === '--baseline') baseline = value;
    else throw new Error(`unknown benchmark argument ${flag}`);
    index += 1;
  }
  if (mode !== 'baseline' && mode !== 'compare') {
    throw new Error('--mode must be baseline or compare');
  }
  if (typeof output !== 'string' || output.length === 0) {
    throw new Error('--output is required');
  }
  if (mode === 'compare' && (typeof baseline !== 'string' || baseline.length === 0)) {
    throw new Error('--baseline is required in compare mode');
  }
  return Object.freeze({ mode, output, baseline });
}

function runFreshChild() {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', fileURLToPath(import.meta.url), '--child'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`benchmark child failed: ${result.stderr || result.stdout}`);
  }
  return Object.freeze(JSON.parse(result.stdout));
}

function environmentMetadata() {
  return Object.freeze({
    node: process.version,
    architecture: process.arch,
    platform: process.platform,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    gitDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0,
  });
}

function readBenchmark(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertComparable(baseline, metadata) {
  if (baseline.mode !== 'baseline') throw new Error('comparison input is not a baseline result');
  if (baseline.metadata?.node !== metadata.node) throw new Error('benchmark Node version mismatch');
  if (baseline.metadata?.architecture !== metadata.architecture) {
    throw new Error('benchmark architecture mismatch');
  }
  if (baseline.fixture?.digest !== fixtureDigest) throw new Error('benchmark fixture mismatch');
}

function assertNode22() {
  if (Number(process.versions.node.split('.')[0]) !== 22) {
    throw new Error(`benchmark requires Node.js 22, received ${process.version}`);
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentage(candidate, baseline) {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((candidate - baseline) / baseline) * 100;
}
