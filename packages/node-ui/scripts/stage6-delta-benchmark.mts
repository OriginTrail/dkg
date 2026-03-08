import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ChatMemoryManager } from '../src/chat-memory.ts';
import { OxigraphStore } from '../../storage/src/adapters/oxigraph.ts';

type Quad = {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
};

type Triple = {
  subject: string;
  predicate: string;
  object: string;
};

type BenchStats = {
  medianMs: number;
  p95Ms: number;
  sampleCount: number;
};

type ScenarioResult = {
  label: string;
  turnCount: number;
  tripleCount: number;
  fullRefresh: BenchStats;
  deltaUpdate: BenchStats & { deltaTripleCount: number; mergedTripleCount: number };
  improvement: {
    medianMs: number;
    p95Ms: number;
    medianPct: number;
    p95Pct: number;
  };
  slo: {
    targetMedianMs: number;
    targetP95Ms: number;
    passMedian: boolean;
    passP95: boolean;
  };
};

const MEMORY_PARANET = 'agent-memory';
const DATA_GRAPH = `did:dkg:paranet:${MEMORY_PARANET}`;
const WORKSPACE_GRAPH = `${DATA_GRAPH}/_workspace`;
const CHAT_NS = 'urn:dkg:chat:';
const SCHEMA = 'http://schema.org/';
const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

const TARGET_MEDIAN_MS = 300;
const TARGET_P95_MS = 750;
const RUNS_FULL = 8;
const WARMUP_FULL = 2;
const RUNS_DELTA = 10;
const WARMUP_DELTA = 2;
const SCENARIOS = [
  { label: '5k-ish', turns: 250 },
  { label: '20k-ish', turns: 1000 },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
  return { outPath };
}

function wrapWithGraph(sparql: string, graphUri: string): string {
  const whereIdx = sparql.search(/WHERE\s*\{/i);
  if (whereIdx === -1) return sparql;
  const braceStart = sparql.indexOf('{', whereIdx);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < sparql.length; i += 1) {
    if (sparql[i] === '{') depth += 1;
    else if (sparql[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) return sparql;
  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);
  return `${before} GRAPH <${graphUri}> { ${inner} } ${after}`;
}

function stripTypedLiteral(value: string): string {
  if (!value) return value;
  const match = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  return match ? match[1] : value;
}

function dedupeQuads(quads: Quad[]): Quad[] {
  const seen = new Set<string>();
  const out: Quad[] = [];
  for (const q of quads) {
    const key = `${q.subject}\u0000${q.predicate}\u0000${q.object}\u0000${q.graph}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function dedupeBindings(bindings: Array<Record<string, string>>): Array<Record<string, string>> {
  const seen = new Set<string>();
  const out: Array<Record<string, string>> = [];
  for (const row of bindings) {
    const keys = Object.keys(row).sort();
    const key = keys.map((k) => `${k}=${row[k]}`).join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function toTriples(quads: Quad[]): Triple[] {
  return quads.map((q) => ({
    subject: q.subject,
    predicate: q.predicate,
    object: stripTypedLiteral(q.object),
  }));
}

function mergeUniqueTriples(base: Triple[], delta: Triple[]): Triple[] {
  const seen = new Set(base.map((t) => `${t.subject}\u0000${t.predicate}\u0000${t.object}`));
  const merged = [...base];
  for (const triple of delta) {
    const key = `${triple.subject}\u0000${triple.predicate}\u0000${triple.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(triple);
  }
  return merged;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1));
  return sorted[idx] ?? 0;
}

function stats(values: number[]): BenchStats {
  return {
    medianMs: quantile(values, 0.5),
    p95Ms: quantile(values, 0.95),
    sampleCount: values.length,
  };
}

function formatMs(v: number): string {
  return `${v.toFixed(2)} ms`;
}

function buildTurnQuads(sessionId: string, turnIndex: number, graph: string): Quad[] {
  const sessionUri = `${CHAT_NS}session:${sessionId}`;
  const turnId = `turn-${turnIndex}`;
  const turnUri = `${CHAT_NS}turn:${turnId}`;
  const userMsgUri = `${CHAT_NS}msg:user-${turnIndex}`;
  const assistantMsgUri = `${CHAT_NS}msg:assistant-${turnIndex}`;
  const userTs = new Date(Date.UTC(2026, 2, 8, 12, Math.floor(turnIndex / 60) % 60, turnIndex % 60)).toISOString();
  const assistantTs = new Date(Date.UTC(2026, 2, 8, 12, Math.floor(turnIndex / 60) % 60, (turnIndex % 60) + 1)).toISOString();

  return [
    { subject: userMsgUri, predicate: RDF_TYPE, object: `${SCHEMA}Message`, graph },
    { subject: userMsgUri, predicate: `${SCHEMA}isPartOf`, object: sessionUri, graph },
    { subject: userMsgUri, predicate: `${SCHEMA}author`, object: `${CHAT_NS}actor:user`, graph },
    { subject: userMsgUri, predicate: `${SCHEMA}dateCreated`, object: `"${userTs}"^^<${XSD_DATETIME}>`, graph },
    { subject: userMsgUri, predicate: `${SCHEMA}text`, object: `"user message ${turnIndex}"`, graph },

    { subject: assistantMsgUri, predicate: RDF_TYPE, object: `${SCHEMA}Message`, graph },
    { subject: assistantMsgUri, predicate: `${SCHEMA}isPartOf`, object: sessionUri, graph },
    { subject: assistantMsgUri, predicate: `${SCHEMA}author`, object: `${CHAT_NS}actor:agent`, graph },
    { subject: assistantMsgUri, predicate: `${SCHEMA}dateCreated`, object: `"${assistantTs}"^^<${XSD_DATETIME}>`, graph },
    { subject: assistantMsgUri, predicate: `${SCHEMA}text`, object: `"assistant reply ${turnIndex}"`, graph },
    { subject: assistantMsgUri, predicate: `${DKG}replyTo`, object: userMsgUri, graph },

    { subject: turnUri, predicate: RDF_TYPE, object: `${DKG}ChatTurn`, graph },
    { subject: turnUri, predicate: `${SCHEMA}isPartOf`, object: sessionUri, graph },
    { subject: turnUri, predicate: `${DKG}turnId`, object: `"${turnId}"`, graph },
    { subject: turnUri, predicate: `${SCHEMA}dateCreated`, object: `"${userTs}"^^<${XSD_DATETIME}>`, graph },
    { subject: turnUri, predicate: `${DKG}hasUserMessage`, object: userMsgUri, graph },
    { subject: turnUri, predicate: `${DKG}hasAssistantMessage`, object: assistantMsgUri, graph },
    { subject: turnUri, predicate: `${DKG}persistenceState`, object: '"stored"', graph },
    { subject: userMsgUri, predicate: `${DKG}turnId`, object: `"${turnId}"`, graph },
    { subject: assistantMsgUri, predicate: `${DKG}turnId`, object: `"${turnId}"`, graph },
  ];
}

function buildSessionQuads(sessionId: string, turnCount: number, graph: string): Quad[] {
  const sessionUri = `${CHAT_NS}session:${sessionId}`;
  const quads: Quad[] = [
    { subject: sessionUri, predicate: RDF_TYPE, object: `${SCHEMA}Conversation`, graph },
    { subject: sessionUri, predicate: `${DKG}sessionId`, object: `"${sessionId}"`, graph },
  ];
  for (let i = 1; i <= turnCount; i += 1) {
    quads.push(...buildTurnQuads(sessionId, i, graph));
  }
  return quads;
}

function sessionConstructQuery(sessionId: string, limit: number): string {
  const sessionUri = `${CHAT_NS}session:${sessionId}`;
  return `CONSTRUCT { ?s ?p ?o } WHERE {
    {
      SELECT ?s ?p ?o WHERE {
        { <${sessionUri}> ?p ?o . BIND(<${sessionUri}> AS ?s) }
        UNION
        { ?s <http://schema.org/isPartOf> <${sessionUri}> . ?s ?p ?o }
        UNION
        { ?msg <http://schema.org/isPartOf> <${sessionUri}> .
          ?msg <http://dkg.io/ontology/usedTool> ?tool .
          ?tool ?p ?o . BIND(?tool AS ?s) }
        UNION
        { ?msg <http://schema.org/isPartOf> <${sessionUri}> .
          ?entity <http://dkg.io/ontology/mentionedIn> ?msg .
          ?entity ?p ?o . BIND(?entity AS ?s) }
        UNION
        { ?memory <http://dkg.io/ontology/extractedFrom> <${sessionUri}> .
          ?memory ?p ?o . BIND(?memory AS ?s) }
      }
      ORDER BY ?s ?p ?o
      LIMIT ${limit}
    }
  }`;
}

async function executeOnGraph(store: OxigraphStore, sparql: string, graphUri: string) {
  return store.query(wrapWithGraph(sparql, graphUri));
}

async function queryIncludeWorkspace(store: OxigraphStore, sparql: string) {
  const [data, workspace] = await Promise.all([
    executeOnGraph(store, sparql, DATA_GRAPH),
    executeOnGraph(store, sparql, WORKSPACE_GRAPH),
  ]);

  if (data.type !== workspace.type) return workspace.type === 'bindings' || workspace.type === 'quads' ? workspace : data;
  if (data.type === 'quads' && workspace.type === 'quads') {
    return { type: 'quads' as const, quads: dedupeQuads([...(data.quads as Quad[]), ...(workspace.quads as Quad[])]) };
  }
  if (data.type === 'bindings' && workspace.type === 'bindings') {
    return {
      type: 'bindings' as const,
      bindings: dedupeBindings([...(data.bindings as Array<Record<string, string>>), ...(workspace.bindings as Array<Record<string, string>>)]),
    };
  }
  return data;
}

function makeManager(store: OxigraphStore): ChatMemoryManager {
  return new ChatMemoryManager(
    {
      query: async (sparql, opts) => {
        if (opts?.includeWorkspace) return queryIncludeWorkspace(store, sparql);
        if (opts?.graphSuffix === '_workspace') return executeOnGraph(store, sparql, WORKSPACE_GRAPH);
        return executeOnGraph(store, sparql, DATA_GRAPH);
      },
      writeToWorkspace: async () => ({ workspaceOperationId: 'noop' }),
      enshrineFromWorkspace: async () => ({}),
      createParanet: async () => undefined,
      listParanets: async () => [{ id: MEMORY_PARANET, name: 'Agent Memory' }],
    },
    { apiKey: '' },
  );
}

async function benchmarkFullRefresh(
  store: OxigraphStore,
  sessionId: string,
  requestedLimit: number,
): Promise<BenchStats> {
  const samples: number[] = [];
  const query = sessionConstructQuery(sessionId, requestedLimit + 1);
  for (let i = 0; i < RUNS_FULL; i += 1) {
    const start = performance.now();
    const result = await queryIncludeWorkspace(store, query);
    if (result.type !== 'quads') throw new Error('Full refresh benchmark expected quads result');
    const triples = toTriples(result.quads as Quad[]);
    const hasMore = triples.length > requestedLimit;
    const _visible = hasMore ? triples.slice(0, requestedLimit) : triples;
    const elapsed = performance.now() - start;
    if (i >= WARMUP_FULL) samples.push(elapsed);
  }
  return stats(samples);
}

async function benchmarkDeltaUpdate(
  storeWithLatest: OxigraphStore,
  baseTriples: Triple[],
  sessionId: string,
  latestTurnId: string,
  previousTurnId: string,
): Promise<BenchStats & { deltaTripleCount: number; mergedTripleCount: number }> {
  const manager = makeManager(storeWithLatest);
  const samples: number[] = [];
  let deltaTripleCount = 0;
  let mergedTripleCount = baseTriples.length;
  for (let i = 0; i < RUNS_DELTA; i += 1) {
    const start = performance.now();
    const delta = await manager.getSessionGraphDelta(sessionId, latestTurnId, { baseTurnId: previousTurnId });
    if (delta.mode !== 'delta') {
      throw new Error(`Unexpected delta mode ${delta.mode} (${delta.reason ?? 'n/a'})`);
    }
    const deltaTriples = delta.triples.map((t) => ({
      subject: t.subject,
      predicate: t.predicate,
      object: stripTypedLiteral(t.object),
    }));
    deltaTripleCount = deltaTriples.length;
    const merged = mergeUniqueTriples(baseTriples, deltaTriples);
    mergedTripleCount = merged.length;
    const elapsed = performance.now() - start;
    if (i >= WARMUP_DELTA) samples.push(elapsed);
  }
  return {
    ...stats(samples),
    deltaTripleCount,
    mergedTripleCount,
  };
}

async function runScenario(label: string, turns: number): Promise<ScenarioResult> {
  const sessionId = `stage6-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const allWorkspaceQuads = buildSessionQuads(sessionId, turns, WORKSPACE_GRAPH);
  const baseWorkspaceQuads = buildSessionQuads(sessionId, turns - 1, WORKSPACE_GRAPH);

  const fullStore = new OxigraphStore();
  await fullStore.insert(allWorkspaceQuads);

  const baseStore = new OxigraphStore();
  await baseStore.insert(baseWorkspaceQuads);

  const tripleCount = allWorkspaceQuads.length;
  const fullRefresh = await benchmarkFullRefresh(fullStore, sessionId, tripleCount);

  const baseResult = await queryIncludeWorkspace(baseStore, sessionConstructQuery(sessionId, tripleCount + 200));
  if (baseResult.type !== 'quads') throw new Error('Base snapshot expected quads result');
  const baseTriples = toTriples(baseResult.quads as Quad[]);

  const latestTurnId = `turn-${turns}`;
  const previousTurnId = `turn-${turns - 1}`;
  const deltaUpdate = await benchmarkDeltaUpdate(fullStore, baseTriples, sessionId, latestTurnId, previousTurnId);

  await baseStore.close();
  await fullStore.close();

  const improvement = {
    medianMs: fullRefresh.medianMs - deltaUpdate.medianMs,
    p95Ms: fullRefresh.p95Ms - deltaUpdate.p95Ms,
    medianPct: fullRefresh.medianMs > 0 ? ((fullRefresh.medianMs - deltaUpdate.medianMs) / fullRefresh.medianMs) * 100 : 0,
    p95Pct: fullRefresh.p95Ms > 0 ? ((fullRefresh.p95Ms - deltaUpdate.p95Ms) / fullRefresh.p95Ms) * 100 : 0,
  };

  return {
    label,
    turnCount: turns,
    tripleCount,
    fullRefresh,
    deltaUpdate,
    improvement,
    slo: {
      targetMedianMs: TARGET_MEDIAN_MS,
      targetP95Ms: TARGET_P95_MS,
      passMedian: deltaUpdate.medianMs <= TARGET_MEDIAN_MS,
      passP95: deltaUpdate.p95Ms <= TARGET_P95_MS,
    },
  };
}

async function main() {
  const { outPath } = parseArgs();
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario.label, scenario.turns));
  }

  console.log('Stage 6 benchmark: full refresh vs delta update path');
  for (const r of results) {
    console.log(`- ${r.label} (turns=${r.turnCount}, triples=${r.tripleCount})`);
    console.log(`  full:  median=${formatMs(r.fullRefresh.medianMs)} p95=${formatMs(r.fullRefresh.p95Ms)} (n=${r.fullRefresh.sampleCount})`);
    console.log(`  delta: median=${formatMs(r.deltaUpdate.medianMs)} p95=${formatMs(r.deltaUpdate.p95Ms)} (n=${r.deltaUpdate.sampleCount}, deltaTriples=${r.deltaUpdate.deltaTripleCount})`);
    console.log(`  gain:  median=${formatMs(r.improvement.medianMs)} (${r.improvement.medianPct.toFixed(1)}%), p95=${formatMs(r.improvement.p95Ms)} (${r.improvement.p95Pct.toFixed(1)}%)`);
    console.log(`  slo:   median<=${r.slo.targetMedianMs}ms ${r.slo.passMedian ? 'PASS' : 'FAIL'}, p95<=${r.slo.targetP95Ms}ms ${r.slo.passP95 ? 'PASS' : 'FAIL'}`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    runConfig: {
      runsFull: RUNS_FULL,
      warmupFull: WARMUP_FULL,
      runsDelta: RUNS_DELTA,
      warmupDelta: WARMUP_DELTA,
      targets: {
        medianMs: TARGET_MEDIAN_MS,
        p95Ms: TARGET_P95_MS,
      },
    },
    results,
  };

  console.log('');
  console.log(JSON.stringify(payload, null, 2));

  if (outPath) {
    const resolved = resolve(outPath);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, JSON.stringify(payload, null, 2), 'utf8');
    console.log('');
    console.log(`Wrote benchmark report: ${resolved}`);
  }
}

await main();
