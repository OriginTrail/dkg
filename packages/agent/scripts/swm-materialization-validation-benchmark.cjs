const { performance } = require('node:perf_hooks');

const DEFAULT_GRAPH_COUNT = 20;
const DEFAULT_QUADS_PER_GRAPH = 50_000;
const DEFAULT_PASSES = 4;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function argumentValue(name) {
  return process.argv.find((argument) => argument.startsWith(name + '='))?.slice(name.length + 1);
}

function makeGraphs(graphCount, quadsPerGraph) {
  return new Map(Array.from({ length: graphCount }, (_, graphIndex) => {
    const graph = 'did:dkg:context-graph:materialization-benchmark/ka/' + graphIndex;
    const quads = Array.from({ length: quadsPerGraph }, (_, quadIndex) => ({
      subject: 'urn:materialization-benchmark:' + graphIndex + ':' + quadIndex,
      predicate: 'http://schema.org/status',
      object: '"stable"',
      graph,
    }));
    return [graph, quads];
  }));
}

function createInstrumentedStore(graphs, revisionAware) {
  const metrics = { countQueries: 0, constructQueries: 0, returnedQuads: 0 };
  const store = {
    async query(sparql) {
      const graph = /GRAPH <([^>]+)>/.exec(sparql)?.[1];
      const quads = graph ? graphs.get(graph) ?? [] : [];
      if (sparql.includes('SELECT (COUNT(*) AS ?n)')) {
        metrics.countQueries += 1;
        return { type: 'bindings', bindings: [{ n: String(quads.length) }] };
      }
      if (sparql.trimStart().startsWith('CONSTRUCT')) {
        metrics.constructQueries += 1;
        metrics.returnedQuads += quads.length;
        return { type: 'quads', quads };
      }
      throw new Error('benchmark received an unexpected query: ' + sparql);
    },
  };
  if (revisionAware) {
    store.writeRevisionCoverage = 'all-writers';
    store.getWriteRevision = () => ({ generation: 0, stable: true });
  }
  return { store, metrics };
}

async function runScenario(createMaterializer, graphs, descriptors, passes, revisionAware) {
  const { store, metrics } = createInstrumentedStore(graphs, revisionAware);
  const materializer = createMaterializer({
    store,
    writeLocks: new Map(),
    invalidateListContextGraphsCache: () => {},
  });
  if (typeof global.gc === 'function') global.gc();
  const cpuStarted = process.cpuUsage();
  const startedAt = performance.now();
  const answers = [];
  for (let pass = 0; pass < passes; pass += 1) {
    for (const descriptor of descriptors) {
      answers.push(await materializer.isGraphAssetMaterialized(descriptor));
    }
  }
  return {
    wallMs: performance.now() - startedAt,
    cpuMs: Object.values(process.cpuUsage(cpuStarted)).reduce((sum, value) => sum + value, 0) / 1_000,
    answers,
    ...metrics,
  };
}

async function main() {
  const graphCount = positiveInteger(argumentValue('--graphs'), DEFAULT_GRAPH_COUNT);
  const quadsPerGraph = positiveInteger(argumentValue('--quads'), DEFAULT_QUADS_PER_GRAPH);
  const passes = positiveInteger(argumentValue('--passes'), DEFAULT_PASSES);
  const [{ createSharedMemorySnapshotMaterializer }, { workspacePublicQuadsDigest }] = await Promise.all([
    import('../dist/sync/requester/swm-snapshot-materializer.js'),
    import('@origintrail-official/dkg-publisher'),
  ]);
  const graphs = makeGraphs(graphCount, quadsPerGraph);
  const descriptors = [...graphs].map(([assertionGraph, quads]) => ({
    assertionGraph,
    publicQuadsCount: quads.length,
    publicQuadsDigest: workspacePublicQuadsDigest(quads),
  }));
  const baseline = await runScenario(
    createSharedMemorySnapshotMaterializer,
    graphs,
    descriptors,
    passes,
    false,
  );
  const memoized = await runScenario(
    createSharedMemorySnapshotMaterializer,
    graphs,
    descriptors,
    passes,
    true,
  );
  if (!baseline.answers.every(Boolean) || !memoized.answers.every(Boolean)) {
    throw new Error('materialization answers were not all true');
  }
  if (JSON.stringify(baseline.answers) !== JSON.stringify(memoized.answers)) {
    throw new Error('memoized answers differ from exact validation');
  }
  const constructReduction = 1 - (memoized.constructQueries / baseline.constructQueries);
  const countReduction = 1 - (memoized.countQueries / baseline.countQueries);
  if (constructReduction < 0.7 || countReduction < 0.7) {
    throw new Error('full-query reduction did not reach 70%');
  }
  console.log(JSON.stringify({
    dataset: {
      graphs: graphCount,
      quadsPerGraph,
      storedQuads: graphCount * quadsPerGraph,
      passes,
    },
    baseline: { ...baseline, answers: undefined },
    memoized: { ...memoized, answers: undefined },
    constructReductionPercent: constructReduction * 100,
    countReductionPercent: countReduction * 100,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
