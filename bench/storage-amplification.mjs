import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '../packages/storage/dist/adapters/oxigraph.js';

const DEFAULT_SIZES = [100, 1_000, 5_000];
const MAX_SIZE = 100_000;
const SETTLE_MS = Number(process.env.DKG_BENCH_AMPLIFICATION_SETTLE_MS ?? 100);
const STAGES = [
  { name: 'wm', triplesPerAsset: 1 },
  { name: 'swm', triplesPerAsset: 1 },
  { name: 'context-projection', triplesPerAsset: 2 },
  { name: 'vm', triplesPerAsset: 3 },
  { name: 'lifecycle', triplesPerAsset: 2 },
];

function parseSizes() {
  const raw = process.env.DKG_BENCH_AMPLIFICATION_SIZES?.trim();
  const values = raw ? raw.split(',').map((value) => Number(value.trim())) : DEFAULT_SIZES;
  if (
    values.length === 0
    || values.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > MAX_SIZE)
  ) {
    throw new Error(`DKG_BENCH_AMPLIFICATION_SIZES must contain positive integers <= ${MAX_SIZE}`);
  }
  return [...new Set(values)];
}

if (!Number.isSafeInteger(SETTLE_MS) || SETTLE_MS < 0 || SETTLE_MS > 60_000) {
  throw new Error('DKG_BENCH_AMPLIFICATION_SETTLE_MS must be an integer from 0 to 60000');
}

function uri(value) {
  return `urn:dkg:storage-amplification:${value}`;
}

function quadText({ subject, predicate, object, graph }) {
  return `<${subject}> <${predicate}> ${object} <${graph}> .\n`;
}

function makeStageQuads(stage, cardinality, retainedAssets) {
  const graph = uri(`graph/${stage.name}`);
  const quads = [];
  for (let asset = 0; asset < retainedAssets; asset += 1) {
    const subject = uri(`asset/${stage.name}/${asset}`);
    for (let slot = 0; slot < stage.triplesPerAsset; slot += 1) {
      const suffix = cardinality === 'repeated-vocabulary' ? String(slot) : `${asset}/${slot}`;
      quads.push({
        subject,
        predicate: uri(`predicate/${suffix}`),
        object: `"value-${suffix}"`,
        graph,
      });
    }
  }
  return quads;
}

async function fileBytes(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function directoryBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else total += await fileBytes(entryPath);
  }
  return total;
}

async function assertSettledDirectory(path, persistPath) {
  const entries = await readdir(path);
  const unexpected = entries.filter((entry) => entry !== 'store.nq');
  if (unexpected.length > 0 || !entries.includes('store.nq')) {
    throw new Error(`reconciliation or temporary files remained after flush: ${entries.join(', ')}`);
  }
  const bytes = await fileBytes(persistPath);
  if (bytes === 0) throw new Error('persisted store is empty after a non-empty benchmark stage');
}

async function runScenario(size, cardinality) {
  const workDir = await mkdtemp(join(tmpdir(), 'dkg-storage-amplification-'));
  const persistPath = join(workDir, 'store.nq');
  const store = new OxigraphStore(persistPath);
  const allQuads = [];
  const measurements = [];
  let previousDirectoryBytes = await directoryBytes(workDir);
  let cumulativeFlushBytes = 0;
  let peakDirectoryBytes = previousDirectoryBytes;

  try {
    for (const stage of STAGES) {
      const quads = makeStageQuads(stage, cardinality, size);
      allQuads.push(...quads);
      await store.insert(quads);
      await store.flush();

      const currentFileBytes = await fileBytes(persistPath);
      const currentDirectoryBytes = await directoryBytes(workDir);
      // OxigraphStore writes a complete sibling snapshot before its atomic
      // rename. During that overlap the old and new snapshots coexist.
      const transientPeakBytes = previousDirectoryBytes + currentFileBytes;
      peakDirectoryBytes = Math.max(peakDirectoryBytes, transientPeakBytes, currentDirectoryBytes);
      previousDirectoryBytes = currentDirectoryBytes;
      cumulativeFlushBytes += currentFileBytes;

      const terms = new Set();
      let logicalBytes = 0;
      for (const quad of allQuads) {
        terms.add(quad.subject);
        terms.add(quad.predicate);
        terms.add(quad.object);
        terms.add(quad.graph);
        logicalBytes += Buffer.byteLength(quadText(quad));
      }
      const logicalTriples = allQuads.length;
      if (await store.countQuads() !== logicalTriples) {
        throw new Error(`${cardinality}/${size}/${stage.name}: logical triple count drifted`);
      }

      measurements.push({
        stage: stage.name,
        retainedAssets: size,
        logicalTriples,
        uniqueTerms: terms.size,
        physicalBytes: currentFileBytes,
        transientPeakBytes,
        cumulativeFlushBytes,
        writeAmplification: Number((cumulativeFlushBytes / logicalBytes).toFixed(4)),
        bytesPerRetainedAsset: Number((currentFileBytes / size).toFixed(2)),
      });
    }

    await store.close();
    await assertSettledDirectory(workDir, persistPath);
    const reopened = new OxigraphStore(persistPath);
    const reopenedTripleCount = await reopened.countQuads();
    if (reopenedTripleCount !== allQuads.length) {
      throw new Error(`${cardinality}/${size}: restart lost triples (${reopenedTripleCount}/${allQuads.length})`);
    }
    await reopened.flush();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const steadyStateBytes = await fileBytes(persistPath);
    await reopened.close();
    await assertSettledDirectory(workDir, persistPath);

    for (const measurement of measurements) {
      measurement.steadyStateBytes = steadyStateBytes;
      measurement.reopenedTripleCount = reopenedTripleCount;
      measurement.reconciliation = 'disabled';
    }
    return {
      size,
      cardinality,
      measurements,
      peakDirectoryBytes,
      compactionRecovery: {
        verified: true,
        mode: 'close-reopen-canonical-snapshot',
        steadyStateBytes,
        reopenedTripleCount,
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function buildGuidance(results) {
  const values = results.flatMap((result) => result.measurements.map((measurement) => measurement.bytesPerRetainedAsset));
  return {
    basis: 'Observed local Oxigraph persisted snapshots; reconciliation disabled',
    bytesPerRetainedAsset: {
      minimumObserved: Math.min(...values),
      maximumObserved: Math.max(...values),
      scenarios: results.length,
    },
    use: 'Size capacity from the observed range for the matching vocabulary/cardinality mix, then add operational headroom for concurrent snapshots and backups.',
  };
}

const results = [];
for (const size of parseSizes()) {
  for (const cardinality of ['repeated-vocabulary', 'unique-predicates-and-literals']) {
    results.push(await runScenario(size, cardinality));
  }
}

console.log(JSON.stringify({
  benchmark: 'storage-amplification',
  generatedAt: new Date().toISOString(),
  node: process.version,
  store: 'OxigraphStore persisted N-Quads',
  settlePeriodMs: SETTLE_MS,
  reconciliation: { mode: 'disabled', asserted: true },
  stages: STAGES,
  results,
  capacityGuidance: buildGuidance(results),
}, null, 2));
