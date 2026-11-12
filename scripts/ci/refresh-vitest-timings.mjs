#!/usr/bin/env node
/**
 * Refresh the CLI or chain shard timing snapshot (scripts/ci/timings/<package>.json)
 * from successful CI runs; see scripts/ci/timings/README.md.
 *
 *   node scripts/ci/refresh-vitest-timings.mjs <cli|chain> --output FILE
 *     [--shards N] [--per-file-overhead-ms MS] [--estimate test/NAME.test.ts=MS ...]
 *     RUN_ID:COMMIT_SHA:DIRECTORY ...
 *
 * Each DIRECTORY holds one run's shard job logs (*.log) or JUnit reports
 * (*.xml). Both carry the same Vitest 4 per-file duration, the file task's
 * result.duration: its hooks and tests, without import or collection. A file's
 * weight is its median across the runs. The per-file overhead is the median
 * import (collection) time per file in the logs' Vitest summaries. Reads local
 * files only.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { SaxesParser } from 'saxes';
import { PACKAGE_SHARD_COUNTS } from '../lib/ci-lanes.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TIMED_PACKAGE_DIRECTORIES = Object.freeze({ cli: 'packages/cli', chain: 'packages/chain' });
const LOG_PREFIX = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const MODULE_LINE = /^ ([✓×↓❯]) (\S+) \((\d+) tests?((?: \| \d+ [a-z]+)*)\)(?: (\d+)ms)?/u;
const SOURCE = /^([1-9]\d*):([0-9a-f]{40}):(.+)$/;

function testPath(name, source) {
  if (typeof name !== 'string' || !name.startsWith('test/') || !name.endsWith('.test.ts') || /[\s\\]/.test(name)
      || name.split('/').some((part) => part === '..' || part === '.' || !part)) {
    throw new Error(`${source}: unexpected test path ${JSON.stringify(name)}`);
  }
  return name;
}

function milliseconds(value, unit) {
  return unit === 's' ? Number(value) * 1000 : Number(value);
}

/**
 * One shard's job log: the files of its single Vitest run for the package, and
 * its import time. Returns undefined for a log with no run for the package.
 */
export function parseVitestLog(text, packageName, source) {
  const lines = text.split(/\r?\n/).map((line) => stripVTControlCharacters(line.replace(LOG_PREFIX, '')));
  const runLine = new RegExp(`^ RUN {2}v\\S+ \\S*/packages/${packageName}$`);
  const reportLine = new RegExp(`^JUNIT report written to \\S*/packages/${packageName}/test-results/(${packageName}-\\d+\\.xml)$`);
  const starts = lines.flatMap((line, index) => (runLine.test(line) ? [index] : []));
  if (!starts.length) return undefined;
  if (starts.length > 1) throw new Error(`${source}: expected one Vitest run for packages/${packageName}, found ${starts.length}`);
  const files = [];
  let declaredFiles;
  let importMs;
  for (const line of lines.slice(starts[0] + 1)) {
    const module = MODULE_LINE.exec(line);
    if (module) {
      const [, symbol, name, tests, counts, ms] = module;
      const skipped = Number(/ \| (\d+) skipped/.exec(counts)?.[1] ?? 0);
      if (symbol === '✓' && ms !== undefined && !/failed/.test(counts)) files.push({ file: testPath(name, source), ms: Number(ms) });
      else if (symbol === '↓' && ms === undefined && skipped === Number(tests)) files.push({ file: testPath(name, source), ms: 0 });
      else throw new Error(`${source}: failed or incomplete test file ${name}`);
      continue;
    }
    if (/^ +(?:Type )?Errors {2}/.test(line)) throw new Error(`${source}: the run reports errors`);
    const total = /^ {1,6}(Test Files|Tests) {2}(.+) \((\d+)\)$/.exec(line);
    if (total) {
      if (/failed/.test(total[2])) throw new Error(`${source}: the run reports failed ${total[1].toLowerCase()}`);
      if (total[1] === 'Test Files') declaredFiles = Number(total[3]);
      continue;
    }
    const duration = /^ {3}Duration {2}\S+ \(.*\bimport (\d+(?:\.\d+)?)(ms|s)\b/.exec(line);
    if (duration) {
      importMs = milliseconds(duration[1], duration[2]);
      break;
    }
  }
  if (importMs === undefined) throw new Error(`${source}: the Vitest run has no summary; was the job complete?`);
  if (!files.length || declaredFiles !== files.length) {
    throw new Error(`${source}: the summary declares ${declaredFiles} test files but the log lists ${files.length}`);
  }
  const reports = lines.flatMap((line) => reportLine.exec(line)?.slice(1, 2) ?? []);
  if (reports.length !== 1) throw new Error(`${source}: expected one ${packageName} JUnit report line, found ${reports.length}`);
  return { report: reports[0], files, importMs };
}

/** One shard's JUnit report, as uploaded by .github/actions/upload-vitest-junit. */
export function parseJunitReport(xml, source) {
  const parser = new SaxesParser();
  const suites = [];
  let root;
  parser.on('opentag', ({ name, attributes }) => {
    root ??= name;
    if (name === 'testsuite') suites.push(attributes);
  });
  parser.write(xml).close();
  if (root !== 'testsuites') throw new Error(`${source}: expected a Vitest testsuites report`);
  const count = (suite, key) => {
    const value = suite[key] ?? '0';
    if (!/^\d+$/.test(value)) throw new Error(`${source}: invalid ${key} for ${suite.name}`);
    return Number(value);
  };
  return suites.map((suite) => {
    const file = testPath(suite.name, source);
    if (count(suite, 'failures') || count(suite, 'errors')) throw new Error(`${source}: failed test file ${file}`);
    const seconds = Number(suite.time);
    if (!/^\d+(?:\.\d+)?$/.test(suite.time ?? '') || !Number.isFinite(seconds)) {
      throw new Error(`${source}: invalid duration for ${file}`);
    }
    if (count(suite, 'tests') === 0) throw new Error(`${source}: ${file} reports no tests`);
    return { file, ms: Math.round(seconds * 1000) };
  });
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }).sort();
}

/**
 * Every expected shard report of one run, exactly once, from either source.
 * Reports of other packages (another lane's logs or JUnit files) are skipped.
 */
export function collectRun(directory, packageName, shardCount) {
  const expected = new Set(Array.from({ length: shardCount }, (_, index) => `${packageName}-${index + 1}.xml`));
  const received = new Set();
  const durations = new Map();
  const imports = [];
  const reportName = new RegExp(`^${packageName}-\\d+\\.xml$`);
  for (const file of listFiles(directory)) {
    let parsed;
    if (file.endsWith('.xml')) {
      if (!reportName.test(path.basename(file))) continue;
      parsed = { report: path.basename(file), files: parseJunitReport(fs.readFileSync(file, 'utf8'), file) };
    } else if (file.endsWith('.log')) {
      parsed = parseVitestLog(fs.readFileSync(file, 'utf8'), packageName, file);
      if (!parsed) continue;
    } else continue;
    if (!expected.has(parsed.report)) throw new Error(`${file}: unexpected ${packageName} report ${parsed.report}`);
    if (received.has(parsed.report)) throw new Error(`${file}: duplicate ${packageName} report ${parsed.report}`);
    received.add(parsed.report);
    for (const { file: testFile, ms } of parsed.files) {
      if (durations.has(testFile)) throw new Error(`${file}: ${testFile} ran in two shards`);
      durations.set(testFile, ms);
    }
    if (parsed.importMs !== undefined) imports.push(parsed.importMs / parsed.files.length);
  }
  const missing = [...expected].filter((report) => !received.has(report));
  if (missing.length) throw new Error(`${directory}: missing ${packageName} reports ${missing.join(', ')}`);
  return { durations, imports };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

export function parseSource(text) {
  const match = SOURCE.exec(text);
  if (!match) throw new Error(`expected RUN_ID:COMMIT_SHA:DIRECTORY with a full commit SHA, got ${text}`);
  return { runId: Number(match[1]), commit: match[2], directory: match[3] };
}

export function parseEstimate(text, packageName, repoRoot = REPO_ROOT) {
  const match = /^([^=]+)=(\d+)$/.exec(text);
  if (!match) throw new Error(`expected test/NAME.test.ts=MILLISECONDS, got ${text}`);
  const file = testPath(match[1], '--estimate');
  if (!fs.existsSync(path.join(repoRoot, TIMED_PACKAGE_DIRECTORIES[packageName], file))) {
    throw new Error(`--estimate names ${file}, which does not exist in ${TIMED_PACKAGE_DIRECTORIES[packageName]}`);
  }
  return [file, Number(match[2])];
}

/**
 * Build the snapshot; throws before anything is written if any input is
 * unusable. Measured files that no longer exist in the package are dropped.
 */
export function refreshTimings({
  packageName, sources, shardCount = PACKAGE_SHARD_COUNTS[packageName], perFileOverheadMs, estimates = [], repoRoot = REPO_ROOT,
}) {
  if (!Object.hasOwn(TIMED_PACKAGE_DIRECTORIES, packageName)) throw new Error(`unsupported package ${packageName}; expected cli or chain`);
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('--shards must be a positive integer');
  if (!sources.length) throw new Error('expected at least one RUN_ID:COMMIT_SHA:DIRECTORY source');
  if (new Set(sources.map(({ runId }) => runId)).size !== sources.length) throw new Error('duplicate source run');
  const perFile = new Map();
  const imports = [];
  for (const { directory } of sources) {
    const run = collectRun(directory, packageName, shardCount);
    for (const [file, ms] of run.durations) perFile.set(file, [...(perFile.get(file) ?? []), ms]);
    imports.push(...run.imports);
  }
  if (perFileOverheadMs === undefined) {
    if (!imports.length) throw new Error('JUnit reports carry no import time; pass --per-file-overhead-ms or add the job logs');
    perFileOverheadMs = median(imports);
  }
  if (!Number.isInteger(perFileOverheadMs) || perFileOverheadMs < 0) throw new Error('--per-file-overhead-ms must be a non-negative integer');
  const exists = (file) => fs.existsSync(path.join(repoRoot, TIMED_PACKAGE_DIRECTORIES[packageName], file));
  const measured = [...perFile].sort(([left], [right]) => (left < right ? -1 : 1));
  const dropped = measured.filter(([file]) => !exists(file)).map(([file]) => file);
  const bodyWeightsMs = Object.fromEntries(measured.filter(([file]) => exists(file)).map(([file, values]) => [file, median(values)]));
  if (!Object.keys(bodyWeightsMs).length) throw new Error(`none of the measured files exist in ${TIMED_PACKAGE_DIRECTORIES[packageName]}`);
  const estimated = new Map();
  for (const [file, ms] of estimates) {
    if (perFile.has(file)) throw new Error(`--estimate names ${file}, which the source runs measured; drop the estimate`);
    if (estimated.has(file)) throw new Error(`duplicate --estimate for ${file}`);
    estimated.set(file, ms);
  }
  const snapshot = {
    schemaVersion: 1,
    package: packageName,
    sources: sources.map(({ runId, commit }) => ({ runId, commit, url: `https://github.com/OriginTrail/dkg/actions/runs/${runId}` })),
    aggregation: 'median',
    perFileOverheadMs,
    bodyWeightsMs,
    ...(estimated.size ? { estimatedBodyWeightsMs: Object.fromEntries([...estimated].sort(([left], [right]) => (left < right ? -1 : 1))) } : {}),
  };
  return { snapshot, dropped };
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string' },
        shards: { type: 'string' },
        'per-file-overhead-ms': { type: 'string' },
        estimate: { type: 'string', multiple: true, default: [] },
      },
    });
    const [packageName, ...sourceTexts] = positionals;
    if (!values.output || !Object.hasOwn(TIMED_PACKAGE_DIRECTORIES, packageName ?? '')) {
      throw new Error('usage: refresh-vitest-timings.mjs <cli|chain> --output FILE [--shards N] [--per-file-overhead-ms MS] [--estimate test/NAME.test.ts=MS] RUN_ID:COMMIT_SHA:DIRECTORY...');
    }
    const integer = (text, name) => {
      if (text === undefined) return undefined;
      if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative integer`);
      return Number(text);
    };
    const { snapshot, dropped } = refreshTimings({
      packageName,
      sources: sourceTexts.map(parseSource),
      shardCount: integer(values.shards, '--shards'),
      perFileOverheadMs: integer(values['per-file-overhead-ms'], '--per-file-overhead-ms'),
      estimates: values.estimate.map((text) => parseEstimate(text, packageName)),
    });
    fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
    fs.writeFileSync(values.output, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`Wrote ${Object.keys(snapshot.bodyWeightsMs).length} measured ${packageName} files from ${snapshot.sources.length} runs`
      + ` (per-file overhead ${snapshot.perFileOverheadMs} ms, ${Object.keys(snapshot.estimatedBodyWeightsMs ?? {}).length} estimates).`);
    for (const file of dropped) console.log(`Dropped ${file}: measured, but no longer in ${TIMED_PACKAGE_DIRECTORIES[packageName]}.`);
    return 0;
  } catch (error) {
    console.error(`refresh-vitest-timings: ${error.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
