#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_SCHEMA,
  assertNoRemoteDkgEndpoints,
  assertSafeOutputPath,
  canonicalJson,
  isolatedChildEnvironment,
  packageDirectoryForName,
  parseCommandOutput,
  parseVitestEvidence,
  repositoryState,
  runMeasuredCommand,
  sha256,
  sourceDigestForScenario,
  summarizeMeasurements,
  validateScenarioMatrix,
} from './lib/wal-legacy-baseline.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = resolve(repositoryRoot, 'bench/wal-000-legacy-baseline/scenario-matrix.json');
const oraclePath = resolve(repositoryRoot, 'bench/wal-000-legacy-baseline/semantic-oracle.json');
const protectedGeneratedPaths = ['packages/evm-module/deployments/localhost_contracts.json'];

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function positiveIntegerArgument(name) {
  const raw = argument(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return resolve('/tmp', `dkg-wal-000-${timestamp}`);
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadOracle() {
  try {
    return await loadJson(oraclePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function captureProtectedGeneratedFiles() {
  return Promise.all(protectedGeneratedPaths.map(async (repositoryPath) => ({
    repositoryPath,
    absolutePath: resolve(repositoryRoot, repositoryPath),
    bytes: await readFile(resolve(repositoryRoot, repositoryPath)),
  })));
}

async function restoreProtectedGeneratedFiles(snapshots, phase) {
  const restorations = [];
  for (const snapshot of snapshots) {
    const current = await readFile(snapshot.absolutePath);
    if (current.equals(snapshot.bytes)) continue;
    await writeFile(snapshot.absolutePath, snapshot.bytes);
    restorations.push({
      phase,
      path: snapshot.repositoryPath,
      generatedDigest: sha256(current),
      restoredDigest: sha256(snapshot.bytes),
    });
  }
  return restorations;
}

function selectedProfiles(matrix, profile) {
  if (profile === 'all') return Object.entries(matrix.profiles);
  const selected = matrix.profiles[profile];
  if (!selected) throw new Error(`unknown profile ${profile}; expected ${Object.keys(matrix.profiles).join(', ')}, or all`);
  return [[profile, selected]];
}

function validateSemanticOracle(oracle, matrix, matrixDigest, state) {
  if (!oracle) return null;
  if (oracle.schema !== 'dkg-wal-000-semantic-oracle-v1') throw new Error('unsupported semantic oracle schema');
  if (oracle.baselineId !== matrix.baselineId) throw new Error('semantic oracle baselineId does not match the matrix');
  if (oracle.baseCommit !== state.baseCommit) throw new Error('semantic oracle was captured from a different origin/main commit');
  if (oracle.matrixDigest !== matrixDigest) throw new Error('semantic oracle was captured from a different scenario matrix');
  const scenarioIds = matrix.profiles.semantic.scenarios
    .filter((scenario) => scenario.role === 'normative-oracle')
    .map((scenario) => scenario.id)
    .sort();
  const oracleIds = Object.keys(oracle.scenarios ?? {}).sort();
  if (canonicalJson(scenarioIds) !== canonicalJson(oracleIds)) {
    throw new Error('semantic oracle scenarios do not exactly match the semantic matrix');
  }
  return oracle;
}

async function runScenario({ scenario, profileName, repetition, outputDirectory, childEnvironment }) {
  const repetitionDirectory = resolve(outputDirectory, 'raw', scenario.id, String(repetition));
  const runtimeDirectory = resolve(outputDirectory, 'runtime', scenario.id, String(repetition));
  await mkdir(repetitionDirectory, { recursive: true });
  await mkdir(resolve(runtimeDirectory, 'dkg-home'), { recursive: true });
  await mkdir(resolve(runtimeDirectory, 'tmp'), { recursive: true });
  const environment = isolatedChildEnvironment(childEnvironment, runtimeDirectory);

  let command;
  let args;
  let vitestReportPath = null;
  let source = null;
  if (scenario.kind === 'vitest') {
    const packageDirectory = packageDirectoryForName(scenario.package);
    source = await sourceDigestForScenario(repositoryRoot, packageDirectory, scenario.files);
    vitestReportPath = resolve(repetitionDirectory, 'vitest.json');
    command = 'pnpm';
    args = [
      '--filter', scenario.package, 'exec', 'vitest', 'run', ...scenario.files,
      '--reporter=json', `--outputFile=${vitestReportPath}`, '--pool=forks', '--maxWorkers=1',
    ];
  } else {
    command = scenario.command;
    args = scenario.args;
    source = await sourceDigestForScenario(repositoryRoot, '', scenario.args.filter((value) => value.startsWith('packages/')));
  }

  const measured = await runMeasuredCommand({
    command,
    args,
    cwd: repositoryRoot,
    environment,
    timeoutMs: scenario.timeoutMs,
  });
  await writeFile(resolve(repetitionDirectory, 'stdout.log'), measured.stdout);
  await writeFile(resolve(repetitionDirectory, 'stderr.log'), measured.stderr);
  if (measured.exitCode !== 0 || measured.timedOut) {
    throw new Error(
      `${scenario.id} repetition ${repetition} failed: exit=${measured.exitCode} timedOut=${measured.timedOut}\n` +
      measured.stderr.slice(-4000),
    );
  }

  let semantic = null;
  let benchmark = null;
  if (scenario.kind === 'vitest') semantic = parseVitestEvidence(await loadJson(vitestReportPath));
  else benchmark = parseCommandOutput(scenario.parser, measured.stdout);

  return {
    repetition,
    profile: profileName,
    command: [command, ...args],
    durationMs: measured.durationMs,
    resourceUsage: measured.resourceUsage,
    source,
    semantic,
    benchmark,
    stdoutDigest: sha256(measured.stdout),
    stderrDigest: sha256(measured.stderr),
    rawDirectory: repetitionDirectory,
  };
}

async function prepareWorkspace(outputDirectory) {
  const preparationDirectory = resolve(outputDirectory, 'raw', 'preparation');
  const runtimeDirectory = resolve(outputDirectory, 'runtime', 'preparation');
  await mkdir(preparationDirectory, { recursive: true });
  await mkdir(resolve(runtimeDirectory, 'dkg-home'), { recursive: true });
  await mkdir(resolve(runtimeDirectory, 'tmp'), { recursive: true });
  const command = 'pnpm';
  const args = ['run', 'build:runtime:packages'];
  process.stderr.write('[WAL-000] preparing workspace packages\n');
  const measured = await runMeasuredCommand({
    command,
    args,
    cwd: repositoryRoot,
    environment: isolatedChildEnvironment(process.env, runtimeDirectory),
    timeoutMs: 900000,
  });
  await writeFile(resolve(preparationDirectory, 'stdout.log'), measured.stdout);
  await writeFile(resolve(preparationDirectory, 'stderr.log'), measured.stderr);
  if (measured.exitCode !== 0 || measured.timedOut) {
    throw new Error(
      `workspace preparation failed: exit=${measured.exitCode} timedOut=${measured.timedOut}\n` +
      measured.stderr.slice(-4000),
    );
  }
  return {
    command: [command, ...args],
    durationMs: measured.durationMs,
    resourceUsage: measured.resourceUsage,
    stdoutDigest: sha256(measured.stdout),
    stderrDigest: sha256(measured.stderr),
    rawDirectory: preparationDirectory,
  };
}

function checkSemanticOracle(scenario, runs, oracle) {
  if (scenario.role === 'sync-characterization') {
    return {
      status: 'non-normative-sync-characterization',
      warning: 'This observation MUST NOT be used as a WAL correctness or parity oracle.',
    };
  }
  if (!oracle) return { status: 'untracked' };
  const expected = oracle.scenarios?.[scenario.id];
  if (!expected) throw new Error(`semantic oracle has no scenario ${scenario.id}`);
  for (const run of runs) {
    if (run.semantic.assertionCount !== expected.assertionCount) {
      throw new Error(`${scenario.id} assertion count changed: ${run.semantic.assertionCount} != ${expected.assertionCount}`);
    }
    if (run.semantic.assertionDigest !== expected.assertionDigest) {
      throw new Error(`${scenario.id} assertion digest changed`);
    }
    if (run.source.digest !== expected.sourceDigest) throw new Error(`${scenario.id} legacy test source changed`);
  }
  return { status: 'matched', expected };
}

function summarizeBenchmarkRuns(scenario, runs) {
  if (scenario.kind !== 'command') return null;
  const benchmarks = runs.map((run) => run.benchmark);
  if (scenario.id === 'legacy-sync-responder-pages') {
    return {
      currentImplementation: 'new',
      datasets: benchmarks[0].results.map((first, index) => {
        const samples = benchmarks.map((benchmark) => benchmark.results[index]);
        return {
          rowCount: first.rowCount,
          pageSize: first.pageSize,
          transferBytes: first.new.transferBytes,
          requestCount: first.new.requestCount,
          triplestoreOperations: first.new.triplestoreOperations,
          snapshotReadOperations: first.new.snapshotReadOperations,
          durationMs: summarizeMeasurements(samples.map((sample) => sample.new.durationMs)),
          peakHeapDeltaBytes: summarizeMeasurements(samples.map((sample) => sample.new.peakHeapDeltaBytes)),
          peakRssDeltaBytes: summarizeMeasurements(samples.map((sample) => sample.new.peakRssDeltaBytes)),
          copiedArraySlots: first.new.copiedArraySlots,
        };
      }),
    };
  }
  if (scenario.id === 'legacy-sync-worker-throughput') {
    return {
      dataset: benchmarks[0].dataset,
      operations: benchmarks[0].operations,
      mainThreadMs: summarizeMeasurements(benchmarks.map((benchmark) => benchmark.mainThreadMs)),
      workerMs: summarizeMeasurements(benchmarks.map((benchmark) => benchmark.workerMs)),
    };
  }
  if (scenario.id === 'legacy-sync-worker-responsiveness') {
    return {
      dataset: benchmarks[0].dataset,
      operations: benchmarks[0].operations,
      mainThreadDurationMs: summarizeMeasurements(benchmarks.map((benchmark) => benchmark.mainThread.durationMs)),
      mainThreadMaxEventLoopDelayMs: summarizeMeasurements(
        benchmarks.map((benchmark) => benchmark.mainThread.maxEventLoopDelayMs),
      ),
      workerDurationMs: summarizeMeasurements(benchmarks.map((benchmark) => benchmark.workerThread.durationMs)),
      workerMaxEventLoopDelayMs: summarizeMeasurements(
        benchmarks.map((benchmark) => benchmark.workerThread.maxEventLoopDelayMs),
      ),
    };
  }
  throw new Error(`WAL-000 has no benchmark summarizer for ${scenario.id}`);
}

async function main() {
  const startedAt = new Date().toISOString();
  const matrixBytes = await readFile(matrixPath);
  const matrix = validateScenarioMatrix(JSON.parse(matrixBytes.toString('utf8')));
  const matrixDigest = sha256(matrixBytes);
  if (process.argv.includes('--list')) {
    for (const [profileName, profile] of Object.entries(matrix.profiles)) {
      process.stdout.write(`${profileName} (${profile.defaultRepetitions} repetition(s))\n`);
      for (const scenario of profile.scenarios) {
        process.stdout.write(`  ${scenario.id} [${scenario.role}]: ${scenario.covers.join(', ')}\n`);
      }
    }
    return;
  }

  const profile = argument('profile') ?? 'semantic';
  const outputDirectory = resolve(argument('output') ?? defaultOutputPath());
  const repetitionOverride = positiveIntegerArgument('repetitions');
  assertSafeOutputPath(repositoryRoot, outputDirectory);
  assertNoRemoteDkgEndpoints(process.env);
  const state = repositoryState(repositoryRoot, matrix.baseRef, matrix.baseCommit);
  const allowDirty = process.argv.includes('--allow-dirty');
  if (state.dirtyPaths.length > 0 && !allowDirty) {
    throw new Error('accepted WAL-000 receipts require a clean worktree; use --allow-dirty only during harness development');
  }

  const protectedGeneratedFiles = await captureProtectedGeneratedFiles();
  const sourceRestorations = [];
  const restoreGeneratedFilesAndAssertSourceBoundary = async (phase) => {
    sourceRestorations.push(...await restoreProtectedGeneratedFiles(protectedGeneratedFiles, phase));
    const boundaryState = repositoryState(repositoryRoot, matrix.baseRef, matrix.baseCommit);
    if (canonicalJson(state.dirtyPaths) !== canonicalJson(boundaryState.dirtyPaths)) {
      throw new Error(`${phase} changed source outside the protected generated-file allowlist`);
    }
  };

  await mkdir(outputDirectory, { recursive: true });
  let preparation;
  try {
    preparation = await prepareWorkspace(outputDirectory);
  } finally {
    await restoreGeneratedFilesAndAssertSourceBoundary('preparation');
  }
  const oracle = validateSemanticOracle(await loadOracle(), matrix, matrixDigest, state);
  const scenarioEvidence = [];
  for (const [profileName, profileConfig] of selectedProfiles(matrix, profile)) {
    const repetitions = repetitionOverride ?? profileConfig.defaultRepetitions;
    if (profileName === 'performance' && repetitions < 3 && !allowDirty) {
      throw new Error('accepted WAL-000 performance receipts require at least three repetitions');
    }
    for (const scenario of profileConfig.scenarios) {
      const runs = [];
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        process.stderr.write(`[WAL-000] ${scenario.id} repetition ${repetition + 1}/${repetitions}\n`);
        let run;
        try {
          run = await runScenario({
            scenario,
            profileName,
            repetition,
            outputDirectory,
            childEnvironment: process.env,
          });
        } finally {
          await restoreGeneratedFilesAndAssertSourceBoundary(`${scenario.id}:${repetition}`);
        }
        runs.push(run);
      }
      const durations = summarizeMeasurements(runs.map((run) => run.durationMs));
      const cpuValues = runs
        .map((run) => (run.resourceUsage.userCpuSeconds ?? 0) + (run.resourceUsage.systemCpuSeconds ?? 0))
        .filter((value) => value > 0);
      const rssValues = runs.map((run) => run.resourceUsage.maximumRssBytes).filter((value) => value !== null);
      if (profileName === 'performance' && (cpuValues.length !== runs.length || rssValues.length !== runs.length)) {
        throw new Error(`${scenario.id} did not produce CPU and peak-RSS measurements for every repetition`);
      }
      scenarioEvidence.push({
        id: scenario.id,
        category: scenario.category,
        role: scenario.role,
        covers: scenario.covers,
        runs,
        summaries: {
          durationMs: durations,
          cpuSeconds: cpuValues.length > 0 ? summarizeMeasurements(cpuValues) : null,
          maximumRssBytes: rssValues.length > 0 ? summarizeMeasurements(rssValues) : null,
        },
        benchmarkSummaries: summarizeBenchmarkRuns(scenario, runs),
        oracle: scenario.kind === 'vitest' ? checkSemanticOracle(scenario, runs, oracle) : null,
      });
    }
  }

  const stableSummary = scenarioEvidence.map((scenario) => ({
    id: scenario.id,
    role: scenario.role,
    covers: scenario.covers,
    sourceDigest: scenario.runs[0].source.digest,
    assertionDigest: scenario.runs[0].semantic?.assertionDigest ?? null,
    parsedBenchmarkDigest: scenario.runs[0].benchmark ? sha256(canonicalJson(scenario.runs[0].benchmark)) : null,
  }));
  const finalState = repositoryState(repositoryRoot, matrix.baseRef, matrix.baseCommit);
  if (canonicalJson(state.dirtyPaths) !== canonicalJson(finalState.dirtyPaths)) {
    throw new Error('WAL-000 scenarios changed tracked or untracked source state');
  }
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    runId: randomUUID(),
    baselineId: matrix.baselineId,
    profile,
    startedFromCleanWorktree: state.dirtyPaths.length === 0,
    source: {
      commit: state.commit,
      baseCommit: state.baseCommit,
      baseRef: matrix.baseRef,
      baseRefCommitAtRun: state.baseRefCommitAtRun,
      dirty: state.dirtyPaths.length > 0,
      dirtyPaths: state.dirtyPaths,
      matrixDigest,
    },
    environment: {
      node: process.version,
      pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    safety: {
      isolatedDkgHome: true,
      receiptsOutsideRepository: true,
      credentialsStripped: true,
      remoteEndpointEnvironmentRejected: true,
      sourceCleanAtScenarioBoundaries: true,
      knownGeneratedFilesRestored: true,
      unexpectedSourceChangesRejected: true,
    },
    sourceRestorations,
    preparation,
    scenarios: scenarioEvidence,
    summaryDigest: sha256(canonicalJson(stableSummary)),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  const evidencePath = resolve(outputDirectory, 'evidence.json');
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ evidencePath, summaryDigest: evidence.summaryDigest }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
