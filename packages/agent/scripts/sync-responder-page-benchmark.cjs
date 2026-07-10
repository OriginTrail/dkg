const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const DEFAULT_SIZES = [10_000, 50_000, 100_000, 250_000];
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_TRIALS = 3;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    s: `did:dkg:entity:${index.toString().padStart(8, '0')}`,
    p: 'http://schema.org/name',
    o: `"Synthetic sync responder row ${index}"`,
    g: `did:dkg:context-graph:benchmark/data/${Math.floor(index / 10_000)}`,
  }));
}

function serveOld(snapshot, offset, limit) {
  // v10.0.5 behavior: the memo hit copied the complete snapshot, then page
  // extraction copied that complete result again before slicing the page.
  const memoResult = [...snapshot];
  return [...memoResult].slice(offset, offset + limit);
}

function serveNew(snapshot, offset, limit) {
  // This PR: the memo returns its immutable reference and page extraction
  // allocates only the requested page array.
  return snapshot.slice(offset, offset + limit);
}

function runWorker(mode, rowCount, pageSize) {
  if (typeof global.gc !== 'function') {
    throw new Error('Run with --expose-gc so trials start from a comparable heap baseline');
  }
  const snapshot = makeRows(rowCount);
  const serve = mode === 'old' ? serveOld : serveNew;

  // Warm the function and array element shapes outside the measured pass.
  const warmup = serve(snapshot, 0, Math.min(pageSize, rowCount));
  if (warmup.length === 0) throw new Error('benchmark warmup returned no rows');
  global.gc();

  const baseline = process.memoryUsage();
  let peakHeapUsed = baseline.heapUsed;
  let peakRss = baseline.rss;
  let checksum = 0;
  let returnedRows = 0;
  const startedAt = performance.now();

  for (let offset = 0; offset < rowCount; offset += pageSize) {
    const page = serve(snapshot, offset, pageSize);
    returnedRows += page.length;
    checksum += page.length + page[0].s.length + page[page.length - 1].g.length;
    const usage = process.memoryUsage();
    if (usage.heapUsed > peakHeapUsed) peakHeapUsed = usage.heapUsed;
    if (usage.rss > peakRss) peakRss = usage.rss;
  }

  const durationMs = performance.now() - startedAt;
  const pages = Math.ceil(rowCount / pageSize);
  const copiedArraySlots = mode === 'old'
    ? pages * rowCount * 2 + returnedRows
    : returnedRows;

  return {
    mode,
    rowCount,
    pageSize,
    pages,
    returnedRows,
    durationMs,
    peakHeapDeltaBytes: Math.max(0, peakHeapUsed - baseline.heapUsed),
    peakRssDeltaBytes: Math.max(0, peakRss - baseline.rss),
    copiedArraySlots,
    checksum,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(2)} MiB`;
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function runIsolatedTrial(mode, rowCount, pageSize) {
  const child = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--max-old-space-size=512',
      __filename,
      '--worker',
      mode,
      String(rowCount),
      String(pageSize),
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (child.status !== 0) {
    throw new Error(
      `benchmark worker failed for mode=${mode} rows=${rowCount}\n` +
      `${child.stderr || child.stdout}`,
    );
  }
  return JSON.parse(child.stdout);
}

function summarizeTrials(trials) {
  return {
    durationMs: median(trials.map((trial) => trial.durationMs)),
    peakHeapDeltaBytes: median(trials.map((trial) => trial.peakHeapDeltaBytes)),
    peakRssDeltaBytes: median(trials.map((trial) => trial.peakRssDeltaBytes)),
    copiedArraySlots: trials[0].copiedArraySlots,
    pages: trials[0].pages,
    returnedRows: trials[0].returnedRows,
    checksum: trials[0].checksum,
  };
}

function runController() {
  const sizesArg = process.argv.find((arg) => arg.startsWith('--sizes='));
  const trialsArg = process.argv.find((arg) => arg.startsWith('--trials='));
  const pageSizeArg = process.argv.find((arg) => arg.startsWith('--page-size='));
  const sizes = sizesArg
    ? sizesArg.slice('--sizes='.length).split(',').map((value) => parsePositiveInteger(value, 0)).filter(Boolean)
    : DEFAULT_SIZES;
  const trialsPerMode = parsePositiveInteger(trialsArg?.slice('--trials='.length), DEFAULT_TRIALS);
  const pageSize = parsePositiveInteger(pageSizeArg?.slice('--page-size='.length), DEFAULT_PAGE_SIZE);
  const results = [];

  for (const rowCount of sizes) {
    const oldTrials = [];
    const newTrials = [];
    // Alternate modes so machine drift does not systematically favor one path.
    for (let trial = 0; trial < trialsPerMode; trial += 1) {
      const firstMode = trial % 2 === 0 ? 'old' : 'new';
      const secondMode = firstMode === 'old' ? 'new' : 'old';
      for (const mode of [firstMode, secondMode]) {
        const result = runIsolatedTrial(mode, rowCount, pageSize);
        (mode === 'old' ? oldTrials : newTrials).push(result);
      }
    }
    const oldSummary = summarizeTrials(oldTrials);
    const newSummary = summarizeTrials(newTrials);
    if (oldSummary.checksum !== newSummary.checksum) {
      throw new Error(`old/new checksum mismatch for ${rowCount} rows`);
    }
    results.push({
      rowCount,
      pageSize,
      trialsPerMode,
      old: oldSummary,
      new: newSummary,
      durationSpeedup: oldSummary.durationMs / newSummary.durationMs,
      copiedSlotReduction: oldSummary.copiedArraySlots / newSummary.copiedArraySlots,
    });
  }

  console.log('Sync responder cached-page allocation benchmark');
  console.log(`Node ${process.version}; page size ${pageSize}; ${trialsPerMode} isolated trial(s) per mode; 512 MiB old-space cap`);
  console.log('');
  console.log('| Snapshot rows | Pages | Old median | New median | Speedup | Old peak heap delta | New peak heap delta | Copied-slot reduction |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    console.log(
      `| ${formatInteger(result.rowCount)} | ${formatInteger(result.old.pages)} | ` +
      `${result.old.durationMs.toFixed(2)} ms | ${result.new.durationMs.toFixed(2)} ms | ` +
      `${result.durationSpeedup.toFixed(1)}x | ${formatBytes(result.old.peakHeapDeltaBytes)} | ` +
      `${formatBytes(result.new.peakHeapDeltaBytes)} | ${result.copiedSlotReduction.toFixed(1)}x |`,
    );
  }
  console.log('');
  console.log('Machine-readable results:');
  console.log(JSON.stringify({
    node: process.version,
    pageSize,
    trialsPerMode,
    oldSpaceLimitMiB: 512,
    results,
  }, null, 2));
}

if (process.argv[2] === '--worker') {
  try {
    const result = runWorker(
      process.argv[3],
      parsePositiveInteger(process.argv[4], 0),
      parsePositiveInteger(process.argv[5], DEFAULT_PAGE_SIZE),
    );
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else {
  try {
    runController();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
