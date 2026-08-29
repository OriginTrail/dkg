const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const DEFAULT_SIZES = [10_000, 50_000];
const DEFAULT_ROUNDS = 3;
const DEFAULT_TRIALS = 3;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function allocatingComparator(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = left[index].codePointAt(0) - right[index].codePointAt(0);
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function makeGraphNames(count) {
  const names = Array.from({ length: count }, (_, index) => {
    const bucket = Math.floor(index / 500).toString().padStart(5, '0');
    const ordinal = index.toString().padStart(8, '0');
    const unicodeTail = index % 17 === 0 ? `/${String.fromCodePoint(0x1F600 + (index % 64))}` : '';
    return `did:dkg:context-graph:benchmark/data/${bucket}/assertion/${ordinal}${unicodeTail}`;
  });
  let state = 0x6D2B79F5;
  for (let index = names.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const target = state % (index + 1);
    [names[index], names[target]] = [names[target], names[index]];
  }
  return names;
}

function fingerprint(values) {
  let hash = 2166136261;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function runWorker(mode, graphCount, rounds) {
  if (typeof global.gc !== 'function') {
    throw new Error('Run with --expose-gc so trials start from a comparable heap baseline');
  }
  const comparator = mode === 'old'
    ? allocatingComparator
    : (await import('../dist/sync/responder/graph-plan.js')).compareCodePoint;
  const names = makeGraphNames(graphCount);
  names.slice(0, Math.min(2_000, names.length)).sort(comparator);
  global.gc();

  const baseline = process.memoryUsage();
  let comparisons = 0;
  let finalOrder = [];
  const countedComparator = (left, right) => {
    comparisons += 1;
    return comparator(left, right);
  };
  const startedAt = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    finalOrder = [...names].sort(countedComparator);
  }
  const durationMs = performance.now() - startedAt;
  const usage = process.memoryUsage();
  return {
    mode,
    graphCount,
    rounds,
    durationMs,
    comparisons,
    temporaryCodePointArrays: mode === 'old' ? comparisons * 2 : 0,
    heapUsedDeltaBytes: Math.max(0, usage.heapUsed - baseline.heapUsed),
    fingerprint: fingerprint(finalOrder),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function runIsolatedTrial(mode, graphCount, rounds) {
  const child = spawnSync(
    process.execPath,
    ['--expose-gc', '--max-old-space-size=512', __filename, '--worker', mode, String(graphCount), String(rounds)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (child.status !== 0) {
    throw new Error(
      `benchmark worker failed for mode=${mode} graphs=${graphCount}\n${child.stderr || child.stdout}`,
    );
  }
  return JSON.parse(child.stdout);
}

function summarize(trials) {
  return {
    durationMs: median(trials.map((trial) => trial.durationMs)),
    heapUsedDeltaBytes: median(trials.map((trial) => trial.heapUsedDeltaBytes)),
    comparisons: trials[0].comparisons,
    temporaryCodePointArrays: trials[0].temporaryCodePointArrays,
    fingerprint: trials[0].fingerprint,
  };
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function runController() {
  const sizesArg = process.argv.find((argument) => argument.startsWith('--sizes='));
  const roundsArg = process.argv.find((argument) => argument.startsWith('--rounds='));
  const trialsArg = process.argv.find((argument) => argument.startsWith('--trials='));
  const sizes = sizesArg
    ? sizesArg.slice('--sizes='.length).split(',').map((value) => parsePositiveInteger(value, 0)).filter(Boolean)
    : DEFAULT_SIZES;
  const rounds = parsePositiveInteger(roundsArg?.slice('--rounds='.length), DEFAULT_ROUNDS);
  const trialsPerMode = parsePositiveInteger(trialsArg?.slice('--trials='.length), DEFAULT_TRIALS);
  const results = [];

  for (const graphCount of sizes) {
    const oldTrials = [];
    const newTrials = [];
    for (let trial = 0; trial < trialsPerMode; trial += 1) {
      const modes = trial % 2 === 0 ? ['old', 'new'] : ['new', 'old'];
      for (const mode of modes) {
        const result = runIsolatedTrial(mode, graphCount, rounds);
        (mode === 'old' ? oldTrials : newTrials).push(result);
      }
    }
    const oldSummary = summarize(oldTrials);
    const newSummary = summarize(newTrials);
    if (oldSummary.fingerprint !== newSummary.fingerprint) {
      throw new Error(`old/new ordering mismatch for ${graphCount} graphs`);
    }
    results.push({
      graphCount,
      old: oldSummary,
      new: newSummary,
      speedup: oldSummary.durationMs / newSummary.durationMs,
    });
  }

  console.log('Graph-plan code-point comparator benchmark');
  console.log(`Node ${process.version}; ${rounds} sort round(s); ${trialsPerMode} isolated trial(s) per mode`);
  console.log('');
  console.log('| Graphs | Comparisons | Old median | New median | Speedup | Old temporary arrays | New temporary arrays | Old heap delta | New heap delta |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    console.log(
      `| ${formatInteger(result.graphCount)} | ${formatInteger(result.old.comparisons)} | ` +
      `${result.old.durationMs.toFixed(2)} ms | ${result.new.durationMs.toFixed(2)} ms | ` +
      `${result.speedup.toFixed(1)}x | ${formatInteger(result.old.temporaryCodePointArrays)} | ` +
      `${formatInteger(result.new.temporaryCodePointArrays)} | ${formatBytes(result.old.heapUsedDeltaBytes)} | ` +
      `${formatBytes(result.new.heapUsedDeltaBytes)} |`,
    );
  }
  console.log('');
  console.log('Machine-readable results:');
  console.log(JSON.stringify({ node: process.version, rounds, trialsPerMode, results }, null, 2));
}

if (process.argv[2] === '--worker') {
  runWorker(
    process.argv[3],
    parsePositiveInteger(process.argv[4], 0),
    parsePositiveInteger(process.argv[5], DEFAULT_ROUNDS),
  ).then(
    (result) => process.stdout.write(JSON.stringify(result)),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
} else {
  try {
    runController();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
