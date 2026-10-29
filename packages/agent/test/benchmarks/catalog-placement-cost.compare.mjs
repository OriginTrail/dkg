#!/usr/bin/env node
/**
 * Medians of the catalog placement benchmark's `measure` runs, per catalog size and label:
 *
 *   node test/benchmarks/catalog-placement-cost.compare.mjs before=a.json,b.json after=c.json,d.json
 *
 * Each argument is `label=file[,file...]`; the files are what CATALOG_PLACEMENT_BENCH_OUT wrote.
 * With exactly two labels the ratio of the first to the second is printed as well.
 */
import { readFileSync } from 'node:fs';

const runs = process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf('=');
  if (separator < 1) throw new Error(`expected label=file[,file...], got ${argument}`);
  return {
    label: argument.slice(0, separator),
    results: argument.slice(separator + 1).split(',').flatMap((file) => {
      const run = JSON.parse(readFileSync(file, 'utf8'));
      if (run.mode !== 'measure') throw new Error(`${file} is not a measure run`);
      return run.results;
    }),
  };
});
if (runs.length === 0) throw new Error('nothing to compare: pass label=file[,file...]');

function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function duration(ms) {
  if (Number.isNaN(ms)) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`;
}

/** Every sample of one kind that the runs of a label hold for one catalog size. */
function samples(run, size, kind) {
  return run.results.filter((result) => result.size === size).flatMap(({ samples: held }) => (
    // A run of an earlier version of the benchmark holds no projection passes.
    kind === 'afterStart' ? [held.afterStart.first] : held[kind] ?? []
  ));
}

const phase = (held, name) => median(held.map(({ phases }) => phases[name] ?? 0));
const of = (held, field) => median(held.map((sample) => sample[field]));
const sizes = [...new Set(runs.flatMap(({ results }) => results.map(({ size }) => size)))]
  .sort((left, right) => left - right);

function table(title, kind, columns) {
  console.log(`\n${title}\n`);
  console.log(`| rows | run | samples | ${columns.map(([name]) => name).join(' | ')} |`);
  console.log(`| ---: | --- | ---: | ${columns.map(() => '---:').join(' | ')} |`);
  for (const size of sizes) {
    for (const run of runs) {
      const held = samples(run, size, kind);
      console.log(`| ${size} | ${run.label} | ${held.length} | ${columns.map(([, read]) => read(held)).join(' | ')} |`);
    }
  }
}

const wall = ['wall', (held) => duration(of(held, 'wallMs'))];
const cpu = ['CPU', (held) => duration(of(held, 'cpuMs'))];
const stall = ['longest stall (median / max)', (held) => (
  `${duration(of(held, 'stallMs'))} / ${duration(Math.max(...held.map(({ stallMs }) => stallMs)))}`
)];
const phases = [
  ['coverage check', (held) => duration(phase(held, 'coverageMs'))],
  ['locked state read', (held) => duration(phase(held, 'stateMs'))],
  ['successor production', (held) => duration(phase(held, 'successorMs'))],
  ['CAS', (held) => duration(phase(held, 'casMs'))],
  ['announce', (held) => duration(phase(held, 'announceMs'))],
  ['other', (held) => duration(phase(held, 'otherMs') + phase(held, 'assetMs'))],
];

table('One placement into a catalog of up to `rows` rows', 'first', [wall, cpu, ...phases, stall]);
table('The same confirmation observed again (already covered)', 'covered', [wall, cpu, stall]);
table('First placement after a start', 'afterStart', [wall, cpu, ...phases.slice(0, 3)]);
table('A projection pass over the same catalog that finds nothing to sign', 'projection', [
  wall,
  cpu,
  ['in the catalog mutation', (held) => duration(phase(held, 'catalogMs'))],
  stall,
]);

console.log('\nWhat each run signed and kept\n');
console.log('| rows | run | applied inventory digests | retained after a full collection |');
console.log('| ---: | --- | --- | ---: |');
for (const size of sizes) {
  const digests = new Set();
  for (const run of runs) {
    const results = run.results.filter((result) => result.size === size);
    const own = [...new Set(results.map(({ appliedInventoryDigest }) => appliedInventoryDigest))];
    for (const digest of own) digests.add(digest);
    const retained = median(results.map(({ retainedBytes }) => retainedBytes).filter((bytes) => bytes !== undefined));
    console.log(`| ${size} | ${run.label} | ${own.join(', ')} | ${Number.isNaN(retained) ? '-' : `${(retained / 1_048_576).toFixed(1)} MiB`} |`);
  }
  console.log(`| ${size} | | ${digests.size === 1 ? 'every run signed the same rows' : 'THE RUNS SIGNED DIFFERENT ROWS'} | |`);
}

if (runs.length === 2) {
  const [first, second] = runs;
  console.log(`\nRatio ${first.label} / ${second.label}, medians\n`);
  for (const size of sizes) {
    const ratio = (kind, field) => (
      of(samples(first, size, kind), field) / of(samples(second, size, kind), field)
    ).toFixed(1);
    console.log(
      `rows=${size}: placement wall x${ratio('first', 'wallMs')} CPU x${ratio('first', 'cpuMs')};`
      + ` already covered wall x${ratio('covered', 'wallMs')} CPU x${ratio('covered', 'cpuMs')};`
      + ` projection pass wall x${ratio('projection', 'wallMs')} CPU x${ratio('projection', 'cpuMs')}`,
    );
  }
}
