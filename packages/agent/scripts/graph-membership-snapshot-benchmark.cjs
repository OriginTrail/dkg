const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const DEFAULT_SIZES = [10_000, 50_000];
const DEFAULT_QUERIES = 200;
const DEFAULT_TRIALS = 3;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeGraphs(count) {
  const familyCount = Math.max(1, Math.ceil(count / 100));
  const graphs = Array.from({ length: count }, (_, index) => {
    const family = String(index % familyCount).padStart(6, '0');
    const ordinal = String(Math.floor(index / familyCount)).padStart(6, '0');
    return `did:dkg:context-graph:benchmark-${family}/_shared_memory/0x${'a'.repeat(40)}/${ordinal}`;
  });
  return { graphs, familyCount };
}

function fingerprintSelection(hash, graphs) {
  let next = hash;
  for (const graph of graphs) {
    for (let index = 0; index < graph.length; index += 1) {
      next ^= graph.charCodeAt(index);
      next = Math.imul(next, 16777619);
    }
  }
  return next >>> 0;
}

async function runWorker(mode, graphCount, queryCount) {
  if (typeof global.gc !== 'function') throw new Error('Run with --expose-gc');
  const { compareCodePoint } = await import('../dist/sync/code-point-order.js');
  const { createGraphMembershipSnapshot } = await import('../dist/sync/graph-membership-snapshot.js');
  const { graphs: unsorted, familyCount } = makeGraphs(graphCount);
  const graphs = [...unsorted].sort(compareCodePoint);
  const snapshot = createGraphMembershipSnapshot(graphs);
  const roots = Array.from({ length: queryCount }, (_, index) => (
    `did:dkg:context-graph:benchmark-${String((index * 97) % familyCount).padStart(6, '0')}`
  ));
  const select = mode === 'scan'
    ? (root) => graphs
      .filter((graph) => graph === root || graph.startsWith(`${root}/`))
      .sort(compareCodePoint)
    : (root) => snapshot.equalOrUnder(root);

  for (const root of roots.slice(0, 20)) select(root);
  global.gc();

  let fingerprint = 2166136261;
  let selectedGraphs = 0;
  const startedAt = performance.now();
  for (const root of roots) {
    const selected = select(root);
    selectedGraphs += selected.length;
    fingerprint = fingerprintSelection(fingerprint, selected);
  }
  const durationMs = performance.now() - startedAt;
  return {
    mode,
    graphCount,
    queryCount,
    durationMs,
    selectedGraphs,
    fullListEntriesInspected: mode === 'scan' ? graphCount * queryCount : 0,
    fingerprint: fingerprint.toString(16).padStart(8, '0'),
  };
}

function isolatedTrial(mode, graphCount, queryCount) {
  const child = spawnSync(
    process.execPath,
    ['--expose-gc', '--max-old-space-size=512', __filename, '--worker', mode, String(graphCount), String(queryCount)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (child.status !== 0) {
    throw new Error(`benchmark worker failed for mode=${mode}\n${child.stderr || child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function controller() {
  const sizesArgument = process.argv.find((argument) => argument.startsWith('--sizes='));
  const queriesArgument = process.argv.find((argument) => argument.startsWith('--queries='));
  const trialsArgument = process.argv.find((argument) => argument.startsWith('--trials='));
  const sizes = sizesArgument
    ? sizesArgument.slice('--sizes='.length).split(',').map((value) => positiveInteger(value, 0)).filter(Boolean)
    : DEFAULT_SIZES;
  const queryCount = positiveInteger(queriesArgument?.slice('--queries='.length), DEFAULT_QUERIES);
  const trialCount = positiveInteger(trialsArgument?.slice('--trials='.length), DEFAULT_TRIALS);
  const results = [];

  for (const graphCount of sizes) {
    const scanTrials = [];
    const snapshotTrials = [];
    for (let trial = 0; trial < trialCount; trial += 1) {
      const modes = trial % 2 === 0 ? ['scan', 'snapshot'] : ['snapshot', 'scan'];
      for (const mode of modes) {
        const result = isolatedTrial(mode, graphCount, queryCount);
        (mode === 'scan' ? scanTrials : snapshotTrials).push(result);
      }
    }
    const scanMs = median(scanTrials.map((trial) => trial.durationMs));
    const snapshotMs = median(snapshotTrials.map((trial) => trial.durationMs));
    if (
      scanTrials.some((trial) => trial.fingerprint !== scanTrials[0].fingerprint)
      || snapshotTrials.some((trial) => trial.fingerprint !== scanTrials[0].fingerprint)
      || snapshotTrials[0].selectedGraphs !== scanTrials[0].selectedGraphs
    ) {
      throw new Error(`scan/snapshot selection mismatch for ${graphCount} graphs`);
    }
    results.push({
      graphCount,
      queryCount,
      scanMs,
      snapshotMs,
      speedup: scanMs / snapshotMs,
      selectedGraphs: scanTrials[0].selectedGraphs,
      scanEntries: scanTrials[0].fullListEntriesInspected,
      fingerprint: scanTrials[0].fingerprint,
    });
  }

  console.log('Graph membership prefix-range benchmark');
  console.log(`Node ${process.version}; ${queryCount} queries; ${trialCount} isolated trial(s) per mode`);
  console.log('');
  console.log('| Graphs | Queries | Full scan median | Snapshot median | Speedup | Full-list entries avoided |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    console.log(
      `| ${result.graphCount.toLocaleString()} | ${result.queryCount.toLocaleString()} | `
      + `${result.scanMs.toFixed(2)} ms | ${result.snapshotMs.toFixed(2)} ms | `
      + `${result.speedup.toFixed(1)}x | ${result.scanEntries.toLocaleString()} |`,
    );
  }
  console.log('');
  console.log(JSON.stringify({ node: process.version, trialCount, results }, null, 2));
}

if (process.argv[2] === '--worker') {
  runWorker(
    process.argv[3],
    positiveInteger(process.argv[4], 0),
    positiveInteger(process.argv[5], DEFAULT_QUERIES),
  ).then(
    (result) => process.stdout.write(JSON.stringify(result)),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
} else {
  try {
    controller();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
